import { defineSettings } from '@getpaseo/plugin';
import { z } from 'zod';

export const screenshotPath = '/task-inbox/screenshot';
export const screenshotPort = 47831;
export const screenshotLimit = 8 * 1024 * 1024;
export const screenshotGrantMs = 5 * 60_000;

export function privateUploadOrigin(value: string): string | null {
  const authority = /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ts\.net(?::([0-9]{1,5}))?\/?$/i;
  const match = authority.exec(value);
  if (!match || match[0] !== value) return null;
  const port = Number(match[1] ?? 443);
  return port >= 1 && port <= 65535 ? new URL(value).origin : null;
}

export const screenshotSettings = defineSettings({
  id: 'screenshot-upload',
  scope: 'host',
  version: 1,
  schema: z.object({
    privateOrigin: z.string().trim().refine(
      (value) => !value || privateUploadOrigin(value) !== null,
      'Enter an HTTPS Tailscale address with no path.',
    ).default(''),
  }),
});
