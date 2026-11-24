import assert from "node:assert/strict";
import test from "node:test";
import { createPullRequestVerifier, githubOrigin } from "../server/github.ts";

const workspace = { id: "workspace-id", label: "Project", directory: "/worktree" };
const repository = "example/project";
const revision = "0123456789abcdef0123456789abcdef01234567";
const url = "https://github.com/Example/Project/pull/12";
const fixRevision = "23456789abcdef0123456789abcdef0123456789";
const batchId = "e99fd0b4-f362-4d57-b3ba-c90d664c204d";
const itemId = "764e8a02-52c1-48b7-a811-15659cfab99c";
const body = `PASEO_TASK_INBOX_FIX_V1 ${batchId} ${itemId} ${fixRevision}`;
const current = {
  number: 12, url, state: "OPEN", isDraft: false, headRefOid: revision,
  body, commits: [{ oid: fixRevision }, { oid: revision }],
};
const report = { workspace, repository, url, revision, batchId, itemId };

test("reads only supported GitHub origins and strips case and the transport suffix", () => {
  assert.equal(githubOrigin("https://github.com/Example/Project.git\n"), repository);
  assert.equal(githubOrigin("git@github.com:example/project"), repository);
  assert.equal(githubOrigin("ssh://git@github.com/example/project.git"), repository);
  assert.equal(githubOrigin("https://github.com.example.test/example/project"), null);
  assert.equal(githubOrigin("https://api-key@github.com/example/project"), null);
});

test("checks the exact open ready PR head in the selected origin and preserves its canonical URL", async () => {
  const requests: string[][] = [];
  const verify = createPullRequestVerifier(async () => repository, async (...input) => {
    requests.push(input);
    return current;
  });
  assert.deepEqual(await verify(report), { status: "verified", url, revision, fixRevision });
  assert.deepEqual(requests, [[repository, "12"]]);
  for (const offsite of [
    "https://example.test/Example/Project/pull/12",
    "https://github.com/other/project/pull/12",
    `${url}?target=other`,
    "--help",
  ]) {
    assert.equal((await verify({ ...report, url: offsite })).status, "rejected");
  }
  assert.equal(requests.length, 1);
});

test("rejects changed origin, head, number, repository, draft and closed pull requests", async () => {
  const wrongOrigin = createPullRequestVerifier(async () => "changed/path", async () => assert.fail("Must not query GitHub"));
  assert.equal((await wrongOrigin(report)).status, "rejected");
  for (const overrides of [
    { headRefOid: "a".repeat(40) },
    { number: 13 },
    { url: "https://github.com/other/project/pull/12" },
    { isDraft: true },
    { state: "CLOSED" },
    { state: "MERGED" },
    { body: "" },
    { body: body.replace(itemId, "e998d0b4-f362-4d57-b3ba-c90d664c204d") },
    { commits: [{ oid: revision }] },
    { body: `${body}
${body}` },
  ]) {
    const reject = createPullRequestVerifier(async () => repository, async () => ({ ...current, ...overrides }));
    assert.equal((await reject(report)).status, "rejected");
  }
  const unavailable = createPullRequestVerifier(async () => repository, async () => {
    throw new Error("Connection unavailable");
  });
  assert.equal((await unavailable(report)).status, "retry");
});
