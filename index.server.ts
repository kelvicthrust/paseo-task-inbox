import { join } from 'node:path';
import type { PluginHandlerContext, PluginServerContext } from '@getpaseo/plugin/server';
import { createInbox, hasUnfinishedBatches } from './server/inbox.ts';
import { paseoHome, wakeLocalInbox } from './server/local-daemon.ts';
import { createScreenshotUpload } from './server/upload.ts';
import {
  addInboxItem,
  issueUploadLink,
  listWorkspaces,
  maxItemScreenshots,
  readInbox,
  readInboxBadge,
  startInboxBatch,
  wakeInbox,
} from './shared/rpc.ts';
import { screenshotSettings } from './shared/screenshot.ts';

const tickInterval = 3_000;
type Paseo = PluginHandlerContext['paseo'];

export default function contribute(server: PluginServerContext) {
  const home = paseoHome();
  const dataDir = join(home, 'plugin-data', 'task-inbox');
  const settings = server.registerSettings(screenshotSettings);
  let inbox: ReturnType<typeof createInbox> | undefined;
  let native: Paseo | undefined;
  let drive: Promise<void> | undefined;
  let stopped = false;
  let tickFailed = false;

  function service(paseo: Paseo) {
    if (stopped) throw new Error('Task Inbox is stopping.');
    inbox ??= createInbox(paseo, dataDir).catch((error) => {
      inbox = undefined;
      throw error;
    });
    return inbox;
  }

  function withContext(paseo: Paseo) {
    native = paseo;
    return service(paseo);
  }

  const uploads = createScreenshotUpload(async (workspaceId, itemId, mime, bytes) => {
    if (!inbox) throw new Error('Task Inbox is unavailable.');
    await (await inbox).attach(workspaceId, itemId, mime, bytes);
  });

  function applySettings(value: Awaited<ReturnType<typeof settings.read>>) {
    uploads.configure(value.status === 'ready' ? value.values.privateOrigin : '');
  }

  const stopSettings = settings.subscribe(applySettings);

  async function tick() {
    if (stopped) return;
    if (!inbox && await hasUnfinishedBatches(dataDir)) {
      if (!native && !inbox && !stopped) await wakeLocalInbox(home);
      if (native && !inbox && !stopped) await service(native);
    }
    if (!stopped && inbox) await (await inbox).tick();
  }

  function wake() {
    if (stopped || drive) return;
    drive = tick().then(
      () => { tickFailed = false; },
      () => {
        if (!tickFailed) console.warn('[task-inbox] Background processing is waiting for the local Paseo daemon or inbox store.');
        tickFailed = true;
      },
    ).finally(() => { drive = undefined; });
  }

  server.handle(wakeInbox, (_, { paseo }) => {
    native = paseo;
    wake();
    return {};
  });
  server.handle(listWorkspaces, async (_, { paseo }) => (await withContext(paseo)).workspaces());
  server.handle(readInbox, async ({ workspaceId }, { paseo }) => (await withContext(paseo)).view(workspaceId));
  server.handle(readInboxBadge, async ({ workspaceId }, { paseo }) => (await withContext(paseo)).badge(workspaceId));
  server.handle(addInboxItem, async ({ workspaceId, text }, { paseo }) => {
    await (await withContext(paseo)).add(workspaceId, text);
    return {};
  });
  server.handle(startInboxBatch, async ({ workspaceId, agentId, itemIds }, { paseo }) => {
    await (await withContext(paseo)).start(workspaceId, agentId, itemIds);
    wake();
    return {};
  });
  server.handle(issueUploadLink, async ({ workspaceId, itemId, allowLoopback }, { paseo }) => {
    const current = await (await withContext(paseo)).view(workspaceId);
    const item = current.items.find(({ id }) => id === itemId);
    if (!item || item.status !== 'inbox') throw new Error('Screenshots can only be attached to bugs waiting in the inbox.');
    if (item.images >= maxItemScreenshots) throw new Error('This bug already has four screenshots.');
    const state = await settings.read();
    applySettings(state);
    if (state.status !== 'ready') throw new Error('Repair the screenshot address in Task Inbox settings.');
    return uploads.grant({ workspaceId, itemId }, allowLoopback);
  });

  const stops = [
    server.addHook('agent.turn.after', async (_, { paseo }) => { native = paseo; wake(); }),
    server.addHook('agent.permission.before', async (_, { paseo }) => { native = paseo; wake(); }),
    server.addHook('agent.permission.after', async (_, { paseo }) => { native = paseo; wake(); }),
  ];
  const timer = setInterval(wake, tickInterval);
  wake();

  return async () => {
    stopped = true;
    clearInterval(timer);
    for (const stop of stops) stop();
    await stopSettings();
    await uploads.close();
    await drive;
    await (await inbox)?.close();
  };
}
