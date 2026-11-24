import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  createInboxService,
  hasUnfinishedBatches,
  type InboxAgent,
  type InboxHost,
  type TimelineEntry,
} from "../server/inbox.ts";
import type { BatchOutcome } from "../shared/outcome.ts";

const workspace = { id: "workspace-1", label: "Example", directory: "/example/worktree" };
const anotherWorkspace = { id: "workspace-2", label: "Another", directory: "/another/worktree" };
const agent: InboxAgent = {
  id: "agent-1", workspaceId: workspace.id, label: "Existing chat", provider: "codex",
  status: "idle", activeTurn: null, pendingPermission: false,
};
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFKsAAAAASUVORK5CYII=", "base64");
const revision = "abcdef0123456789abcdef0123456789abcdef01";
const prUrl = "https://github.com/example/project/pull/23";
const verification = { check: "Open the saved view", observed: "The corrected title is visible.", status: "passed" };

function report(batchId: string, itemId: string, fields: object) {
  return "PASEO_TASK_INBOX_V1 " + JSON.stringify({ batchId, itemId, ...fields });
}

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "paseo-task-inbox-"));
  assert.equal(await hasUnfinishedBatches(dir), false);
  const state = {
    agent,
    currentWorkspace: workspace,
    clock: 100_000,
    entries: [] as TimelineEntry[],
    sent: [] as Parameters<InboxHost["send"]>[1][],
    seen: new Set<string>(),
    echo: true,
    epoch: "epoch",
    rejectedAck: false,
    native: true,
    lostAnnotationAck: false,
    annotations: [] as BatchOutcome[],
    verification: [] as Parameters<InboxHost["verify"]>[0][],
  };
  const host: InboxHost = {
    workspaces: async () => [workspace, anotherWorkspace],
    workspace: async (id) => id === workspace.id ? state.currentWorkspace : id === anotherWorkspace.id ? anotherWorkspace : null,
    agents: async (id) => id === workspace.id ? [state.agent] : [],
    agent: async (id) => id === agent.id ? state.agent : null,
    agentModels: async () => [],
    createAgent: async () => { throw new Error("Unexpected agent creation"); },
    repository: async () => "example/project",
    timeline: async (_agentId, cursor) => {
      if (cursor && cursor.epoch !== state.epoch) {
        return { epoch: state.epoch, reset: true, firstSeq: 1, latestSeq: state.entries.length, endSeq: null, entries: [], hasNewer: false };
      }
      return {
        epoch: state.epoch,
        reset: false,
        firstSeq: 1,
        latestSeq: state.entries.length,
        endSeq: cursor ? Math.min(state.entries.length, cursor.seq + 2) : state.entries.length,
        entries: cursor ? state.entries.slice(cursor.seq, cursor.seq + 2) : [],
        hasNewer: cursor ? state.entries.length > cursor.seq + 2 : false,
      };
    },
    send: async (_agentId, input) => {
      state.sent.push(input);
      if (state.echo && !state.seen.has(input.messageId)) {
        state.seen.add(input.messageId);
        state.entries.push({
          seq: state.entries.length + 1, turnId: "batch-turn", type: "user_message",
          clientMessageId: input.messageId, text: input.text,
        });
      }
      if (state.rejectedAck) throw new Error("transport lost response");
    },
    canAnnotate: () => state.native,
    annotate: async (id, outcome) => {
      assert.equal(id, agent.id);
      state.annotations.push(outcome);
      state.entries.push({ seq: state.entries.length + 1, type: "outcome", batchId: outcome.batchId });
      if (state.lostAnnotationAck) throw new Error("transport lost annotation response");
    },
    verify: async (input) => {
      state.verification.push(input);
      return input.url === prUrl && input.revision === revision
        ? { status: "verified", url: prUrl, revision, fixRevision: revision }
        : { status: "rejected", detail: "Pull request head differs from the reported revision." };
    },
  };
  let inbox = await createInboxService(host, dir, () => state.clock);
  t.after(async () => {
    await inbox.close();
    await rm(dir, { force: true, recursive: true });
  });
  return {
    state, host, dir,
    get inbox() { return inbox; },
    async restart() {
      await inbox.close();
      inbox = await createInboxService(host, dir, () => state.clock);
    },
    addAssistant(text: string, turnId = "batch-turn", messageId?: string) {
      state.entries.push({ seq: state.entries.length + 1, turnId, type: "assistant_message", text, messageId });
    },
  };
}

