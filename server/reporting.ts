import { z } from "zod";
import type { TimelineEntry } from "./inbox-types.ts";
import type { Batch, Item } from "./storage.ts";

const prefix = "PASEO_TASK_INBOX_V1 ";
export const prEvidencePrefix = "PASEO_TASK_INBOX_FIX_V1";
const fields = {
  batchId: z.uuid(),
  itemId: z.uuid(),
  detail: z.string().trim().min(1).max(1000),
};
const reportSchema = z.discriminatedUnion("status", [
  z.strictObject({ ...fields, status: z.enum(["working", "blocked"]) }),
  z.strictObject({
    ...fields,
    status: z.literal("completed"),
    verification: z.strictObject({
      check: z.string().trim().min(1).max(300),
      observed: z.string().trim().min(1).max(300),
      status: z.literal("passed"),
    }),
    url: z.string().max(300),
    revision: z.string().regex(/^[a-f\d]{40}$/),
  }),
]);

export function formatPrompt(batchId: string, items: Item[]): string {
  let imageNumber = 0;
  const bugs = items.map(({ id, number, text, images }) => ({
    id,
    number,
    description: text,
    images: Array.from({ length: images }, () => ++imageNumber),
  }));
  return [
    `Work through Paseo Task Inbox batch ${batchId} in this existing chat.`,
    "Follow this repository’s instructions and the normal review and verification process. Publish each fix in an open, ready-for-review pull request against the workspace repository. Leave merging to the owner.",
    "Identify which bugs each pull request fixes. Resolve or report every bug independently. The JSON below contains bug descriptions and the 1-based positions of their attached images.",
    `In each pull request body, include one standalone line per fixed bug in this exact format: ${prEvidencePrefix} ${batchId} <bug ID> <full lowercase commit SHA containing that bug’s fix>. The fix commit must be in the current PR commit list. Publish the PR body before reporting completion here.`,
    "Report each bug using a single standalone line in one of these exact forms. Use the supplied IDs, concise detail, and the full 40-character lowercase pull request head commit SHA. Use plain text around the lines if needed. The plugin reads these lines from your replies in this turn.",
    `${prefix}${JSON.stringify({ batchId, itemId: "<bug ID>", status: "working", detail: "<progress>" })}`,
    `${prefix}${JSON.stringify({ batchId, itemId: "<bug ID>", status: "blocked", detail: "<specific blocker>" })}`,
    "For completion, supply the specific test command or manual interaction you performed at the reported revision and the observed passing result for this bug. Report a blocker when a required check fails or cannot run.",
    `${prefix}${JSON.stringify({
      batchId, itemId: "<bug ID>", status: "completed", detail: "<what changed>",
      verification: { check: "<check performed>", observed: "<passing result>", status: "passed" },
      url: "https://github.com/owner/repo/pull/123", revision: "<full pull request head SHA>",
    })}`,
    JSON.stringify(bugs, null, 2),
  ].join("\n\n");
}

function applyReport(line: string, batch: Batch, items: Item[]) {
  if (!line.startsWith(prefix) || line.length > 4096) return;
  let body: unknown;
  try {
    body = JSON.parse(line.slice(prefix.length));
  } catch {
    return;
  }
  const report = reportSchema.safeParse(body);
  if (!report.success || report.data.batchId !== batch.id) return;
  const { data } = report;
  if (!batch.itemIds.includes(data.itemId)) return;
  const item = items.find(({ id }) => id === data.itemId);
  if (item?.status !== "working" || item.candidate) return;
  if (data.status === "completed") {
    item.candidate = {
      url: data.url, revision: data.revision, batchId: data.batchId, itemId: data.itemId,
      detail: `${data.detail} Check: ${data.verification.check}. Observed: ${data.verification.observed}`,
      attempts: 0, retryAt: 0,
    };
    item.detail = "Verifying the reported pull request.";
  } else {
    item.status = data.status;
    item.detail = data.detail;
  }
}

export function flushAssistant(batch: Batch, items: Item[]) {
  if (batch.assistant && !batch.assistant.overflow) applyReport(batch.assistant.line, batch, items);
  batch.assistant = null;
}

function readAssistant(
  batch: Batch, items: Item[], row: Extract<TimelineEntry, { type: "assistant_message" }>,
) {
  if (batch.assistant && row.messageId !== undefined && row.messageId !== batch.assistant.messageId) {
    flushAssistant(batch, items);
  }
  const assistant = batch.assistant ??= { messageId: row.messageId, line: "", overflow: false };
  const lines = row.text.split("\n");
  for (const [index, line] of lines.entries()) {
    if (!assistant.overflow) {
      if (assistant.line.length + line.length > 4096) {
        assistant.overflow = true;
        assistant.line = "";
      } else {
        assistant.line += line;
      }
    }
    if (index < lines.length - 1) {
      if (!assistant.overflow) applyReport(assistant.line, batch, items);
      assistant.line = "";
      assistant.overflow = false;
    }
  }
}

export function readTimeline(batch: Batch, items: Item[], rows: TimelineEntry[]) {
  for (const row of rows) {
    if (row.type === "user_message" && row.clientMessageId === batch.messageId && row.turnId) {
      if (!batch.turnId) {
        batch.turnId = row.turnId;
        batch.phase = "sent";
        batch.status = "working";
        batch.detail = "Work is underway in the selected chat.";
        for (const item of items) {
          if (item.status === "queued" && batch.itemIds.includes(item.id)) {
            item.status = "working";
            item.detail = batch.detail;
          }
        }
      }
      continue;
    }
    if (batch.assistant && (row.type !== "assistant_message" || row.turnId !== batch.turnId)) {
      flushAssistant(batch, items);
    }
    if (!batch.turnId || row.turnId !== batch.turnId || batch.interrupted) continue;
    if (row.type === "user_message") batch.interrupted = true;
    if (row.type === "assistant_message") readAssistant(batch, items, row);
  }
}
