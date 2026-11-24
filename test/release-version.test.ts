import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectReleaseVersion } from '../scripts/check-release-version.ts';

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