test("a selection survives restart, sends only after permissions and activity clear, and leaves later captures in the inbox", async (t) => {
  const f = await fixture(t);
  await f.inbox.add(workspace.id, "Fix the flaky control");
  await f.inbox.add(anotherWorkspace.id, "Private second workspace capture");
  const one = (await f.inbox.view(workspace.id)).items[0];
  await f.inbox.attach(workspace.id, one.id, "image/png", png);
  await assert.rejects(f.inbox.attach(anotherWorkspace.id, one.id, "image/png", png), /inbox/);
  f.state.agent = { ...agent, status: "running", activeTurn: "manual-turn" };
  await f.inbox.start(workspace.id, agent.id, [one.id]);
  const batchId = (await f.inbox.view(workspace.id)).batch?.id;
  await f.inbox.add(workspace.id, "Capture after Start");
  await assert.rejects(f.inbox.attach(workspace.id, one.id, "image/png", png), /inbox/);
  await f.inbox.tick();
  await f.restart();
  assert.equal((await f.inbox.view(workspace.id)).batch?.id, batchId);
  assert.equal((await stat(join(f.dir, "inbox.sqlite3"))).mode & 0o077, 0);
  f.state.agent = { ...agent, pendingPermission: true };
  await f.inbox.tick();
  assert.equal(f.state.sent.length, 0);
  assert.equal((await f.inbox.view(workspace.id)).batch?.status, "blocked");
  f.state.agent = agent;
  await f.inbox.tick();
  assert.equal(f.state.sent.length, 1);
  assert.match(f.state.sent[0].text, /Fix the flaky control/);
  assert.doesNotMatch(f.state.sent[0].text, /Capture after Start|Private second workspace/);
  assert.deepEqual(f.state.sent[0].images, [{ data: png.toString("base64"), mimeType: "image/png" }]);
  const items = (await f.inbox.view(workspace.id)).items;
  assert.deepEqual(items.map(({ id, number, status, images }) => ({ id, number, status, images })), [
    { id: one.id, number: 1, status: "working", images: 1 },
    { id: items[1].id, number: 2, status: "inbox", images: 0 },
  ]);
});

test("a lost acknowledgement reconciles from the existing chat without duplicate delivery", async (t) => {
  const f = await fixture(t);
  await f.inbox.add(workspace.id, "Repair title");
  const item = (await f.inbox.view(workspace.id)).items[0];
  await f.inbox.start(workspace.id, agent.id, [item.id]);
  const batchId = (await f.inbox.view(workspace.id)).batch!.id;
  f.state.rejectedAck = true;
  await f.inbox.tick();
  await f.restart();
  f.addAssistant(report(batchId, item.id, { status: "completed", detail: "Repaired title.", url: prUrl, verification, revision }));
  await f.inbox.tick();
  assert.equal(f.state.sent.length, 1);
  const view = await f.inbox.view(workspace.id);
  assert.equal(view.canStart, true);
  assert.equal(view.items[0].status, "completed");
  assert.equal(view.items[0].prUrl, prUrl);
  assert.match(view.items[0].detail, new RegExp(revision));
});

