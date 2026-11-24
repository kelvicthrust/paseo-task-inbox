import { readFileSync } from 'node:fs';
import { URL } from 'node:url';

export const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function compareStableVersions(left: string, right: string): number {
  const rightParts = right.split('.');
  for (const [index, part] of left.split('.').entries()) {
    const a = BigInt(part);
    const b = BigInt(rightParts[index]!);
    if (a !== b) return a > b ? 1 : -1;
  }
  return 0;
}

export function selectReleaseVersion(version: unknown, previous?: string): string {
  if (typeof version !== 'string' || !stableVersion.test(version)) {
    throw new Error('Release builds require a stable X.Y.Z package version.');
  }
  if (previous === undefined) return version;
  if (!stableVersion.test(previous)) {
    throw new Error('The previous package version must be stable X.Y.Z.');
  }
  const change = compareStableVersions(version, previous);
  if (change < 0) throw new Error(`Package version ${version} must be newer than ${previous}.`);
  return change > 0 ? version : '';
}

if (import.meta.main) {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const version = selectReleaseVersion(manifest.version, process.argv[2]);
  if (version) console.log(version);
}
