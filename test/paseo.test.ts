import assert from "node:assert/strict";
import test from "node:test";
import type { PaseoAgent, PaseoApi, PaseoAgentTimelineHandle } from "@getpaseo/client";
import { createPaseoHost } from "../server/paseo.ts";

type Page = Awaited<ReturnType<PaseoAgentTimelineHandle["refetch"]>>;
type Row = Page["entries"][number];

const agentId = "existing-chat";
const workspaceId = "existing-workspace";
const epoch = "live-timeline";

function row(seqStart: number, seqEnd: number, item: Row["item"]): Row {
  return { seqStart, seqEnd, item, turnId: "batch-turn", provider: "codex",
    timestamp: "2026-11-24T01:00:00Z", collapsed: [],
    sourceSeqRanges: [{ startSeq: seqStart, endSeq: seqEnd }],
  };
}

function stub() {
  const snapshot = {
    id: agentId, workspaceId, provider: "codex", cwd: "/workspace", title: "Existing chat",
    status: "closed", pendingPermissions: [], persistence: { provider: "codex", sessionId: "existing-session" },
  } as unknown as PaseoAgent;
  const requests: Parameters<PaseoAgentTimelineHandle["refetch"]>[0][] = [];
  const page: Page = {
    requestId: "fake-request", agentId, agent: snapshot, direction: "after", projection: "projected",
    epoch, startCursor: { epoch, seq: 1 }, endCursor: { epoch, seq: 2 }, reset: false,
    staleCursor: false, gap: false, window: { minSeq: 1, maxSeq: 2, nextSeq: 3 },
    hasOlder: false, hasNewer: false, entries: [], error: null,
  };
  const paseo = { agents: { ref: () => ({
    refresh: async () => ({ agent: snapshot, project: null }),
    timeline: { refetch: async (request: Parameters<PaseoAgentTimelineHandle["refetch"]>[0]) => {
      requests.push(request);
      return page;
    } },
  }) } } as unknown as PaseoApi;
  return { host: createPaseoHost(paseo, () => paseo), page, snapshot, requests };
}

test("projects unarchived persisted dormant chats as resumable and rejects archived targets", async () => {
  const { host, snapshot } = stub();
  assert.equal((await host.agent(agentId))?.resumable, true);
  snapshot.archivedAt = "2026-11-23T17:00:00Z";
  assert.equal(await host.agent(agentId), null);
});

test("reads 0.16.1 projected pages without consuming a growing assistant row", async () => {
  const { host, page, snapshot } = stub();
  snapshot.status = "running";
  snapshot.activeTurn = { turnId: "batch-turn", startedAt: null };
  page.entries = [
    row(1, 1, { type: "user_message", text: "Exact bound batch", clientMessageId: "frozen-message-id" }),
    row(2, 2, { type: "assistant_message", text: "Partial", messageId: "assistant-id" }),
  ];
  const whileRunning = await host.timeline(agentId, { epoch, seq: 0 });
  assert.equal(whileRunning.endSeq, 1);
  assert.deepEqual(whileRunning.entries, [{
    seq: 1, type: "user_message", text: "Exact bound batch", turnId: "batch-turn", clientMessageId: "frozen-message-id",
  }]);

  snapshot.status = "idle";
  snapshot.activeTurn = null;
  page.entries = [row(2, 3, { type: "assistant_message", text: "Partial, now complete", messageId: "assistant-id" })];
  page.window.maxSeq = 3;
  page.endCursor = { epoch, seq: 3 };
  const settled = await host.timeline(agentId, { epoch, seq: 1 });
  assert.equal(settled.endSeq, 3);
  assert.deepEqual(settled.entries, [{
    seq: 3, type: "assistant_message", text: "Partial, now complete", turnId: "batch-turn", messageId: "assistant-id", complete: true,
  }]);
});

test("uses the page boundary even when a projected tool entry includes a later sequence", async () => {
  const { host, page } = stub();
  page.window.maxSeq = 7;
  page.hasNewer = true;
  page.entries = [
    row(1, 7, { type: "todo", items: [] }),
    row(2, 2, { type: "assistant_message", text: "First stable part" }),
    row(4, 4, { type: "user_message", text: "Future boundary" }),
  ];
  const timeline = await host.timeline(agentId, { epoch, seq: 0 });
  assert.equal(timeline.endSeq, 2);
  assert.equal(timeline.hasNewer, true);
  assert.deepEqual(timeline.entries.map(({ type }) => type), ["other", "assistant_message"]);
});
