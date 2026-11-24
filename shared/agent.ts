import { defineSettings } from '@getpaseo/plugin';
import { z } from 'zod';

export const taskInboxProviders = { codex: 'Codex', claude: 'Claude Code' };
export const taskInboxAgentSettings = defineSettings({
  id: 'task-inbox-agent',
  scope: 'host',
  version: 1,
  schema: z.object({
    model: z.string().max(255).regex(/^(?:(?:codex|claude)\/[^\s]+)?$/).default(''),
  }),
});
