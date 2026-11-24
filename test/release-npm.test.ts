import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';

const version = '0.1.0';
const archive = 'verified archive';
const integrity = 'sha512-' + createHash('sha512').update(archive).digest('base64');
const script = fileURLToPath(new URL('../scripts/publish-release-npm.ts', import.meta.url));

test('verifies locally published npm bytes without calling npm', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'task-inbox-publish-'));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  writeFileSync(join(directory, `kelvicthrust-paseo-task-inbox-${version}.tgz`), archive);

  function verify(versions: Record<string, { dist: { integrity: string } }>, download: string) {
    const metadata = { 'dist-tags': { latest: '0.0.9' }, versions };
    const mockRegistry = `
      globalThis.fetch = (url) => Promise.resolve(
        url.includes('?release-check=')
          ? Response.json(${JSON.stringify(metadata)})
          : new Response(${JSON.stringify(download)})
      );
    `;
    return spawnSync(process.execPath, [
      '--import', `data:text/javascript,${encodeURIComponent(mockRegistry)}`,
      script, version, directory, '--verify-only',
    ], { encoding: 'utf8', env: { ...process.env, PATH: '' } });
  }

  const versions = { [version]: { dist: { integrity } } };
  const verified = verify(versions, archive);
  assert.equal(verified.status, 0, verified.stderr);
  assert.match(verified.stdout, /Verified @kelvicthrust\/paseo-task-inbox@0\.1\.0/);

  const missing = verify({}, archive);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Complete local publication of that version first/);

  const different = verify(versions, 'different archive');
  assert.equal(different.status, 1);
  assert.match(different.stderr, /differs from the verified build/);
});
