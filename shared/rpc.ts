import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';
import { liveOutcomeItem, pullRequestStatus } from './outcome.ts';
import { screenshotLimit } from './screenshot.ts';

export const maxItemText = 8_000;
export const maxBatchItems = 20;
export const maxItemScreenshots = 4;
export const inboxImageChunkBytes = 128 * 1024;
const maxEncodedChunk = 4 * Math.ceil(inboxImageChunkBytes / 3);

const id = z.string().min(1).max(255);
const workspaceId = z.strictObject({ workspaceId: id });
const itemTarget = workspaceId.extend({ itemId: id });
const draft = workspaceId.extend({ draftId: id });
const stagedImage = draft.extend({ imageId: id });
const mimeType = z.enum(['image/png', 'image/jpeg']);
const version = z.int().positive();
const offset = z.int().min(0).max(screenshotLimit - 1);
const chunk = z.string().min(4).max(maxEncodedChunk);
const imageSize = z.int().min(1).max(screenshotLimit);
const description = z.string().trim().min(1).max(maxItemText);
const status = z.enum(['inbox', 'queued', 'working', 'blocked', 'completed']);
const workspace = z.object({ id, label: z.string() });
const agent = z.object({
  id,
  label: z.string(),
  provider: z.string(),
  dispatchStatus: z.enum(['ready', 'busy', 'needs-attention']).optional(),
});
const agentModel = z.object({
  value: z.string(),
  label: z.string(),
  thinkingOptions: z.array(z.object({ id, label: z.string() })).optional(),
});
export type InboxAgentModel = z.infer<typeof agentModel>;
const item = z.object({
  id,
  number: z.int().positive(),
  text: z.string(),
  status,
  images: z.int().nonnegative(),
  version,
  detail: z.string(),
  prUrl: z.string().optional(),
  prState: pullRequestStatus.optional(),
  chatId: id.optional(),
});
const batch = z.object({
  id,
  agentId: id,
  status: status.exclude(['inbox']),
  detail: z.string(),
  prState: pullRequestStatus.optional(),
});
const view = z.object({
  agentId: id.nullable(),
  agents: z.array(agent),
  items: z.array(item),
  batch: batch.nullable(),
  canStart: z.boolean(),
});
const ack = z.strictObject({});
const badge = z.object({
  count: z.int().nonnegative(),
  status: status.nullable(),
});
const claimed = z.object({ status: z.literal('claimed'), item });
const stale = z.object({ status: z.literal('stale'), item });
const missing = z.object({ status: z.literal('missing') });
const storedImage = z.object({ id, mimeType, size: imageSize });
const imageReference = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('existing'), imageId: id }),
  z.strictObject({ kind: z.literal('staged'), imageId: id, grant: id }),
]);
const saveInput = draft.extend({
  operationId: id,
  text: description,
  target: z.strictObject({ itemId: id, version }).optional(),
  images: z.array(imageReference).max(maxItemScreenshots),
});

export type Workspace = z.output<typeof workspace>;
export type InboxView = z.output<typeof view>;
export type InboxItemView = z.output<typeof item>;
export type InboxBadge = z.output<typeof badge>;
export type SaveInboxItemInput = z.output<typeof saveInput>;

export const wakeInbox = defineRpc({
  name: 'inbox.wake',
  input: ack,
  output: ack,
});

export const listWorkspaces = defineRpc({
  name: 'inbox.workspaces',
  input: ack,
  output: z.array(workspace),
});

export const readInbox = defineRpc({
  name: 'inbox.read',
  input: workspaceId,
  output: view,
});

export const readBatchOutcome = defineRpc({
  name: 'inbox.read-batch-outcome',
  input: z.strictObject({ agentId: id, batchId: z.uuid() }),
  output: z.array(liveOutcomeItem).max(maxBatchItems).nullable(),
});

export const readInboxBadge = defineRpc({
  name: 'inbox.badge',
  input: workspaceId,
  output: badge,
});

export const addInboxItem = defineRpc({
  name: 'inbox.add',
  input: workspaceId.extend({ text: description }),
  output: ack,
});

export const readInboxItem = defineRpc({
  name: 'inbox.read-item',
  input: itemTarget,
  output: z.discriminatedUnion('status', [
    z.object({ status: z.literal('ready'), item, images: z.array(storedImage).max(maxItemScreenshots) }),
    claimed,
    missing,
  ]),
});

export const readInboxImageChunk = defineRpc({
  name: 'inbox.read-image-chunk',
  input: itemTarget.extend({ version, imageId: id, offset }),
  output: z.object({ data: chunk }),
});

export const beginInboxImage = defineRpc({
  name: 'inbox.begin-image',
  input: stagedImage.extend({ mimeType, size: imageSize }),
  output: z.object({ grant: id, received: z.int().min(0).max(screenshotLimit) }),
});

export const appendInboxImageChunk = defineRpc({
  name: 'inbox.append-image-chunk',
  input: stagedImage.extend({ grant: id, offset, data: chunk }),
  output: z.object({ received: z.int().min(0).max(screenshotLimit) }),
});

export const discardInboxImages = defineRpc({
  name: 'inbox.discard-images',
  input: draft.extend({ imageId: id.optional() }),
  output: ack,
});

export const saveInboxItem = defineRpc({
  name: 'inbox.save-item',
  input: saveInput,
  output: z.discriminatedUnion('status', [
    z.object({ status: z.literal('saved'), item }),
    z.object({ status: z.literal('upload-expired'), imageId: id }),
    stale,
    claimed,
    missing,
  ]),
});

export const deleteInboxItem = defineRpc({
  name: 'inbox.delete-item',
  input: itemTarget.extend({ version }),
  output: z.discriminatedUnion('status', [
    z.object({ status: z.literal('deleted') }),
    stale,
    claimed,
    missing,
  ]),
});

export const startInboxBatch = defineRpc({
  name: 'inbox.start',
  input: workspaceId.extend({ agentId: id, itemIds: z.array(id).min(1).max(maxBatchItems) }),
  output: ack,
});

export const listInboxAgentModels = defineRpc({
  name: 'inbox.agent-models',
  input: z.strictObject({ workspaceId: id.optional() }),
  output: z.array(agentModel),
});

export const startInboxBatchInNewChat = defineRpc({
  name: 'inbox.start-new',
  input: workspaceId.extend({
    itemIds: z.array(id).min(1).max(maxBatchItems),
    model: id.optional(),
    thinkingOptionId: id.optional(),
  }),
  output: ack,
});

export const issueUploadLink = defineRpc({
  name: 'inbox.screenshot',
  input: workspaceId.extend({ itemId: id, allowLoopback: z.boolean() }),
  output: z.object({ url: z.string() }),
});
