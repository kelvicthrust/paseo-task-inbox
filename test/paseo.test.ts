import assert from "node:assert/strict";
import test from "node:test";
import type { PaseoAgent, PaseoApi, PaseoAgentTimelineHandle, PaseoWorkspaceHandle } from "@getpaseo/client";
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

test("lists model-specific effort and creates workspace chats with an optional override", async () => {
  const workspace = { id: workspaceId, label: "Example workspace", directory: "/workspace" };
  const created: Parameters<PaseoWorkspaceHandle["agents"]["create"]>[0][] = [];
  const requests: string[] = [];
  let catalogError = false;
  const paseo = {
    providers: {
      listAvailable: async () => ({ providers: [
        { provider: "codex", available: true }, { provider: "claude", available: true },
      ], error: null }),
      listModels: async (provider: string, { cwd }: { cwd: string }) => {
        requests.push(provider);
        assert.equal(cwd, workspace.directory);
        if (provider === "claude") return { error: "Claude provider is starting" };
        if (catalogError) return { error: "Provider is starting" };
        return { models: [
          { id: "demo", label: "Demo", thinkingOptions: [{ id: "high", label: "High", description: "Higher effort" }] },
          { id: "hidden", label: "Hidden", isSelectable: false },
        ] };
      },
    },
    workspaces: { ref: (id: string) => {
      assert.equal(id, workspaceId);
      return { agents: { create: async (input: (typeof created)[number]) => {
        created.push(input);
        return { id: input.agentId };
      } } };
    } },
  } as unknown as PaseoApi;
  const host = createPaseoHost(paseo, () => paseo);
  assert.deepEqual(await host.agentModels(workspace), [{
    value: "codex/demo", label: "Codex · Demo", thinkingOptions: [{ id: "high", label: "High" }],
  }]);
  assert.deepEqual(requests.splice(0), ["codex", "claude"]);
  assert.equal((await host.agentModels(workspace, "codex")).length, 1);
  assert.deepEqual(requests, ["codex"]);
  catalogError = true;
  await assert.rejects(host.agentModels(workspace, "codex"), /could not check available Codex models/);
  await host.createAgent(workspace, { agentId: "chat-1", batchId: "batch-1", model: "codex/demo" });
  await host.createAgent(workspace, { agentId: "chat-2", batchId: "batch-2", model: "codex/demo", thinkingOptionId: "high" });
  assert.deepEqual(created.map(({ agentId, idempotencyKey, config }) => ({ agentId, idempotencyKey, config })), [
    { agentId: "chat-1", idempotencyKey: "task-inbox:batch-1", config: { provider: "codex/demo" } },
    { agentId: "chat-2", idempotencyKey: "task-inbox:batch-2", config: { provider: "codex/demo", thinkingOptionId: "high" } },
  ]);
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