test("a new chat survives a lost creation reply and a restart without duplicating the batch", async (t) => {
  const f = await fixture(t);
  const created: string[] = [];
  const sentTo: string[] = [];
  let nextChat: InboxAgent | null = null;
  const send = f.host.send;
  f.host.agent = async (id) => nextChat?.id === id ? nextChat : id === agent.id ? agent : null;
  f.host.agents = async (id) => id === workspace.id ? [agent, ...(nextChat ? [nextChat] : [])] : [];
  f.host.agentModels = async () => [{ value: "codex/demo", label: "Codex · Demo" }];
  f.host.createAgent = async (target, { agentId, batchId, model }) => {
    assert.equal(target.id, workspace.id);
    assert.equal(batchId, (await f.inbox.view(workspace.id)).batch?.id);
    assert.equal(model, "codex/demo");
    created.push(agentId);
    nextChat = { ...agent, id: agentId, label: "Task Inbox" };
    throw new Error("creation reply was lost");
  };
  f.host.send = async (id, message) => { sentTo.push(id); await send(id, message); };
  await f.inbox.add(workspace.id, "Repair keyboard focus");
  const [item] = (await f.inbox.view(workspace.id)).items;
  await f.inbox.attach(workspace.id, item.id, "image/png", png);
  await f.inbox.startNew(workspace.id, [item.id], "codex/demo");
  const reserved = (await f.inbox.view(workspace.id)).batch!;
  await assert.rejects(f.inbox.startNew(workspace.id, [item.id], "codex/demo"), /active batch/);
  await f.inbox.tick();
  await f.restart();
  await f.inbox.tick();
  await f.inbox.tick();
  assert.deepEqual(created, [reserved.agentId]);
  assert.deepEqual(sentTo, [reserved.agentId]);
  assert.deepEqual(f.state.sent[0].images, [{ data: png.toString("base64"), mimeType: "image/png" }]);
  f.host.canAnnotate = () => false;
  f.addAssistant(report(reserved.id, item.id, { status: "completed", detail: "Focus restored.", url: prUrl, verification, revision }));
  await f.inbox.tick();
  assert.equal((await f.inbox.view(workspace.id)).items[0].prUrl, prUrl);
});

test("new batches validate their workspace, items and model before creating a chat", async (t) => {
  const f = await fixture(t);
  let available = false;
  f.host.agentModels = async () => available ? [{ value: "claude/demo", label: "Claude Code · Demo" }] : [];
  await f.inbox.add(workspace.id, "Fix export");
  const [item] = (await f.inbox.view(workspace.id)).items;
  await assert.rejects(f.inbox.startNew("missing", [item.id], "claude/demo"), /workspace is unavailable/);
  await assert.rejects(f.inbox.startNew(workspace.id, [item.id], ""), /Choose a model/);
  await assert.rejects(f.inbox.startNew(workspace.id, [item.id], "claude/demo"), /model is unavailable/);
  available = true;
  await assert.rejects(f.inbox.startNew(anotherWorkspace.id, [item.id], "claude/demo"), /bugs from this workspace/);
  await assert.rejects(f.inbox.startNew(workspace.id, [item.id, item.id], "claude/demo"), /distinct bugs/);
  assert.equal((await f.inbox.view(workspace.id)).batch, null);
  await f.inbox.startNew(workspace.id, [item.id], "claude/demo");
  available = false;
  await f.inbox.tick();
  const view = await f.inbox.view(workspace.id);
  assert.equal(view.canStart, true);
  assert.equal(view.items[0].status, "inbox");
  assert.match(view.batch!.detail, /model is unavailable/);
  assert.equal(f.state.sent.length, 0);
});

test("unconfirmed creation retries with the reserved identity and leaves the reports blocked", async (t) => {
  const f = await fixture(t);
  const attempts: { agentId: string; batchId: string; model: string }[] = [];
  f.host.agentModels = async () => [{ value: "codex/demo", label: "Codex · Demo" }];
  f.host.createAgent = async (_workspace, request) => {
    attempts.push(request);
    throw new Error("creation reply was lost");
  };
  await f.inbox.add(workspace.id, "Fix search");
  const [item] = (await f.inbox.view(workspace.id)).items;
  await f.inbox.startNew(workspace.id, [item.id], "codex/demo");
  for (let tick = 0; tick < 4; tick++) {
    await f.inbox.tick();
    f.state.clock += 60_000;
  }
  const view = await f.inbox.view(workspace.id);
  assert.deepEqual(attempts, Array.from({ length: 3 }, () => ({
    agentId: view.batch!.agentId, batchId: view.batch!.id, model: "codex/demo",
  })));
  assert.equal(view.items[0].status, "blocked");
  assert.match(view.batch!.detail, /could not confirm creation/);
  assert.equal(f.state.sent.length, 0);
});

