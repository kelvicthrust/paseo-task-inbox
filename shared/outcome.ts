import { z } from "zod";

export const batchOutcomeKind = "batch-outcome";
export const batchOutcomeVersion = 1;
export const pullRequestStatus = z.enum(["draft", "open", "closed", "merged"]);
export type PullRequestStatus = z.output<typeof pullRequestStatus>;

const itemFields = { number: z.int().positive(), detail: z.string().max(500) };
const pullRequestUrl = z.string().regex(/^https:\/\/github\.com\/[a-z\d_.-]+\/[a-z\d_.-]+\/pull\/[1-9]\d*$/i);
export const batchOutcomeSchema = z.strictObject({
  batchId: z.uuid(),
  items: z.array(z.discriminatedUnion("status", [
    z.strictObject({ ...itemFields, status: z.literal("blocked") }),
    z.strictObject({
      ...itemFields,
      status: z.literal("completed"),
      prUrl: pullRequestUrl,
    }),
  ])).min(1).max(20),
});
export type BatchOutcome = z.infer<typeof batchOutcomeSchema>;

export const liveOutcomeItem = z.object({
  ...itemFields,
  detail: z.string(),
  status: z.enum(["queued", "working", "blocked", "completed"]),
  prUrl: pullRequestUrl.optional(),
  prState: pullRequestStatus.optional(),
});
