import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';

export const maxItemText = 8_000;
export const maxBatchItems = 20;
export const maxItemScreenshots = 4;

const id = z.string().min(1).max(255);
const workspaceId = z.strictObject({ workspaceId: id });
const status = z.enum(['inbox', 'queued', 'working', 'blocked', 'completed']);
const workspace = z.object({ id, label: z.string() });
const agent = z.object({ id, label: z.string(), provider: z.string() });
const item = z.object({
  id,
  number: z.int().positive(),
  text: z.string(),
  status,
  images: z.int().nonnegative(),
  detail: z.string(),
  prUrl: z.string().optional(),
});
const batch = z.object({
  id,
  agentId: id,
  status: status.exclude(['inbox']),
  detail: z.string(),
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

export type Workspace = z.output<typeof workspace>;
export type InboxView = z.output<typeof view>;
export type InboxItemView = z.output<typeof item>;
export type InboxBadge = z.output<typeof badge>;

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

export const readInboxBadge = defineRpc({
  name: 'inbox.badge',
  input: workspaceId,
  output: badge,
});

export const addInboxItem = defineRpc({
  name: 'inbox.add',
  input: workspaceId.extend({ text: z.string().trim().min(1).max(maxItemText) }),
  output: ack,
});

export const startInboxBatch = defineRpc({
  name: 'inbox.start',
  input: workspaceId.extend({ agentId: id, itemIds: z.array(id).min(1).max(maxBatchItems) }),
  output: ack,
});

export const issueUploadLink = defineRpc({
  name: 'inbox.screenshot',
  input: workspaceId.extend({ itemId: id, allowLoopback: z.boolean() }),
  output: z.object({ url: z.string() }),
});