test("the workspace inbox can target either chat and a started batch stays with its original chat", async (t) => {
  const f = await fixture(t);
  const otherChat = { ...agent, id: "agent-2", label: "Second chat" };
  const foreignChat = { ...agent, id: "agent-3", workspaceId: anotherWorkspace.id };
  const send = f.host.send;
  const sentTo: string[] = [];
  f.host.agents = async (id) => id === workspace.id ? [f.state.agent, otherChat] : [foreignChat];
  f.host.agent = async (id) => [f.state.agent, otherChat, foreignChat].find((chat) => chat.id === id) ?? null;
  f.host.send = async (id, message) => {
    sentTo.push(id);
    await send(id, message);
  };
  await f.inbox.add(workspace.id, "Fix original bug");
  await f.inbox.add(anotherWorkspace.id, "Private capture");
  const { items: [item], agents } = await f.inbox.view(workspace.id);
  assert.deepEqual(agents.map(({ id }) => id), [agent.id, otherChat.id]);
  await assert.rejects(f.inbox.start(workspace.id, foreignChat.id, [item.id]), /existing chat from this workspace/);
  await f.inbox.start(workspace.id, agent.id, [item.id]);
  const { batch } = await f.inbox.view(workspace.id);
  await f.inbox.add(workspace.id, "Fix later bug");
  const later = (await f.inbox.view(workspace.id)).items[1];
  await assert.rejects(f.inbox.start(workspace.id, otherChat.id, [later.id]), /active batch/);
  await f.restart();
  await f.inbox.tick();
  assert.deepEqual(sentTo, [agent.id]);
  f.addAssistant(report(batch!.id, item.id, { status: "blocked", detail: "Reproduction needs staging." }));
  await f.inbox.tick();
  const result = await f.inbox.view(workspace.id);
  assert.equal(result.batch?.agentId, agent.id);
  assert.equal(result.items[0].status, "blocked");
  assert.equal(f.state.annotations[0]?.batchId, batch?.id);
  assert.deepEqual(result.items.map(({ text }) => text), ["Fix original bug", "Fix later bug"]);
  await f.inbox.start(workspace.id, otherChat.id, [later.id]);
  await f.inbox.tick();
  assert.deepEqual(sentTo, [agent.id, otherChat.id]);
});

test("only matching, strict, streamed assistant reports become progress, blockers or verified completion", async (t) => {
  const f = await fixture(t);
  await f.inbox.add(workspace.id, "First");
  await f.inbox.add(workspace.id, "Second");
  await f.inbox.add(workspace.id, "Third");
  const [first, second, third] = (await f.inbox.view(workspace.id)).items;
  await f.inbox.start(workspace.id, agent.id, [first.id, second.id, third.id]);
  const batchId = (await f.inbox.view(workspace.id)).batch!.id;
  await f.inbox.tick();
  f.state.agent = { ...agent, status: "running", activeTurn: "batch-turn" };
  f.addAssistant(report(batchId, first.id, { status: "completed", detail: "Wrong turn.", url: prUrl, verification, revision }), "other-turn");
  f.addAssistant(report(batchId, first.id, { status: "working", detail: "Reproduced the issue." }) + "\n", "batch-turn", "first");
  f.addAssistant(report(batchId, second.id, { status: "blocked", detail: "Requires staging access.", unexpected: true }), "batch-turn", "malformed");
  await f.inbox.tick();
  assert.equal((await f.inbox.view(workspace.id)).items[0].detail, "Reproduced the issue.");
  assert.equal(f.state.verification.length, 0);
  const completed = report(batchId, first.id, { status: "completed", detail: "Repaired.", url: prUrl, verification, revision });
  f.addAssistant(completed.slice(0, 50), "batch-turn", "streamed");
  await f.inbox.tick();
  await f.restart();
  f.addAssistant(completed.slice(50), "batch-turn", "streamed");
  f.addAssistant(report(batchId, second.id, { status: "blocked", detail: "Requires staging access." }), "batch-turn", "second");
  f.addAssistant(report(batchId, third.id, { status: "completed", detail: "Head moved.", url: prUrl, verification, revision: "a".repeat(40) }), "batch-turn", "third");
  f.state.agent = agent;
  await f.inbox.tick();
  const view = await f.inbox.view(workspace.id);
  assert.deepEqual(view.items.map((item) => item.status), ["completed", "blocked", "blocked"]);
  assert.equal(view.items[1].detail, "Requires staging access.");
  assert.match(view.items[2].detail, /head differs/);
});

