import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { compareStableVersions, stableVersion } from './check-release-version.ts';

const registry = 'https://registry.npmjs.org/';
const basename = 'paseo-task-inbox';
const name = `@kelvicthrust/${basename}`;
// React Native's ambient types omit the static timeout method available in Node.
const nodeAbortSignal = AbortSignal as typeof AbortSignal & {
  timeout(milliseconds: number): AbortSignal;
};
const [, , version, directory] = process.argv;
if (!version || !stableVersion.test(version) || !directory) {
  throw new Error('Usage: node scripts/publish-release-npm.ts <X.Y.Z> <release directory>');
}
const archive = resolve(directory, `kelvicthrust-${basename}-${version}.tgz`);
const expected = readFileSync(archive);
const integrity = 'sha512-' + createHash('sha512').update(expected).digest('base64');

interface RegistryMetadata {
  'dist-tags': { latest?: string };
  versions: Record<string, { dist: { integrity?: string } }>;
}

async function metadata(): Promise<RegistryMetadata> {
  const response = await fetch(
    `${registry}${encodeURIComponent(name)}?release-check=${Date.now()}`,
    {
      signal: nodeAbortSignal.timeout(15_000),
      headers: { accept: 'application/vnd.npm.install-v1+json', 'cache-control': 'no-cache' },
    },
  );
  if (response.status === 404) {
    throw new Error(`${name} is unavailable on npm. The initial package must exist before configuring its trusted publisher.`);
  }
  if (!response.ok) throw new Error(`Cannot read ${name} on npm (HTTP ${response.status}).`);
  return (await response.json()) as RegistryMetadata;
}

function checkLatest(data: RegistryMetadata, targetVersion: string): string | undefined {
  const latest = data['dist-tags'].latest;
  if (latest && (!stableVersion.test(latest) || compareStableVersions(latest, targetVersion) > 0)) {
    throw new Error(`${name}@${latest} is already latest. Refusing to promote ${targetVersion}.`);
  }
  return latest;
}

function npm(...args: string[]) {
  execFileSync('npm', [...args, `--registry=${registry}`], { stdio: 'inherit' });
}

const data = await metadata();
checkLatest(data, version);
const existing = data.versions[version];
if (existing) {
  if (existing.dist.integrity !== integrity) {
    throw new Error(`${name}@${version} already exists on npm with different bytes.`);
  }
} else {
  npm('publish', archive, '--ignore-scripts', '--access=public', '--tag=next');
}

// npm may accept the publish before its scan makes the tarball downloadable.
const downloadUrl = `${registry}${name}/-/${basename}-${version}.tgz`;
const deadline = Date.now() + 25 * 60_000;
while (true) {
  const response = await fetch(downloadUrl, {
    signal: nodeAbortSignal.timeout(30_000),
    headers: { 'cache-control': 'no-cache' },
  });
  if (response.ok) {
    const actual = Buffer.from(await response.arrayBuffer());
    if (!actual.equals(expected)) {
      throw new Error(`Downloaded ${name}@${version} differs from the verified build.`);
    }
    console.log(`Verified ${name}@${version} from npm.`);
    break;
  }
  if (response.status !== 404 || Date.now() >= deadline) {
    throw new Error(`Cannot download ${name}@${version} from npm (HTTP ${response.status}).`);
  }
  console.log(`Waiting for npm to make ${name}@${version} available.`);
  await delay(30_000);
}

if (checkLatest(await metadata(), version) !== version) {
  npm('dist-tag', 'add', `${name}@${version}`, 'latest');
}
