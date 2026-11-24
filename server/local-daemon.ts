import { randomUUID } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { createHostClient } from '@getpaseo/client/node';
import { z } from 'zod';
import { wakeInbox } from '../shared/rpc.ts';

const unavailable = () => new Error('Task Inbox cannot reconnect to its local Paseo daemon.');
const daemonLock = z.object({
  pid: z.int().positive(),
  uid: z.int().nonnegative(),
  listen: z.string(),
  serverId: z.string().trim().min(1).max(128),
});
const tcpLoopback = /^(127\.0\.0\.1|localhost|\[::1\]):([1-9][0-9]{0,4})$/;
const credentialPattern = /^[A-Za-z0-9_-]{43}$/;

export function paseoHome() {
  const configured = process.env.PASEO_HOME;
  if (configured === '~') return homedir();
  return resolve(configured?.replace(/^~\//, homedir() + '/') || join(homedir(), '.paseo'));
}

async function ownedFile(path: string, uid: number, maxBytes: number, privateFile = false) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== uid || stat.size > maxBytes ||
      (stat.mode & (privateFile ? 0o077 : 0o022))) {
      throw unavailable();
    }
    return (await file.readFile('utf8')).trim();
  } finally {
    await file.close();
  }
}

export async function localDaemonTarget(home: string): Promise<{ listen: string; serverId: string }> {
  const uid = process.getuid?.();
  const root = await lstat(home);
  if (uid === undefined || !root.isDirectory() || root.uid !== uid || (root.mode & 0o022)) throw unavailable();

  const lock = daemonLock.parse(JSON.parse(await ownedFile(join(home, 'paseo.pid'), uid, 4_096)));
  const serverId = await ownedFile(join(home, 'server-id'), uid, 256, true);
  if (lock.uid !== uid || lock.serverId !== serverId) throw unavailable();
  process.kill(lock.pid, 0);

  const tcp = tcpLoopback.exec(lock.listen);
  if (tcp && Number(tcp[2]) <= 65535) {
    return { listen: `${tcp[1] === 'localhost' ? '127.0.0.1' : tcp[1]}:${tcp[2]}`, serverId };
  }
  const socketPath = lock.listen.startsWith('unix://') ? lock.listen.slice(7) : lock.listen;
  if (isAbsolute(socketPath) && !/[:?#%\u0000-\u0020]/.test(socketPath)) {
    const socket = await lstat(socketPath);
    if (socket.isSocket() && socket.uid === uid && !(socket.mode & 0o022)) {
      return { listen: `unix://${socketPath}`, serverId };
    }
  }
  throw unavailable();
}

export async function wakeLocalInbox(home: string) {
  try {
    const { listen, serverId } = await localDaemonTarget(home);
    const uid = process.getuid!();
    // Follow Paseo CLI's same-home local credential flow after authenticating the listener metadata.
    const token = await ownedFile(join(home, 'local-credential'), uid, 256, true).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    if (token && !credentialPattern.test(token)) throw unavailable();
    const client = createHostClient(listen, {
      appVersion: '0.16.1',
      clientId: `task-inbox-${randomUUID()}`,
      clientType: 'cli',
      localCredential: token ? () => token : undefined,
      connectTimeoutMs: 2_500,
      reconnect: { enabled: false },
    });
    try {
      await client.connect();
      if (client.getLastServerInfoMessage()?.serverId !== serverId) throw unavailable();
      // The daemon gives its real plugin API to this RPC handler. The temporary
      // CLI connection only wakes that handler and never acts on a workspace.
      wakeInbox.output.parse(await client.invokePluginRpc('task-inbox', wakeInbox.name, {}));
    } finally {
      await client.close();
    }
  } catch {
    // Details from the SDK or credential filesystem stay out of plugin logs and RPC results.
    throw unavailable();
  }
}