test("ambiguous sends retry the exact persisted message after a new idle check", async (t) => {
  const f = await fixture(t);
  await f.inbox.add(workspace.id, "Repair title");
  const item = (await f.inbox.view(workspace.id)).items[0];
  await f.inbox.start(workspace.id, agent.id, [item.id]);
  f.state.echo = false;
  f.state.rejectedAck = true;
  await f.inbox.tick();
  await f.restart();
  f.state.clock += 30_000;
  f.state.agent = { ...agent, status: "running", activeTurn: "new-manual-turn" };
  await f.inbox.tick();
  assert.equal(f.state.sent.length, 1);
  f.state.agent = agent;
  f.state.echo = true;
  f.state.rejectedAck = false;
  await f.inbox.tick();
  assert.equal(f.state.sent.length, 2);
  assert.deepEqual(f.state.sent[0], f.state.sent[1]);
});

test("rechecks the exact chat after dispatch preparation and permits concurrent capture", async (t) => {
  const f = await fixture(t);
  await f.inbox.add(workspace.id, "Fix menu");
  const item = (await f.inbox.view(workspace.id)).items[0];
  await f.inbox.start(workspace.id, agent.id, [item.id]);
  const existingTimeline = f.host.timeline;
  f.host.timeline = async (agentId, cursor) => {
    await f.inbox.add(workspace.id, "Capture during preparation");
    f.state.agent = { ...agent, status: "running", activeTurn: "concurrent-manual-turn" };
    return existingTimeline(agentId, cursor);
  };
  await f.inbox.tick();
  assert.equal(f.state.sent.length, 0);
  assert.deepEqual((await f.inbox.view(workspace.id)).items.map(({ status }) => status), ["queued", "inbox"]);
});

test("a replaced timeline is replayed across bounded pages and a stock follow-up can’t supply batch completion", async (t) => {
  const f = await fixture(t);
  await f.inbox.add(workspace.id, "One bug");
  await f.inbox.add(workspace.id, "Second bug");
  const [first, second] = (await f.inbox.view(workspace.id)).items;
  await f.inbox.start(workspace.id, agent.id, [first.id, second.id]);
  const batchId = (await f.inbox.view(workspace.id)).batch!.id;
  await f.inbox.tick();
  f.state.agent = { ...agent, status: "running", activeTurn: "batch-turn" };
  f.addAssistant(report(batchId, first.id, { status: "working", detail: "Reproduced." }), "batch-turn", "progress");
  await f.inbox.tick();
  await f.restart();
  f.state.epoch = "replacement";
  f.addAssistant(report(batchId, first.id, { status: "completed", detail: "Repaired.", url: prUrl, verification, revision }), "batch-turn", "complete");
  f.state.entries.push({ seq: 4, turnId: "batch-turn", type: "user_message", clientMessageId: "another-client", text: "Manual steer" });
  f.addAssistant(report(batchId, second.id, { status: "completed", detail: "After steer.", url: prUrl, verification, revision }), "batch-turn", "other");
  await f.inbox.tick();
  f.state.clock += 5_001;
  await f.inbox.tick();
  const view = await f.inbox.view(workspace.id);
  assert.deepEqual(view.items.map(({ status }) => status), ["completed", "blocked"]);
  assert.match(view.items[1].detail, /interrupted/);
  assert.equal(f.state.verification.length, 1);
  assert.equal(f.state.sent.length, 1);
});

test("posts both verified and blocked results once as an annotation even if the acknowledgement is lost", async (t) => {
  const f = await fixture(t);
  await f.inbox.add(workspace.id, "First");
  await f.inbox.add(workspace.id, "Second");
  const [first, second] = (await f.inbox.view(workspace.id)).items;
  await f.inbox.start(workspace.id, agent.id, [first.id, second.id]);
  const batchId = (await f.inbox.view(workspace.id)).batch!.id;
  await f.inbox.tick();
  f.addAssistant(report(batchId, first.id, { status: "completed", detail: "Repaired.", url: prUrl, verification, revision }), "batch-turn", "first");
  f.addAssistant(report(batchId, second.id, { status: "blocked", detail: "Requires staging access." }), "batch-turn", "second");
  f.state.native = false;
  await f.inbox.tick();
  assert.equal(f.state.annotations.length, 0);
  assert.equal(await hasUnfinishedBatches(f.dir), true);
  await f.restart();
  f.state.native = true;
  f.state.lostAnnotationAck = true;
  await f.inbox.tick();
  assert.equal(f.state.annotations.length, 1);
  await f.restart();
  await f.inbox.tick();
  assert.equal(await hasUnfinishedBatches(f.dir), false);
  assert.equal(f.state.annotations.length, 1);
  assert.equal(f.state.sent.length, 1);
  assert.deepEqual(f.state.annotations[0].items.map(({ status }) => status), ["completed", "blocked"]);
});

