import { z } from "zod";

export const batchOutcomeKind = "batch-outcome";
export const batchOutcomeVersion = 1;

const itemFields = { number: z.int().positive(), detail: z.string().max(500) };
export const batchOutcomeSchema = z.strictObject({
  batchId: z.uuid(),
  items: z.array(z.discriminatedUnion("status", [
    z.strictObject({ ...itemFields, status: z.literal("blocked") }),
    z.strictObject({
      ...itemFields,
      status: z.literal("completed"),
      prUrl: z.string().regex(/^https:\/\/github\.com\/[a-z\d_.-]+\/[a-z\d_.-]+\/pull\/[1-9]\d*$/i),
    }),
  ])).min(1).max(20),
});
export type BatchOutcome = z.infer<typeof batchOutcomeSchema>;
