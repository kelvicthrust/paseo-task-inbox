import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import { crc32 } from "node:zlib";
import {
  createInboxService,
  hasUnfinishedBatches,
  type InboxAgent,
  type InboxHost,
  type TimelineEntry,
} from "../server/inbox.ts";
import type { BatchOutcome } from "../shared/outcome.ts";
import { createPullRequestVerifier, type PullRequestRecord } from "../server/github.ts";
import { inboxImageChunkBytes } from "../shared/rpc.ts";
import { screenshotGrantMs, screenshotLimit } from "../shared/screenshot.ts";

const workspace = { id: "workspace-1", label: "Example", directory: "/example/worktree" };
const anotherWorkspace = { id: "workspace-2", label: "Another", directory: "/another/worktree" };
const agent: InboxAgent = {
  id: "agent-1", workspaceId: workspace.id, label: "Existing chat", provider: "codex",
  status: "idle", activeTurn: null, pendingPermission: false,
};
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFKsAAAAASUVORK5CYII=", "base64");
const capturePng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=", "base64");
const revision = "abcdef0123456789abcdef0123456789abcdef01";
const prUrl = "https://github.com/example/project/pull/23";
const verification = { check: "Open the saved view", observed: "The corrected title is visible.", status: "passed" };

function report(batchId: string, itemId: string, fields: object) {
  return "PASEO_TASK_INBOX_V1 " + JSON.stringify({ batchId, itemId, ...fields });
}

test("a legacy finished batch with shell-only results recovers a merged PR for both bugs", async (t) => {
  const f = await fixture(t);
  await f.inbox.add(workspace.id, "First bug");
  await f.inbox.add(workspace.id, "Second bug");
  const ids = (await f.inbox.view(workspace.id)).items.map(({ id }) => id);
  await f.inbox.start(workspace.id, agent.id, ids);
  const batchId = (await f.inbox.view(workspace.id)).batch!.id;
  await f.inbox.tick();
  // Paseo projects shell output as an "other" entry.
  f.state.entries.push({ seq: 2, turnId: "batch-turn", type: "other" });
  await f.inbox.tick();
  f.state.clock += 6_000;
  await f.inbox.tick();
  assert.deepEqual((await f.inbox.view(workspace.id)).items.map(({ status }) => status), ["blocked", "blocked"]);
  const db = new DatabaseSync(join(f.dir, "inbox.sqlite3"));
  db.exec("UPDATE workspaces SET data = json_remove(data, '$.items[0].dispatch', '$.items[1].dispatch')");
  db.close();
  await f.restart();
  assert.equal(await hasUnfinishedBatches(f.dir), false);
  assert.equal(await hasUnfinishedBatches(f.dir, true), true);

  let requests = 0;
  f.host.pullRequests = {
    async search(repository, batch) {
      assert.equal(repository, "example/project");
      assert.equal(batch, batchId);
      return [prUrl];
    },
    async read() {
      requests++;
      return {
        url: prUrl, number: 23, state: "MERGED", isDraft: false, headRefOid: revision,
        body: ids.map((id) => `PASEO_TASK_INBOX_FIX_V1 ${batchId} ${id} ${revision}`).join("\n"),
        commits: [{ oid: revision }],
      };
    },
  };
  await f.inbox.syncPullRequests();
  const expected = [1, 2].map((number) => ({
    number, status: "blocked", detail: "Passing check pending.", prUrl, prState: "merged",
  }));
  assert.deepEqual(await f.inbox.batchOutcome(agent.id, batchId), expected);
  assert.deepEqual((await f.inbox.view(workspace.id)).items.map(({ number, status, detail, prUrl, prState }) =>
    ({ number, status, detail, prUrl, prState })), expected);
  assert.equal(await f.inbox.batchOutcome("another-chat", batchId), null);
  assert.equal(requests, 1);
  assert.equal(await hasUnfinishedBatches(f.dir, true), false);
  assert.equal(f.state.sent.length, 1);
  assert.equal(f.state.annotations.length, 1);
});