test("a ready PR alone cannot archive a bug without a passing per-item check", async (t) => {
  const f = await fixture(t);
  await f.inbox.add(workspace.id, "Fix saved view title");
  const [item] = (await f.inbox.view(workspace.id)).items;
  await f.inbox.start(workspace.id, agent.id, [item.id]);
  const batchId = (await f.inbox.view(workspace.id)).batch!.id;
  await f.inbox.tick();
  f.state.agent = { ...agent, status: "running", activeTurn: "batch-turn" };
  const claim = { status: "completed", detail: "Changed the title.", url: prUrl, revision };
  f.addAssistant(report(batchId, item.id, claim) + "\n");
  f.addAssistant(report(batchId, item.id, { ...claim, verification: { ...verification, status: "failed" } }) + "\n");
  await f.inbox.tick();
  assert.equal((await f.inbox.view(workspace.id)).items[0].status, "working");
  assert.equal(f.state.verification.length, 0);
  f.addAssistant(report(batchId, item.id, { ...claim, verification }) + "\n");
  await f.inbox.tick();
  const verified = (await f.inbox.view(workspace.id)).items[0];
  assert.equal(verified.status, "completed");
  assert.ok(verified.detail.includes(verification.check));
  assert.ok(verified.detail.includes(verification.observed));
  assert.deepEqual(await f.inbox.badge(workspace.id), { count: 1, status: "completed" });
  await f.inbox.add(workspace.id, "Another capture");
  assert.deepEqual(await f.inbox.badge(workspace.id), { count: 1, status: "inbox" });
});

test("a queued batch resumes its same dormant chat through history before dispatch", async (t) => {
  const f = await fixture(t);
  f.state.agent = { ...agent, status: "closed", resumable: true };
  await f.inbox.add(workspace.id, "Fix after daemon restart");
  const item = (await f.inbox.view(workspace.id)).items[0];
  assert.deepEqual((await f.inbox.view(workspace.id)).agents.map(({ id }) => id), [agent.id]);
  await f.inbox.start(workspace.id, agent.id, [item.id]);
  const readTimeline = f.host.timeline;
  f.host.timeline = async (id, cursor) => {
    assert.equal(id, agent.id);
    f.state.agent = agent;
    return readTimeline(id, cursor);
  };
  await f.restart();
  await f.inbox.tick();
  assert.equal(f.state.sent.length, 1);
  assert.match(f.state.sent[0].text, /Fix after daemon restart/);
});

test("a daemon-reset history lacking stable prompt and turn IDs cannot complete or resend work", async (t) => {
  const f = await fixture(t);
  await f.inbox.add(workspace.id, "Fix header");
  const item = (await f.inbox.view(workspace.id)).items[0];
  await f.inbox.start(workspace.id, agent.id, [item.id]);
  const batchId = (await f.inbox.view(workspace.id)).batch!.id;
  await f.inbox.tick();
  f.state.epoch = "daemon-restart";
  f.state.clock += 60_001;
  f.state.entries = [
    { seq: 1, type: "user_message", text: f.state.sent[0].text },
    { seq: 2, type: "assistant_message", text: report(batchId, item.id, { status: "completed", detail: "Uncorrelated history.", url: prUrl, revision }) },
  ];
  await f.restart();
  await f.inbox.tick();
  assert.equal(f.state.sent.length, 1);
  assert.equal(f.state.verification.length, 0);
  const itemAfterRestart = (await f.inbox.view(workspace.id)).items[0];
  assert.equal(itemAfterRestart.status, "blocked");
  assert.match(itemAfterRestart.detail, /history changed.*matching turn/i);
});
