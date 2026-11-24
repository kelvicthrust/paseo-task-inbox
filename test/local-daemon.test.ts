import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { localDaemonTarget } from '../server/local-daemon.ts';

test('restart recovery uses only its own local Paseo listener and identity', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'task-inbox-daemon-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const identity = join(home, 'server-id');
  const record = join(home, 'paseo.pid');
  const uid = process.getuid!();
  await writeFile(identity, 'local-test-server\n', { mode: 0o600 });
  const lock = (listen: string, serverId = 'local-test-server', lockUid = uid) =>
    writeFile(record, JSON.stringify({ pid: process.pid, uid: lockUid, listen, serverId }));

  await lock('localhost:6767');
  assert.deepEqual(await localDaemonTarget(home), { listen: '127.0.0.1:6767', serverId: 'local-test-server' });
  await lock('[::1]:6767');
  assert.equal((await localDaemonTarget(home)).listen, '[::1]:6767');

  for (const foreign of ['0.0.0.0:6767', '8.8.8.8:6767', 'loader.example.net:6767', '127.0.0.1:90000']) {
    await lock(foreign);
    await assert.rejects(localDaemonTarget(home), /local Paseo daemon/);
  }
  await lock('127.0.0.1:6767', 'another-server');
  await assert.rejects(localDaemonTarget(home), /local Paseo daemon/);
  await lock('127.0.0.1:6767', 'local-test-server', uid + 1);
  await assert.rejects(localDaemonTarget(home), /local Paseo daemon/);

  await lock('127.0.0.1:6767');
  await rm(identity);
  const otherIdentity = join(home, 'alternate-id');
  await writeFile(otherIdentity, 'local-test-server\n', { mode: 0o600 });
  await symlink(otherIdentity, identity);
  await assert.rejects(localDaemonTarget(home), { code: 'ELOOP' });
});
