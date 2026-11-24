import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const writeJson = (file, data) => writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
const { name, version, description, license, repository, type, engines, dependencies } = readJson(
  join(root, 'package.json'),
);
const output = join(root, 'dist', 'release');
const archive = join(output, `${name.slice(1).replace('/', '-')}-${version}.tgz`);
const sourceFiles = [
  'LICENSE',
  'OVERVIEW.md',
  'README.md',
  'assets/icon.png',
  'assets/task-inbox.png',
  'paseo-plugin.json',
  'index.client.tsx',
  'index.server.ts',
  ...globSync(['client/**/*.{ts,tsx}', 'server/**/*.ts', 'shared/**/*.ts'], { cwd: root }).sort(),
];
const lock = readJson(join(root, 'package-lock.json'));
const production = Object.entries(lock.packages).filter(([path, entry]) => path && !entry.dev);

function npm(args, cwd, cache) {
  execFileSync(process.execPath, [process.env.npm_execpath, ...args, '--cache', cache], {
    cwd,
    stdio: 'inherit',
  });
}

function pack(scratch) {
  const stage = join(scratch, 'package');
  const cache = join(scratch, 'npm-cache');
  mkdirSync(stage);
  writeJson(join(stage, 'package.json'), {
    name,
    version,
    description,
    license,
    repository,
    type,
    engines,
    files: [...sourceFiles, 'npm-shrinkwrap.json'],
    dependencies,
    bundleDependencies: true,
    publishConfig: { access: 'public' },
  });
  for (const file of sourceFiles) cpSync(join(root, file), join(stage, file));
  for (const [path, locked] of production) {
    const installed = join(root, path);
    assert.equal(
      readJson(join(installed, 'package.json')).version,
      locked.version,
      `Run npm ci to install ${path}`,
    );
    // Copy the package itself. The lockfile separately selects any nested production dependencies.
    cpSync(installed, join(stage, path), {
      recursive: true,
      filter: (source) => !relative(installed, source).split(sep).includes('node_modules'),
    });
  }
  // npm records the installed bundle tree. Preserve the registry metadata from the source lock.
  npm([
    'install', '--package-lock-only', '--lockfile-version=3', '--ignore-scripts',
    '--offline', '--no-audit', '--no-fund',
  ], stage, cache);
  const shrinkwrap = readJson(join(stage, 'package-lock.json'));
  assert.equal(Object.keys(shrinkwrap.packages).length, production.length + 1);
  for (const [path, locked] of production) {
    const entry = shrinkwrap.packages[path];
    assert.ok(
      entry?.inBundle && entry.version === locked.version && locked.resolved && locked.integrity,
      `Cannot lock bundled dependency ${path}`,
    );
    entry.resolved = locked.resolved;
    entry.integrity = locked.integrity;
  }
  writeJson(join(stage, 'npm-shrinkwrap.json'), shrinkwrap);
  mkdirSync(output, { recursive: true });
  npm(['pack', '--ignore-scripts', '--loglevel=error', '--pack-destination', output], stage, cache);
}

function test(scratch) {
  const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(
    entries.filter((entry) => !entry.startsWith('package/node_modules/')).sort(),
    [...sourceFiles, 'package.json', 'npm-shrinkwrap.json'].map((file) => `package/${file}`).sort(),
  );
  writeJson(join(scratch, 'package.json'), {
    name: 'paseo-plugin-installation',
    version: '1.0.0',
    private: true,
    dependencies: { [name]: `file:${archive}` },
  });
  // Match Paseo's npm acquisition options. An empty offline cache proves the bundle is self-contained.
  npm([
    'install', '--offline', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund',
    '--package-lock=true', '--lockfile-version=3', '--include=prod', '--omit=dev', '--global=false',
    '--workspaces=false',
  ], scratch, join(scratch, 'npm-cache'));
  const consumerLock = readJson(join(scratch, 'package-lock.json'));
  const artifact = consumerLock.packages[`node_modules/${name}`];
  assert.equal(artifact.version, version);
  assert.ok(artifact.resolved);
  const digest = createHash('sha512').update(readFileSync(archive)).digest('base64');
  assert.equal(artifact.integrity, `sha512-${digest}`);
  const plugin = join(scratch, 'node_modules', name);
  const manifest = readJson(join(plugin, 'package.json'));
  assert.equal(manifest.name, name);
  assert.equal(manifest.version, version);
  assert.equal(manifest.license, 'MIT');
  assert.deepEqual(manifest.repository, {
    type: 'git',
    url: 'git+https://github.com/kelvicthrust/paseo-task-inbox.git',
  });
  assert.equal(manifest.publishConfig.access, 'public');
  assert.equal(manifest.private, undefined);
  assert.equal(manifest.devDependencies, undefined);
  assert.equal(manifest.scripts, undefined);
  const pluginManifest = readJson(join(plugin, 'paseo-plugin.json'));
  assert.equal(pluginManifest.id, 'task-inbox');
  assert.equal(pluginManifest.icon, 'assets/icon.png');
  assert.deepEqual(pluginManifest.media, ['assets/task-inbox.png']);
  for (const file of ['LICENSE', 'OVERVIEW.md', pluginManifest.icon, ...pluginManifest.media]) {
    assert.deepEqual(readFileSync(join(plugin, file)), readFileSync(join(root, file)), file);
  }
  const shrinkwrap = readJson(join(plugin, 'npm-shrinkwrap.json'));
  const bundled = new Map(production);
  for (const [path, entry] of Object.entries(shrinkwrap.packages)) {
    if (!path) continue;
    const pinned = bundled.get(path);
    assert.ok(pinned && entry.inBundle, `Unexpected bundled dependency ${path}`);
    assert.equal(entry.version, pinned.version);
    assert.equal(entry.resolved, pinned.resolved);
    assert.equal(entry.integrity, pinned.integrity);
    assert.equal(readJson(join(plugin, path, 'package.json')).version, pinned.version);
    bundled.delete(path);
  }
  assert.equal(bundled.size, 0, 'Some locked production dependencies are missing');

  // Paseo provides its own plugin SDK, React and Zod when compiling these sources.
  // The daemon client is loaded from the installed plugin's production dependencies.
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { createHostClient } from '@getpaseo/client/node';
    assert.equal(typeof createHostClient, 'function');
  `], { cwd: plugin, stdio: 'inherit' });
  console.log(`${name}@${version} installed offline and resolved the daemon client from the release archive.`);
}

const action = { pack, test }[process.argv[2]];
assert.ok(action && process.argv.length === 3, 'Use npm run pack:release or npm run test:package');
const scratch = mkdtempSync(join(tmpdir(), 'task-inbox-package-'));
try {
  action(scratch);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
