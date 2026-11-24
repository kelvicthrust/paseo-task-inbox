import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { BatchOutcome } from "../shared/outcome.ts";
import type { ImageType, InboxAgent, InboxHost, InboxWorkspace, TimelineCursor, TimelinePage } from "./inbox-types.ts";
import { createPaseoHost } from "./paseo.ts";
import { flushAssistant, formatPrompt, readTimeline } from "./reporting.ts";
import { activeWorkspaces, editState, imageSize, insertImage, openStorage, readImages, readState } from "./storage.ts";
import type { Annotation, Batch, Item, WorkspaceState } from "./storage.ts";

export type { InboxAgent, InboxHost, TimelineEntry } from "./inbox-types.ts";

const maxItems = 20;
const maxImageBytes = 8 * 1024 * 1024;
const maxBatchImageBytes = 24 * 1024 * 1024;
const retryDelay = 15_000;
const reconcileGrace = 60_000;
const idleGrace = 5_000;

export async function hasUnfinishedBatches(dataDir: string): Promise<boolean> {
  try {
    await lstat(join(dataDir, "inbox.sqlite3"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
  const database = await openStorage(dataDir);
  try {
    return activeWorkspaces(database).length > 0;
  } finally {
    database.close();
  }
}

type Paseo = PluginHandlerContext["paseo"];

export function createInbox(paseo: Paseo, dataDir: string, getPluginApi: () => Paseo | undefined = () => paseo) {
  return createInboxService(createPaseoHost(paseo, getPluginApi), dataDir);
}

export type InboxService = Awaited<ReturnType<typeof createInboxService>>;

function summarize(state: WorkspaceState) {
  const open = state.items.filter(({ status }) => status !== "completed");
  const count = open.length;
  if (count === 0) {
    return state.batch?.status === "completed"
      ? { count: state.batch.itemIds.length, status: "completed" as const }
      : { count, status: null };
  }
  if (open.some(({ status }) => status === "blocked")) return { count, status: "blocked" as const };
  const status = state.batch?.status;
  if (status && status !== "completed") return { count, status };
  return { count, status: "inbox" as const };
}

function selectedItems(state: WorkspaceState, batch: Batch) {
  return state.items.filter(({ id }) => batch.itemIds.includes(id));
}

function finish(state: WorkspaceState, batch: Batch, blocker?: string) {
  const items = selectedItems(state, batch);
  if (blocker) {
    for (const item of items) {
      if (item.status === "working" || item.status === "queued") {
        item.status = "blocked";
        item.detail = blocker;
        delete item.candidate;
      }
    }
  }
  if (items.some(({ status }) => status === "working" || status === "queued")) return;
  const completed = items.filter(({ status }) => status === "completed").length;
  const blocked = items.length - completed;
  batch.phase = "finished";
  batch.status = blocked ? "blocked" : "completed";
  batch.detail = blocked === items.length && blocker ? blocker : `${completed} completed, ${blocked} blocked.`;
  const outcome: BatchOutcome = {
    batchId: batch.id,
    items: items.map(({ number, detail, prUrl }) => {
      const fields = { number, detail: detail.length > 500 ? `${detail.slice(0, 499)}…` : detail };
      return prUrl ? { ...fields, status: "completed", prUrl } : { ...fields, status: "blocked" };
    }),
  };
  state.annotations.push({ agentId: batch.agentId, directory: batch.directory, outcome, attempt: null });
}

function waitingFor(agent: InboxAgent): string | null {
  if (agent.pendingPermission) return "Waiting for input or approval in the selected chat.";
  if (agent.status === "error") return "The selected chat needs attention before dispatch.";
  if (agent.status !== "idle" || agent.activeTurn !== null) return "Waiting for the selected chat to become idle.";
  return null;
}

function validImage(mimeType: ImageType, bytes: Buffer) {
  if (mimeType === "image/png") {
    return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  }
  if (mimeType === "image/jpeg") {
    return bytes.length >= 5 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 &&
      bytes.at(-2) === 255 && bytes.at(-1) === 217;
  }
  return false;
}

export async function createInboxService(host: InboxHost, dataDir: string, now = Date.now) {
  const database = await openStorage(dataDir);
  let ticking: Promise<void> | null = null;
  let closing: Promise<void> | null = null;
  const getState = (workspaceId: string) => readState(database, workspaceId);

  async function getWorkspace(id: string) {
    const workspace = await host.workspace(id);
    if (!workspace || workspace.id !== id) throw new Error("This workspace is unavailable.");
    return workspace;
  }

  function changeBatch<T>(workspaceId: string, batchId: string, change: (state: WorkspaceState, batch: Batch) => T) {
    return editState(database, workspaceId, (state) => {
      if (state.batch?.id === batchId && state.batch.phase !== "finished") return change(state, state.batch);
    });
  }

  function waitForChat(workspaceId: string, batch: Batch, agent: InboxAgent, detail: string) {
    changeBatch(workspaceId, batch.id, (_state, current) => {
      current.status = agent.pendingPermission || agent.status === "error" ? "blocked" : "queued";
      current.detail = detail;
    });
  }

  async function verifyItems(workspace: InboxWorkspace, batchId: string) {
    const state = getState(workspace.id);
    const batch = state.batch;
    if (!batch || batch.id !== batchId) return;
    for (const item of selectedItems(state, batch)) {
      const candidate = item.candidate;
      if (!candidate || candidate.retryAt > now()) continue;
      let result;
      try {
        result = await host.verify({
          workspace, repository: batch.repository, url: candidate.url, revision: candidate.revision,
          batchId: candidate.batchId, itemId: candidate.itemId,
        });
      } catch {
        result = { status: "retry", detail: "Pull request verification is temporarily unavailable." } as const;
      }
      changeBatch(workspace.id, batchId, (latest, current) => {
        const target = latest.items.find(({ id }) => id === item.id);
        if (!target || !target.candidate) return;
        const attempts = target.candidate.attempts + 1;
        if (result.status === "retry" && attempts < 3) {
          target.candidate.attempts = attempts;
          target.candidate.retryAt = now() + retryDelay;
          target.detail = result.detail;
          return;
        }
        delete target.candidate;
        if (result.status === "verified") {
          target.status = "completed";
          target.prUrl = result.url;
          target.revision = result.revision;
          target.fixRevision = result.fixRevision;
          target.detail = `Verified PR head ${result.revision} and fix commit ${result.fixRevision}. ${candidate.detail}`;
        } else {
          target.status = "blocked";
          target.detail = result.detail;
        }
        finish(latest, current);
      });
    }
  }

  async function followTimeline(workspaceId: string, batch: Batch) {
    let latestPage: TimelinePage | null = null;
    let cursor = batch.cursor;
    for (let pages = 0; pages < 5; pages += 1) {
      const page: TimelinePage = await host.timeline(batch.agentId, cursor);
      latestPage = page;
      if (page.reset || !cursor || page.epoch !== cursor.epoch) {
        cursor = { epoch: page.epoch, seq: Math.max(0, page.firstSeq - 1) };
        const resetCursor = cursor;
        changeBatch(workspaceId, batch.id, (_state, current) => {
          current.cursor = resetCursor;
          current.turnId = null;
          current.assistant = null;
          current.interrupted = false;
          current.idleSince = null;
        });
        continue;
      }
      const last = page.entries.at(-1);
      if (last) cursor = { epoch: page.epoch, seq: last.seq };
      const nextCursor = cursor;
      changeBatch(workspaceId, batch.id, (state, current) => {
        readTimeline(current, state.items, page.entries);
        current.cursor = nextCursor;
      });
      if (!page.hasNewer) return true;
    }
    return latestPage !== null && !latestPage.reset && !latestPage.hasNewer;
  }

  async function dispatch(workspace: InboxWorkspace, batch: Batch, agent: InboxAgent) {
    const detail = waitingFor(agent);
    if (detail) {
      waitForChat(workspace.id, batch, agent, detail);
      return;
    }
    if (batch.attempts > 0 && now() < batch.attemptedAt + retryDelay) return;
    if (batch.attempts >= 3) {
      if (now() >= batch.attemptedAt + reconcileGrace) {
        changeBatch(workspace.id, batch.id, (state, current) => {
          finish(state, current, "Paseo could not confirm delivery. Check the selected chat before starting new work.");
        });
      }
      return;
    }
    if (await host.repository(workspace) !== batch.repository) {
      changeBatch(workspace.id, batch.id, (state, current) => {
        finish(state, current, "The workspace GitHub origin changed before dispatch.");
      });
      return;
    }
    const images = batch.itemIds.flatMap((id) => readImages(database, workspace.id, id));
    const anchor = batch.cursor ?? await host.timeline(batch.agentId, null).then((page) => ({
      epoch: page.epoch, seq: page.latestSeq,
    }));
    const ready = await host.agent(batch.agentId);
    if (!ready || ready.id !== batch.agentId || ready.workspaceId !== workspace.id || ready.status === "closed") {
      changeBatch(workspace.id, batch.id, (state, current) => {
        finish(state, current, "The selected chat is unavailable in this workspace.");
      });
      return;
    }
    const freshDetail = waitingFor(ready);
    if (freshDetail) {
      waitForChat(workspace.id, batch, ready, freshDetail);
      return;
    }
    const claimed = changeBatch(workspace.id, batch.id, (_state, current) => {
      if (current.phase === "sent" || current.attempts !== batch.attempts) return false;
      current.phase = "delivering";
      current.cursor = anchor;
      current.attempts += 1;
      current.attemptedAt = now();
      current.status = "queued";
      current.detail = "Waiting for Paseo to confirm delivery.";
      return true;
    });
    if (!claimed) return;
    try {
      await host.send(batch.agentId, { messageId: batch.messageId, text: batch.text, images });
    } catch {
      changeBatch(workspace.id, batch.id, (_state, current) => {
        current.status = "blocked";
        current.detail = "Delivery is unconfirmed. Checking the selected chat for the batch.";
      });
      return;
    }
    changeBatch(workspace.id, batch.id, (state, current) => {
      current.phase = "sent";
      current.status = "working";
      current.detail = "The batch was sent to the selected chat.";
      for (const item of selectedItems(state, current)) {
        if (item.status === "queued") {
          item.status = "working";
          item.detail = current.detail;
        }
      }
    });
  }

  async function advance(workspaceId: string, initial: Batch) {
    const workspace = await host.workspace(workspaceId);
    const agent = await host.agent(initial.agentId);
    if (!workspace || workspace.id !== workspaceId || workspace.directory !== initial.directory ||
        !agent || agent.id !== initial.agentId || agent.workspaceId !== workspaceId || agent.status === "closed") {
      changeBatch(workspaceId, initial.id, (state, batch) => {
        finish(state, batch, "The selected chat is unavailable in this workspace.");
      });
      return;
    }
    const caughtUp = initial.phase === "queued" || await followTimeline(workspaceId, initial);
    const batch = getState(workspaceId).batch;
    if (!batch || batch.id !== initial.id || batch.phase === "finished") return;
    if (batch.phase === "queued" || batch.phase === "delivering") {
      if (caughtUp) await dispatch(workspace, batch, agent);
      return;
    }

    if (caughtUp) {
      // Read again after the timeline so an old idle snapshot cannot close a live turn.
      const currentAgent = await host.agent(batch.agentId);
      if (!currentAgent || currentAgent.id !== batch.agentId || currentAgent.workspaceId !== workspaceId) return;
      changeBatch(workspaceId, batch.id, (state, current) => {
        if (currentAgent.pendingPermission && !current.interrupted) {
          current.status = "blocked";
          current.detail = "Waiting for input or approval in the selected chat.";
          current.idleSince = null;
          return;
        }
        if (current.status === "blocked") {
          current.status = "working";
          current.detail = "Work is underway in the selected chat.";
        }
        const turnEnded = current.interrupted || currentAgent.activeTurn !== current.turnId ||
          currentAgent.status === "idle" || currentAgent.status === "error";
        if (current.turnId && turnEnded) {
          flushAssistant(current, state.items);
          current.idleSince ??= now();
        } else {
          current.idleSince = null;
        }
      });
    }

    await verifyItems(workspace, batch.id);
    if (!caughtUp) return;

    changeBatch(workspaceId, batch.id, (state, current) => {
      const items = selectedItems(state, current);
      if (!current.turnId && now() >= current.attemptedAt + reconcileGrace) {
        finish(state, current, "The sent batch could not be matched to a turn in the selected chat.");
      } else if (current.idleSince !== null && now() >= current.idleSince + idleGrace) {
        for (const item of items) {
          if (item.status === "working" && !item.candidate) {
            item.status = "blocked";
            item.detail = current.interrupted
              ? "Another message interrupted batch reporting in the selected chat."
              : "The selected chat finished without a result for this bug.";
          }
        }
        finish(state, current);
      } else {
        finish(state, current);
      }
    });
  }

  function resolveAnnotation(workspaceId: string, batchId: string, missing = false) {
    editState(database, workspaceId, (state) => {
      state.annotations = state.annotations.filter(({ outcome }) => outcome.batchId !== batchId);
      if (missing && state.batch?.id === batchId) {
        state.batch.detail += " The chat summary could not be confirmed. The outcome is available here.";
      }
    });
  }

  async function reconcileAnnotation(workspaceId: string, annotation: Annotation & { attempt: NonNullable<Annotation["attempt"]> }) {
    const { attempt, agentId, outcome } = annotation;
    let cursor: TimelineCursor = attempt.cursor;
    for (let pages = 0; pages < 5; pages += 1) {
      const page = await host.timeline(agentId, cursor);
      if (page.reset || page.epoch !== cursor.epoch) {
        cursor = { epoch: page.epoch, seq: Math.max(0, page.firstSeq - 1) };
        continue;
      }
      if (page.entries.some((row) => row.type === "outcome" && row.batchId === outcome.batchId)) {
        resolveAnnotation(workspaceId, outcome.batchId);
        return;
      }
      const last = page.entries.at(-1);
      if (last) cursor = { epoch: page.epoch, seq: last.seq };
      if (!page.hasNewer) {
        if (now() >= attempt.at + reconcileGrace) resolveAnnotation(workspaceId, outcome.batchId, true);
        break;
      }
    }
    editState(database, workspaceId, (state) => {
      const current = state.annotations.find(({ outcome: pending }) => pending.batchId === outcome.batchId);
      if (current?.attempt) current.attempt.cursor = cursor;
    });
  }

  async function postAnnotations(workspaceId: string) {
    if (!host.annotate) return;
    for (const annotation of getState(workspaceId).annotations) {
      const { agentId, outcome, attempt } = annotation;
      const workspace = await host.workspace(workspaceId);
      const agent = await host.agent(agentId);
      if (!workspace || workspace.id !== workspaceId || workspace.directory !== annotation.directory ||
          !agent || agent.id !== agentId || agent.workspaceId !== workspaceId || agent.status === "closed") {
        resolveAnnotation(workspaceId, outcome.batchId, true);
        continue;
      }
      if (attempt) {
        await reconcileAnnotation(workspaceId, { ...annotation, attempt });
        continue;
      }
      if (!host.canAnnotate?.()) continue;
      const baseline = await host.timeline(agentId, null);
      const claimed = editState(database, workspaceId, (state) => {
        const current = state.annotations.find(({ outcome: pending }) => pending.batchId === outcome.batchId);
        if (!current || current.attempt) return false;
        current.attempt = { at: now(), cursor: { epoch: baseline.epoch, seq: baseline.latestSeq } };
        return true;
      });
      if (!claimed) continue;
      // The daemon cannot deduplicate append attempts. Reconcile a lost reply
      // through canonical history while leaving the durable inbox outcome intact.
      await host.annotate(agentId, outcome);
      resolveAnnotation(workspaceId, outcome.batchId);
    }
  }

  return {
    async workspaces() {
      return (await host.workspaces()).map(({ id, label }) => ({ id, label }));
    },
    async view(workspaceId: string) {
      await getWorkspace(workspaceId);
      const agents = (await host.agents(workspaceId))
        .filter((agent) => agent.workspaceId === workspaceId && agent.status !== "closed")
        .map(({ id, label, provider }) => ({ id, label, provider }));
      const { items, batch } = getState(workspaceId);
      return {
        agents,
        agentId: batch && agents.some(({ id }) => id === batch.agentId) ? batch.agentId : null,
        canStart: !batch || batch.phase === "finished",
        items: items.map(({ id, number, text, status, detail, images, prUrl }) => ({
          id, number, text, status, detail, images, ...(prUrl ? { prUrl } : {}),
        })),
        batch: batch && { id: batch.id, agentId: batch.agentId, status: batch.status, detail: batch.detail },
      };
    },
    async badge(workspaceId: string) {
      return summarize(getState(workspaceId));
    },
    async add(workspaceId: string, text: string) {
      const cleaned = text.trim();
      if (!cleaned || cleaned.length > 8000) throw new Error("Enter between 1 and 8,000 characters.");
      await getWorkspace(workspaceId);
      editState(database, workspaceId, (state) => {
        state.items.push({
          id: randomUUID(), number: state.items.length + 1, text: cleaned, status: "inbox", detail: "", images: 0,
        });
      });
    },
    async attach(workspaceId: string, itemId: string, mimeType: ImageType, bytes: Buffer) {
      if (bytes.length > maxImageBytes || !validImage(mimeType, bytes)) {
        throw new Error("Choose a PNG or JPEG image up to 8 MiB.");
      }
      await getWorkspace(workspaceId);
      editState(database, workspaceId, (state) => {
        const item = state.items.find(({ id }) => id === itemId);
        if (!item || item.status !== "inbox") throw new Error("Images can only be added to bugs in this workspace inbox.");
        if (item.images >= 4) throw new Error("A bug can have up to four images.");
        insertImage(database, workspaceId, item, mimeType, bytes);
      });
    },
    async start(workspaceId: string, agentId: string, itemIds: string[]) {
      const selection = new Set(itemIds);
      if (selection.size !== itemIds.length || selection.size === 0 || selection.size > maxItems) {
        throw new Error("Select between 1 and 20 distinct bugs.");
      }
      const workspace = await getWorkspace(workspaceId);
      const agent = await host.agent(agentId);
      if (!agent || agent.id !== agentId || agent.workspaceId !== workspaceId || agent.status === "closed") {
        throw new Error("Choose an existing chat from this workspace.");
      }
      const repository = await host.repository(workspace);
      if (!repository) throw new Error("This workspace needs a GitHub origin before work can start.");
      editState(database, workspaceId, (state) => {
        if (state.batch && state.batch.phase !== "finished") throw new Error("This workspace already has an active batch.");
        const items = state.items.filter(({ id, status }) => selection.has(id) && status === "inbox");
        if (items.length !== selection.size) throw new Error("Select bugs from this workspace inbox.");
        const imageBytes = items.reduce((total, item) => total + imageSize(database, workspaceId, item.id), 0);
        if (imageBytes > maxBatchImageBytes) throw new Error("Select a batch with up to 24 MiB of images.");
        const id = randomUUID();
        const detail = waitingFor(agent) ?? "Waiting to send the batch to the selected chat.";
        state.batch = {
          id, agentId, repository, directory: workspace.directory, itemIds: items.map(({ id }) => id),
          messageId: randomUUID(), text: formatPrompt(id, items), phase: "queued", status: "queued", detail,
          attempts: 0, attemptedAt: 0, cursor: null, turnId: null, interrupted: false, idleSince: null, assistant: null,
        };
        for (const item of items) {
          item.status = "queued";
          item.detail = detail;
        }
      });
    },
    tick() {
      if (closing) return closing;
      if (!ticking) {
        ticking = (async () => {
          for (const workspaceId of activeWorkspaces(database)) {
            const batch = getState(workspaceId).batch;
            if (batch && batch.phase !== "finished") {
              try {
                await advance(workspaceId, batch);
              } catch {
                changeBatch(workspaceId, batch.id, (_state, current) => {
                  current.status = "blocked";
                  current.detail = "The inbox cannot check the selected chat right now. It will try again.";
                });
              }
            }
            try {
              await postAnnotations(workspaceId);
            } catch {
              // Preserve the pending annotation for a later scoped context or timeline check.
            }
          }
        })().finally(() => { ticking = null; });
      }
      return ticking;
    },
    close() {
      closing ??= (async () => {
        try {
          await ticking;
        } finally {
          database.close();
        }
      })();
      return closing;
    },
  };
}
