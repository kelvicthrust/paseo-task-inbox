import type { DatabaseSync } from "node:sqlite";
import { checkPullRequest, fixCommit, pullRequestNumber, pullRequestState } from "./github.ts";
import type { PullRequestRecord } from "./github.ts";
import type { InboxHost, Verification } from "./inbox-types.ts";
import { editState, itemDispatch, pullRequestWorkspaces, readState } from "./storage.ts";
import type { Item, WorkspaceState } from "./storage.ts";

const interval = 30_000;
const maxSearchDelay = 30 * 60_000;
const statePriority = { merged: 0, open: 1, draft: 2, closed: 3 };

export function completeItem(item: Item, result: Extract<Verification, { status: "verified" }>, detail: string) {
  item.status = "completed";
  item.prUrl = result.url;
  item.revision = result.revision;
  item.fixRevision = result.fixRevision;
  item.detail = `Verified PR head ${result.revision} and fix commit ${result.fixRevision}. ${detail}`;
  if (item.pullRequest?.url.toLowerCase() !== result.url.toLowerCase()) delete item.pullRequest;
  delete item.reportedFix;
}

function hasFix(record: PullRequestRecord, item: Item, batchId: string | undefined) {
  if (batchId) return Boolean(fixCommit(record, batchId, item.id));
  // Older completed items can have a verified PR but no surviving batch ID.
  return item.status === "completed" && (item.fixRevision === undefined ||
    record.commits.some(({ oid }) => oid.toLowerCase() === item.fixRevision));
}

export function createPullRequestSync(
  host: InboxHost, database: DatabaseSync, now: () => number, onCompletion: (state: WorkspaceState) => void,
) {
  let nextSync = 0;
  const searches = new Map<string, { retryAt: number; delay: number }>();

  return async function sync() {
    if (!host.pullRequests || now() < nextSync) return;
    const github = host.pullRequests;
    nextSync = now() + interval;
    const reads = new Map<string, Promise<PullRequestRecord | null>>();
    const discovered = new Map<string, PullRequestRecord[]>();
    const searchKeys = new Set<string>();

    async function read(repository: string, url: string) {
      const number = pullRequestNumber(repository, url);
      if (!number) return;
      const key = `${repository}/${number}`;
      const existing = reads.get(key);
      if (existing) return existing;
      const request = github.read(repository, url).catch(() => null);
      reads.set(key, request);
      return request;
    }

    async function discover(repository: string, batchId: string) {
      const key = `${repository}/${batchId}`;
      searchKeys.add(key);
      const cached = discovered.get(key);
      if (cached) return cached;
      const scheduled = searches.get(key);
      if (scheduled && now() < scheduled.retryAt) return [];
      const delay = Math.min((scheduled?.delay ?? interval / 2) * 2, maxSearchDelay);
      searches.set(key, { retryAt: now() + delay, delay });
      const urls = await github.search(repository, batchId).catch(() => []);
      const records: PullRequestRecord[] = [];
      for (let offset = 0; offset < urls.length; offset += 4) {
        const page = await Promise.all(urls.slice(offset, offset + 4).map((url) => read(repository, url)));
        for (const record of page) if (record) records.push(record);
      }
      records.sort((a, b) =>
        statePriority[pullRequestState(a)] - statePriority[pullRequestState(b)] || a.number - b.number);
      discovered.set(key, records);
      return records;
    }

    for (const workspaceId of pullRequestWorkspaces(database)) {
      const workspace = await host.workspace(workspaceId).catch(() => null);
      if (workspace?.id !== workspaceId) continue;
      const repository = await host.repository(workspace).catch(() => null);
      if (!repository) continue;
      const { batch, items } = readState(database, workspaceId);
      const updates = new Map<string, PullRequestRecord | null>();
      for (const item of items) {
        if (item.status === "inbox" || item.status === "queued") continue;
        const dispatch = itemDispatch(item, batch);
        if (dispatch && dispatch.repository !== repository) continue;
        const tracked = item.pullRequest;
        const canVerify = item.reportedFix && tracked && item.reportedFix.revision === tracked.head &&
          item.reportedFix.url.toLowerCase() === tracked.url.toLowerCase();
        if (tracked?.state === "merged" && !canVerify) continue;
        const knownUrl = item.prUrl ?? item.pullRequest?.url ?? item.candidate?.url ?? item.reportedFix?.url;
        const known = knownUrl ? await read(repository, knownUrl) : undefined;
        if (known && hasFix(known, item, dispatch?.batchId)) {
          const state = pullRequestState(known);
          const trackingChanged = tracked?.head !== known.headRefOid.toLowerCase() ||
            tracked.state !== state || tracked.url !== known.url;
          const readyForCheck = canVerify && (state === "open" || state === "merged");
          if (trackingChanged || readyForCheck || (!item.dispatch && dispatch)) updates.set(item.id, known);
          continue;
        }
        if (!known && item.pullRequest) continue;
        if (known && item.pullRequest) updates.set(item.id, null);
        if (!dispatch) continue;
        const records = await discover(repository, dispatch.batchId);
        const matching = records.find((record) => hasFix(record, item, dispatch.batchId));
        if (matching) updates.set(item.id, matching);
      }
      if (updates.size === 0) continue;
      editState(database, workspaceId, (state) => {
        let completed = false;
        for (const item of state.items) {
          const record = updates.get(item.id);
          if (record === undefined) continue;
          if (!record) {
            delete item.pullRequest;
            continue;
          }
          if (item.prUrl && pullRequestNumber(repository, item.prUrl) !== String(record.number)) continue;
          item.dispatch ??= itemDispatch(item, state.batch);
          item.pullRequest = {
            url: record.url, state: pullRequestState(record), head: record.headRefOid.toLowerCase(),
          };
          const report = item.reportedFix;
          if (item.status !== "blocked" || !report || pullRequestNumber(repository, report.url) !== String(record.number)) continue;
          const verified = checkPullRequest(record, report);
          if (verified.status === "verified") {
            completeItem(item, verified, report.detail);
            completed = true;
          }
        }
        if (completed) onCompletion(state);
      });
    }
    for (const key of searches.keys()) {
      if (!searchKeys.has(key)) searches.delete(key);
    }
  };
}
