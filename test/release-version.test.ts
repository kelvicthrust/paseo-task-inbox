import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { selectReleaseVersion } from '../scripts/check-release-version.ts';

function runReleaseCheck(args: string[], notes?: string) {
  const root = mkdtempSync(join(tmpdir(), 'task-inbox-release-version-'));
  try {
    mkdirSync(join(root, 'scripts'));
    const script = join(root, 'scripts/check-release-version.ts');
    copyFileSync(join(import.meta.dirname, '../scripts/check-release-version.ts'), script);
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module', version: '1.1.0' }));
    if (notes !== undefined) {
      mkdirSync(join(root, 'docs/releases'), { recursive: true });
      writeFileSync(join(root, 'docs/releases/v1.1.0.md'), notes);
    }
    return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('selects the current stable version for a rehearsal', () => {
  assert.equal(selectReleaseVersion('0.1.0'), '0.1.0');
});

test('selects a release only after a numeric stable version increase', () => {
  assert.equal(selectReleaseVersion('1.10.0', '1.9.9'), '1.10.0');
  assert.equal(selectReleaseVersion('2.0.0', '1.10.0'), '2.0.0');
  assert.equal(selectReleaseVersion('1.10.0', '1.10.0'), '');
  assert.throws(() => selectReleaseVersion('1.9.9', '1.10.0'), /must be newer/);
});

test('rejects invalid package versions', () => {
  assert.throws(() => selectReleaseVersion('1.0.0-rc.1'), /stable X.Y.Z/);
  assert.throws(() => selectReleaseVersion('1.01.0'), /stable X.Y.Z/);
  assert.throws(() => selectReleaseVersion('1.0.0', '0.9.0-rc.1'), /stable X.Y.Z/);
});

test('allows rehearsals and unchanged versions without release notes', () => {
  for (const [args, output] of [[[], '1.1.0\n'], [['1.1.0'], '']] as const) {
    const result = runReleaseCheck([...args]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, output);
  }
});

test('requires versioned notes with a matching heading and body for publishing', () => {
  const valid = "# What's new in v1.1.0\n\n- Open Task Inbox from the Command Center.\n";
  for (const args of [['1.0.0'], ['--finalize']]) {
    for (const notes of [undefined, '', "# What's new in v1.1.0\n\n", valid.replace('1.1.0', '1.0.0')]) {
      const result = runReleaseCheck(args, notes);
      assert.equal(result.status, 1, result.stdout);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /docs\/releases\/v1\.1\.0\.md/);
    }
    const result = runReleaseCheck(args, valid);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '1.1.0\n');
  }
});