test("discovery waits for exact evidence and refreshes a linked PR across pushes, closure and restart", async (t) => {
  const f = await fixture(t);
  await f.inbox.add(workspace.id, "Fix a bug");
  const [item] = (await f.inbox.view(workspace.id)).items;
  await f.inbox.start(workspace.id, agent.id, [item.id]);
  const batchId = (await f.inbox.view(workspace.id)).batch!.id;
  await f.inbox.tick();
  await f.inbox.tick();
  f.state.clock += 6_000;
  await f.inbox.tick();

  let searches = 0;
  let readFails = false;
  const marker = `PASEO_TASK_INBOX_FIX_V1 ${batchId} ${item.id} ${revision}`;
  let record: PullRequestRecord = {
    url: prUrl, number: 23, state: "OPEN", isDraft: true, headRefOid: revision,
    body: marker.replace(item.id, "wrong-item"), commits: [{ oid: revision }],
  };
  f.host.pullRequests = {
    async search() {
      searches++;
      return searches === 1 ? [] : ["https://github.com/wrong/project/pull/23", prUrl];
    },
    async read(repository, url) {
      assert.equal(repository, "example/project");
      assert.equal(url, prUrl);
      if (readFails) throw new Error("GitHub unavailable");
      return record;
    },
  };
  async function status(expected: string | undefined) {
    await f.inbox.syncPullRequests();
    const [current] = (await f.inbox.batchOutcome(agent.id, batchId))!;
    assert.equal(current.prState, expected);
    assert.equal(current.status, "blocked");
    f.state.clock += 120_000;
  }
  await status(undefined); // Search indexing has not caught up.
  await status(undefined); // A marker for another item cannot link.
  record = { ...record, body: marker, commits: [] };
  await status(undefined); // The fix commit must belong to the PR.
  record = { ...record, commits: [{ oid: revision }] };
  await status("draft");
  assert.equal(searches, 4);

  const pushed = "a".repeat(40);
  record = { ...record, isDraft: false, headRefOid: pushed, commits: [...record.commits, { oid: pushed }] };
  await status("open");
  const db = new DatabaseSync(join(f.dir, "inbox.sqlite3"), { readOnly: true });
  assert.equal(db.prepare("SELECT json_extract(data, '$.items[0].pullRequest.head') AS head FROM workspaces").get()!.head, pushed);
  db.close();

  readFails = true;
  await status("open");
  readFails = false;
  record = { ...record, state: "CLOSED" };
  await status("closed");
  record = { ...record, state: "OPEN" };
  await status("open");
  await f.inbox.add(workspace.id, "A newer bug");
  const [, newer] = (await f.inbox.view(workspace.id)).items;
  await f.inbox.start(workspace.id, agent.id, [newer.id]);
  await f.restart();
  record = { ...record, state: "MERGED" };
  await status("merged");
  assert.equal(searches, 4);
  assert.equal(await f.inbox.batchOutcome(agent.id, "unrelated-batch"), null);
});

test("a persisted passing check verifies after a draft opens and retains its history after merge", async (t) => {
  const f = await fixture(t);
  await f.inbox.add(workspace.id, "Repair the title");
  const [item] = (await f.inbox.view(workspace.id)).items;
  await f.inbox.start(workspace.id, agent.id, [item.id]);
  const batchId = (await f.inbox.view(workspace.id)).batch!.id;
  await f.inbox.tick();
  let record: PullRequestRecord = {
    url: prUrl, number: 23, state: "OPEN", isDraft: true, headRefOid: revision,
    body: `PASEO_TASK_INBOX_FIX_V1 ${batchId} ${item.id} ${revision}`, commits: [{ oid: revision }],
  };
  f.host.verify = createPullRequestVerifier(f.host.repository, async () => record);
  f.host.pullRequests = { search: async () => [], read: async () => record };
  f.addAssistant(report(batchId, item.id, { status: "completed", detail: "Fixed the title.", url: prUrl, revision, verification }));
  await f.inbox.tick();
  await f.inbox.syncPullRequests();
  assert.equal((await f.inbox.view(workspace.id)).items[0].status, "blocked");
  await f.restart();
  record = { ...record, isDraft: false };
  await f.inbox.syncPullRequests();
  const [checked] = (await f.inbox.batchOutcome(agent.id, batchId))!;
  assert.equal(checked.status, "completed");
  assert.equal(checked.prState, "open");
  assert.match(checked.detail, /The corrected title is visible/);
  assert.equal((await f.inbox.view(workspace.id)).batch?.status, "completed");
  f.state.clock += 30_000;
  record = { ...record, state: "MERGED" };
  await f.inbox.syncPullRequests();
  assert.deepEqual(await f.inbox.batchOutcome(agent.id, batchId), [{ ...checked, prState: "merged" }]);
  assert.equal(f.state.annotations.length, 1);
});

