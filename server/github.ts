import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { InboxWorkspace, PullRequestClaim, Verification } from "./inbox-types.ts";
import { prEvidencePrefix } from "./reporting.ts";

const exec = promisify(execFile);
const slug = "[a-z0-9][a-z0-9-]{0,38}/[a-z0-9_.-]{1,100}";
const originPattern = new RegExp(`^(?:https://github\\.com/|git@github\\.com:|ssh://git@github\\.com/)(${slug})/?$`, "i");
const prPattern = new RegExp(`^https://github\\.com/(${slug})/pull/([1-9]\\d{0,9})$`, "i");

export function githubOrigin(remote: string) {
  return originPattern.exec(remote.trim().replace(/\.git\/?$/i, ""))?.[1].toLowerCase() ?? null;
}

export async function readOrigin(workspace: InboxWorkspace) {
  try {
    const { stdout } = await exec("git", ["-C", workspace.directory, "remote", "get-url", "origin"], {
      timeout: 5_000,
      maxBuffer: 8192,
    });
    return githubOrigin(stdout);
  } catch (error) {
    // A failed Git query may mean the directory is not a checkout or has no origin.
    if (error instanceof Error && "code" in error && typeof error.code === "number") return null;
    throw error;
  }
}

const pullRequestSchema = z.object({
  number: z.number().int().positive(),
  url: z.string(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  isDraft: z.boolean(),
  headRefOid: z.string().regex(/^[a-f\d]{40}$/i),
  body: z.string(),
  commits: z.array(z.object({ oid: z.string() })),
});

export type PullRequestRecord = z.output<typeof pullRequestSchema>;
type ReadPullRequest = (repository: string, number: string) => Promise<unknown>;
type VerifyInput = PullRequestClaim & { workspace: InboxWorkspace; repository: string };

export function pullRequestNumber(repository: string, url: string) {
  const match = prPattern.exec(url);
  return match?.[1].toLowerCase() === repository ? match[2] : null;
}

export function pullRequestState(record: PullRequestRecord) {
  if (record.state === "MERGED") return "merged";
  if (record.state === "CLOSED") return "closed";
  return record.isDraft ? "draft" : "open";
}

export function fixCommit(record: PullRequestRecord, batchId: string, itemId: string) {
  const marker = `${prEvidencePrefix} ${batchId} ${itemId}`;
  const evidence = record.body.split(/\r?\n/).filter((line) => line === marker || line.startsWith(`${marker} `));
  const revision = evidence[0]?.slice(marker.length + 1);
  return evidence.length === 1 && revision && /^[a-f\d]{40}$/.test(revision) &&
    record.commits.some(({ oid }) => oid.toLowerCase() === revision) ? revision : null;
}

export function checkPullRequest(record: PullRequestRecord, claim: PullRequestClaim): Verification {
  const state = pullRequestState(record);
  if (state !== "open" && state !== "merged") {
    return { status: "rejected", detail: "The reported pull request needs to be ready for review or merged." };
  }
  if (record.headRefOid.toLowerCase() !== claim.revision) {
    return { status: "rejected", detail: "The pull request head differs from the reported revision." };
  }
  const fixRevision = fixCommit(record, claim.batchId, claim.itemId);
  if (!fixRevision) {
    return { status: "rejected", detail: "The pull request has no valid commit evidence for this bug." };
  }
  return { status: "verified", url: record.url, revision: claim.revision, fixRevision };
}

export function createPullRequestReader(read: ReadPullRequest) {
  return async (repository: string, url: string) => {
    const number = pullRequestNumber(repository, url);
    if (!number) return null;
    const record = pullRequestSchema.parse(await read(repository, number));
    return pullRequestNumber(repository, record.url) === number && record.number === Number(number) ? record : null;
  };
}

export function createPullRequestVerifier(
  origin: (workspace: InboxWorkspace) => Promise<string | null>,
  readPullRequest: ReadPullRequest,
) {
  const read = createPullRequestReader(readPullRequest);
  return async ({ workspace, repository, ...claim }: VerifyInput): Promise<Verification> => {
    if (!pullRequestNumber(repository, claim.url)) {
      return { status: "rejected", detail: "The reported pull request is outside this workspace’s GitHub origin." };
    }
    if (!/^[a-f\d]{40}$/.test(claim.revision)) {
      return { status: "rejected", detail: "The reported revision is missing a full commit SHA." };
    }
    try {
      if (await origin(workspace) !== repository) {
        return { status: "rejected", detail: "The workspace GitHub origin changed before verification." };
      }
      const record = await read(repository, claim.url);
      if (!record) {
        return { status: "rejected", detail: "GitHub returned a pull request outside the reported repository or number." };
      }
      return checkPullRequest(record, claim);
    } catch {
      return { status: "retry", detail: "GitHub pull request verification is unavailable. Check access on the Paseo host." };
    }
  };
}

async function githubJson(args: string[]): Promise<unknown> {
  const { stdout } = await exec("gh", args, {
    timeout: 10_000, maxBuffer: 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: "1" },
  });
  return JSON.parse(stdout);
}

const pending = new Map<string, Promise<unknown>>();
function readPullRequest(repository: string, number: string) {
  const key = `${repository}/${number}`;
  const existing = pending.get(key);
  if (existing) return existing;
  const request = githubJson([
    "pr", "view", number, "--repo", `github.com/${repository}`,
    "--json", "number,url,state,isDraft,headRefOid,body,commits",
  ]).finally(() => pending.delete(key));
  pending.set(key, request);
  return request;
}

export const githubPullRequests = {
  read: createPullRequestReader(readPullRequest),
  async search(repository: string, batchId: string) {
    if (!z.uuid().safeParse(batchId).success) return [];
    const result = await githubJson([
      "search", "prs", `"${batchId}"`, "--repo", repository, "--match", "body",
      "--limit", "100", "--json", "url",
    ]);
    return z.array(z.object({ url: z.string() })).parse(result).map(({ url }) => url);
  },
};

export const verifyPullRequest = createPullRequestVerifier(readOrigin, readPullRequest);
