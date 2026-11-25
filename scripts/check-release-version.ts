import { existsSync, readFileSync } from 'node:fs';
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
  const previous = process.argv[2];
  const finalize = previous === '--finalize';
  const version = selectReleaseVersion(manifest.version, finalize ? undefined : previous);
  if (!version) process.exit(0);
  if (previous !== undefined) {
    const path = `docs/releases/v${version}.md`;
    const notes = new URL(`../${path}`, import.meta.url);
    const heading = `# What's new in v${version}`;
    if (!existsSync(notes)) {
      throw new Error(`Create ${path} before releasing v${version}.`);
    }
    const [firstLine, ...body] = readFileSync(notes, 'utf8').trim().split(/\r?\n/);
    if (firstLine !== heading || !body.some((line) => line.trim() !== '')) {
      throw new Error(`${path} needs the heading "${heading}" and release notes below it.`);
    }
  }
  console.log(version);
}