async function fixture(t: TestContext, initialize?: (dir: string) => Promise<void>) {
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
  await initialize?.(dir);
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

function paddedPng(size: number) {
  const chunk = Buffer.alloc(12 + size);
  chunk.writeUInt32BE(size);
  chunk.write("raNd", 4);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return Buffer.concat([capturePng.subarray(0, -12), chunk, capturePng.subarray(-12)]);
}

async function stageImage(
  inbox: Awaited<ReturnType<typeof createInboxService>>,
  scope: { workspaceId: string; draftId: string; imageId: string },
  bytes: Buffer,
) {
  const { grant, received } = await inbox.beginImage({ ...scope, mimeType: "image/png", size: bytes.length });
  for (let offset = received; offset < bytes.length; offset += inboxImageChunkBytes) {
    const data = bytes.subarray(offset, offset + inboxImageChunkBytes).toString("base64");
    await inbox.appendImageChunk({ ...scope, grant, offset, data });
  }
  return { kind: "staged", imageId: scope.imageId, grant } as const;
}

test("capture saves four ordered screenshots once, replays after restart, and dispatches exact bytes", async (t) => {
  const f = await fixture(t);
  const draft = { workspaceId: workspace.id, draftId: "draft" };
  const images = [paddedPng(inboxImageChunkBytes), capturePng, paddedPng(16), paddedPng(24)];
  const references = await Promise.all(images.map((bytes, index) =>
    stageImage(f.inbox, { ...draft, imageId: `file-${index}` }, bytes)));
  const request = { ...draft, operationId: "save", text: "Repair screenshot ordering", images: references };
  const [saved, duplicate] = await Promise.all([f.inbox.saveItem(request), f.inbox.saveItem(request)]);
  assert.equal(saved.status, "saved");
  assert.deepEqual(duplicate, saved);
  await f.restart();
  assert.deepEqual(await f.inbox.saveItem(request), saved);
  await assert.rejects(f.inbox.saveItem({ ...request, text: "Different text" }), /already used/);
  const view = await f.inbox.view(workspace.id);
  assert.deepEqual(view.items, [saved.item]);
  const editor = await f.inbox.readItem({ workspaceId: workspace.id, itemId: saved.item.id });
  assert.equal(editor.status, "ready");
  assert.equal(new Set(editor.images.map(({ id }) => id)).size, 4);
  assert.deepEqual(editor.images.map(({ size }) => size), images.map(({ length }) => length));
  const preview: Buffer[] = [];
  for (let offset = 0; offset < editor.images[0].size; offset += inboxImageChunkBytes) {
    const { data } = await f.inbox.readImageChunk({
      workspaceId: workspace.id, itemId: saved.item.id, imageId: editor.images[0].id, version: saved.item.version, offset,
    });
    const chunk = Buffer.from(data, "base64");
    assert.ok(chunk.length <= inboxImageChunkBytes);
    preview.push(chunk);
  }
  assert.deepEqual(Buffer.concat(preview), images[0]);
  await f.inbox.start(workspace.id, agent.id, [saved.item.id]);
  await f.inbox.tick();
  assert.deepEqual(f.state.sent[0].images, images.map((bytes) => ({
    data: bytes.toString("base64"), mimeType: "image/png",
  })));
});

test("staging confines grants, validates chunks, and frees abandoned images", async (t) => {
  const f = await fixture(t);
  const upload = { workspaceId: workspace.id, draftId: "draft", imageId: "file", mimeType: "image/png", size: capturePng.length } as const;
  const { grant } = await f.inbox.beginImage(upload);
  const first = capturePng.subarray(0, 8).toString("base64");
  const chunk = { ...upload, grant, offset: 0, data: first };
  await assert.rejects(f.inbox.appendImageChunk({ ...chunk, workspaceId: anotherWorkspace.id }), /expired/);
  await assert.rejects(f.inbox.appendImageChunk({ ...chunk, draftId: "other" }), /expired/);
  await assert.rejects(f.inbox.appendImageChunk({ ...chunk, imageId: "other" }), /expired/);
  await assert.rejects(f.inbox.appendImageChunk({ ...chunk, offset: 1 }), /order/);
  await assert.rejects(f.inbox.appendImageChunk({ ...chunk, data: first + "!" }), /invalid/);
  assert.deepEqual(await f.inbox.appendImageChunk(chunk), { received: 8 });
  assert.deepEqual(await f.inbox.appendImageChunk(chunk), { received: 8 });
  await assert.rejects(f.inbox.appendImageChunk({ ...chunk, data: "AAAAAAAAAAA=" }), /match/);
  assert.deepEqual(await f.inbox.beginImage(upload), { grant, received: 8 });
  const save = {
    ...upload, operationId: "save", text: "Retry the picture",
    images: [{ kind: "staged", grant, imageId: upload.imageId }] as const,
  };
  const request = { ...save, images: [...save.images] };
  assert.deepEqual(await f.inbox.saveItem(request), { status: "upload-expired", imageId: upload.imageId });
  assert.deepEqual((await f.inbox.view(workspace.id)).items, []);
  f.state.clock += screenshotGrantMs;
  await f.inbox.tick();
  await assert.rejects(f.inbox.appendImageChunk(chunk), /expired/);
  const resumed = await f.inbox.beginImage(upload);
  assert.notEqual(resumed.grant, grant);
  await f.inbox.discardImages(upload);
  await assert.rejects(f.inbox.appendImageChunk({ ...chunk, grant: resumed.grant }), /expired/);
  const fresh = await f.inbox.beginImage(upload);
  await assert.rejects(f.inbox.appendImageChunk({
    ...upload, grant: fresh.grant, offset: 0, data: Buffer.alloc(capturePng.length).toString("base64"),
  }), /PNG or JPEG/);
  assert.notEqual((await f.inbox.beginImage(upload)).grant, fresh.grant);
  await f.restart();
  assert.deepEqual(await f.inbox.saveItem(request), { status: "upload-expired", imageId: upload.imageId });
  await assert.rejects(f.inbox.beginImage({ ...upload, size: screenshotLimit + 1 }), /8 MiB/);
  for (let index = 0; index < 4; index += 1) {
    await f.inbox.beginImage({ ...upload, imageId: String(index), size: screenshotLimit, draftId: "full" });
  }
  await assert.rejects(f.inbox.beginImage({ ...upload, draftId: "full" }), /four/);
  for (let index = 0; index < 4; index += 1) {
    await f.inbox.beginImage({ ...upload, imageId: String(index), size: screenshotLimit, draftId: "second" });
  }
  await assert.rejects(f.inbox.beginImage({ ...upload, workspaceId: anotherWorkspace.id }), /too many/);
  await f.inbox.discardImages({ workspaceId: workspace.id, draftId: "full" });
  await f.inbox.discardImages({ workspaceId: workspace.id, draftId: "second" });
  for (let index = 0; index < 64; index += 1) {
    await f.inbox.beginImage({ ...upload, draftId: String(index) });
  }
  await assert.rejects(f.inbox.beginImage(upload), /too many/);
});

test("a failed durable save rolls back the item and bytes and can reuse the staged image", async (t) => {
  const f = await fixture(t);
  const draft = { workspaceId: workspace.id, draftId: "draft" };
  const image = await stageImage(f.inbox, { ...draft, imageId: "image" }, capturePng);
  const request = { ...draft, operationId: "retry", text: "Atomic capture", images: [image] };
  const database = new DatabaseSync(join(f.dir, "inbox.sqlite3"));
  t.after(() => database.close());
  database.exec(`
    CREATE TRIGGER fail_receipt BEFORE INSERT ON save_receipts
    BEGIN SELECT RAISE(ABORT, 'save rejected'); END;
  `);
  await assert.rejects(f.inbox.saveItem(request), /save rejected/);
  assert.deepEqual((await f.inbox.view(workspace.id)).items, []);
  assert.equal(database.prepare("SELECT count(*) AS count FROM images").get()?.count, 0);
  database.exec("DROP TRIGGER fail_receipt");
  const saved = await f.inbox.saveItem(request);
  assert.equal(saved.status, "saved");
  assert.equal(saved.item.number, 1);
  assert.equal(saved.item.images, 1);
});

test("v1 data keeps its image identity, edits preserve ordering, and deleting the newest number survives reload", async (t) => {
  const itemId = "old-item";
  const f = await fixture(t, async (dir) => {
    const path = join(dir, "inbox.sqlite3");
    await writeFile(path, "", { mode: 0o600 });
    const db = new DatabaseSync(path);
    try {
      db.exec(`
        CREATE TABLE workspaces (id TEXT PRIMARY KEY, data TEXT NOT NULL, active INTEGER NOT NULL) STRICT;
        CREATE TABLE images (
          workspace_id TEXT NOT NULL, item_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
          mime_type TEXT NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY (workspace_id, item_id, ordinal)
        ) STRICT;
        PRAGMA user_version = 1;
      `);
      db.prepare("INSERT INTO workspaces VALUES (?, ?, ?)").run(workspace.id, JSON.stringify({
        items: [{ id: itemId, number: 7, text: "Original task", status: "inbox", detail: "", images: 1 }],
        batch: null, annotations: [],
      }), 0);
      db.prepare("INSERT INTO images VALUES (?, ?, ?, ?, ?)").run(workspace.id, itemId, 1, "image/png", png);
    } finally {
      db.close();
    }
  });
  const scope = { workspaceId: workspace.id, itemId };
  const original = await f.inbox.readItem(scope);
  assert.equal(original.status, "ready");
  assert.equal(original.item.version, 1);
  assert.deepEqual(await f.inbox.readImageChunk({
    ...scope, version: original.item.version, imageId: original.images[0].id, offset: 0,
  }), { data: png.toString("base64") });
  const draft = { workspaceId: workspace.id, draftId: "edit" };
  const newImage = await stageImage(f.inbox, { ...draft, imageId: "new" }, capturePng);
  const request = {
    ...draft, operationId: "edit", target: { itemId, version: original.item.version }, text: "Edited task",
    images: [newImage, { kind: "existing" as const, imageId: original.images[0].id }],
  };
  const [edited, concurrent] = await Promise.all([
    f.inbox.saveItem(request), f.inbox.saveItem({ ...request, operationId: "edit-two", text: "Concurrent edit" }),
  ]);
  assert.equal(edited.status, "saved");
  assert.deepEqual(concurrent, { status: "stale", item: edited.item });
  assert.equal(edited.item.number, 7);
  assert.equal(edited.item.version, 2);
  await f.restart();
  const latest = await f.inbox.readItem(scope);
  assert.equal(latest.status, "ready");
  assert.equal(latest.images[1].id, original.images[0].id);
  assert.deepEqual(await Promise.all(latest.images.map(({ id }) =>
    f.inbox.readImageChunk({ ...scope, version: latest.item.version, imageId: id, offset: 0 }))),
  [capturePng, png].map((bytes) => ({ data: bytes.toString("base64") })));
  assert.deepEqual(await f.inbox.deleteItem({ ...scope, version: 1 }), { status: "stale", item: latest.item });
  assert.deepEqual(await f.inbox.deleteItem({ ...scope, version: latest.item.version }), { status: "deleted" });
  const database = new DatabaseSync(join(f.dir, "inbox.sqlite3"));
  try {
    assert.equal(database.prepare("SELECT count(*) AS count FROM images").get()?.count, 0);
  } finally {
    database.close();
  }
  await f.restart();
  await f.inbox.add(workspace.id, "Next task");
  const [next] = (await f.inbox.view(workspace.id)).items;
  assert.equal(next.number, 8);
  assert.deepEqual(await f.inbox.saveItem(request), edited);
  assert.deepEqual((await f.inbox.view(workspace.id)).items, [next]);
});

test("a legacy attachment invalidates a draft and Start claims the unchanged text and ordered bytes", async (t) => {
  const f = await fixture(t);
  await f.inbox.add(workspace.id, "Original task");
  const [item] = (await f.inbox.view(workspace.id)).items;
  const scope = { workspaceId: workspace.id, itemId: item.id };
  const request = {
    workspaceId: workspace.id, draftId: "draft", operationId: "edit",
    target: { itemId: item.id, version: item.version }, text: "Edited text", images: [],
  };
  await f.inbox.attach(workspace.id, item.id, "image/png", capturePng);
  const stale = await f.inbox.saveItem(request);
  assert.equal(stale.status, "stale");
  assert.equal(stale.item.version, item.version + 1);
  const snapshot = await f.inbox.readItem(scope);
  assert.equal(snapshot.status, "ready");
  let release: () => void = () => {};
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const getWorkspace = f.host.workspace;
  let remaining = 2;
  f.host.workspace = async (id) => {
    if (remaining-- > 0) await waiting;
    return getWorkspace(id);
  };
  const version = snapshot.item.version;
  const edit = f.inbox.saveItem({ ...request, target: { itemId: item.id, version } });
  const remove = f.inbox.deleteItem({ ...scope, version });
  try {
    await f.inbox.start(workspace.id, agent.id, [item.id]);
  } finally {
    release();
  }
  const [rejectedEdit, rejectedDelete] = await Promise.all([edit, remove]);
  assert.equal(rejectedEdit.status, "claimed");
  assert.deepEqual(rejectedDelete, rejectedEdit);
  assert.equal(rejectedEdit.item.chatId, agent.id);
  await assert.rejects(f.inbox.attach(workspace.id, item.id, "image/png", capturePng), /inbox/);
  await assert.rejects(f.inbox.readImageChunk({ ...scope, version, imageId: snapshot.images[0].id, offset: 0 }), /changed/);
  await f.inbox.tick();
  assert.match(f.state.sent[0].text, /Original task/);
  assert.doesNotMatch(f.state.sent[0].text, /Edited text/);
  assert.deepEqual(f.state.sent[0].images, [{ data: capturePng.toString("base64"), mimeType: "image/png" }]);
});

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

test("an explicit effort must still belong to the selected model before chat creation", async (t) => {
  const f = await fixture(t);
  let thinkingOptions = [{ id: "high", label: "High" }];
  let catalogUnavailable = false;
  f.host.agentModels = async () => {
    if (catalogUnavailable) throw new Error("Provider catalog connection lost");
    return [{ value: "codex/demo", label: "Codex · Demo", thinkingOptions }];
  };
  let created = false;
  f.host.createAgent = async () => { created = true; };
  await f.inbox.add(workspace.id, "Fix export");
  const [item] = (await f.inbox.view(workspace.id)).items;

  await assert.rejects(f.inbox.startNew(workspace.id, [item.id], "codex/demo", "max"), /effort is unavailable/);
  assert.equal((await f.inbox.view(workspace.id)).batch, null);

  await f.inbox.startNew(workspace.id, [item.id], "codex/demo", "high");
  catalogUnavailable = true;
  await f.inbox.tick();
  const waiting = await f.inbox.view(workspace.id);
  assert.equal(waiting.canStart, false);
  assert.equal(waiting.items[0].status, "queued");
  assert.match(waiting.batch!.detail, /will try again/);
  assert.equal(created, false);

  catalogUnavailable = false;
  thinkingOptions = [];
  await f.inbox.tick();
  const view = await f.inbox.view(workspace.id);
  assert.equal(view.canStart, true);
  assert.equal(view.items[0].status, "inbox");
  assert.equal(view.items[0].chatId, undefined);
  assert.match(view.batch!.detail, /effort is unavailable/);
  assert.equal(created, false);
});

test("unconfirmed creation retries with the reserved identity and leaves the reports blocked", async (t) => {
  const f = await fixture(t);
  const attempts: Parameters<InboxHost["createAgent"]>[1][] = [];
  f.host.agentModels = async () => [{
    value: "codex/demo", label: "Codex · Demo", thinkingOptions: [{ id: "high", label: "High" }],
  }];
  f.host.createAgent = async (_workspace, request) => {
    attempts.push(request);
    throw new Error("creation reply was lost");
  };
  await f.inbox.add(workspace.id, "Fix search");
  const [item] = (await f.inbox.view(workspace.id)).items;
  await f.inbox.startNew(workspace.id, [item.id], "codex/demo", "high");
  await f.inbox.tick();
  f.state.clock += 60_000;
  await f.restart();
  for (let tick = 0; tick < 3; tick++) {
    await f.inbox.tick();
    f.state.clock += 60_000;
  }
  const view = await f.inbox.view(workspace.id);
  assert.deepEqual(attempts, Array.from({ length: 3 }, () => ({
    agentId: view.batch!.agentId, batchId: view.batch!.id, model: "codex/demo", thinkingOptionId: "high",
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
  assert.deepEqual(agents.map(({ dispatchStatus }) => dispatchStatus), ["ready", "ready"]);
  f.state.agent = { ...agent, status: "running" };
  assert.equal((await f.inbox.view(workspace.id)).agents[0].dispatchStatus, "busy");
  f.state.agent = { ...agent, pendingPermission: true };
  assert.equal((await f.inbox.view(workspace.id)).agents[0].dispatchStatus, "needs-attention");
  f.state.agent = agent;
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
