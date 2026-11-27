import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { URL, fileURLToPath } from 'node:url';
import { bump, formatNotes, highestLabel } from '../scripts/prepare-label-release.ts';

const script = fileURLToPath(new URL('../scripts/prepare-label-release.ts', import.meta.url));
const branch = 'refs/remotes/origin/automation/task-inbox-release';
const repository = 'example/task-inbox';
const priorNotes = "Keep the maintainer's upgrade instructions.";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'task-inbox-label-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'repo');
  const remote = join(root, 'remote.git');
  const bin = join(root, 'bin');
  const statePath = join(root, 'state.json');
  mkdirSync(cwd);
  mkdirSync(bin);
  const env = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_FIXTURE_STATE: statePath,
    GITHUB_REPOSITORY: repository, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  };
  const git = (...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-qb', 'main');
  git('init', '-q', '--bare', remote);
  git('remote', 'add', 'origin', remote);
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  const files = {
    version(value: string) {
      writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'fixture', version: value }) + '\n');
      writeFileSync(join(cwd, 'package-lock.json'), JSON.stringify({ version: value, packages: { '': { version: value } } }) + '\n');
    },
    notes(value: string, body: string) {
      writeFileSync(join(cwd, 'docs', 'releases', `v${value}.md`), `# What's new in v${value}\n\n${body}\n`);
    },
  };
  mkdirSync(join(cwd, 'docs', 'releases'), { recursive: true });
  files.version('1.0.1');
  files.notes('1.0.1', 'Published fixture.');
  git('add', '.');
  git('commit', '-qm', 'Published baseline');
  git('tag', 'v1.0.1');
  git('push', '-qu', 'origin', 'main', 'refs/tags/v1.0.1');
  writeFileSync(statePath, JSON.stringify({ tag: 'v1.0.1', pulls: {}, open: null, calls: [] }));
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs');
const file = process.env.GH_FIXTURE_STATE;
const state = JSON.parse(fs.readFileSync(file));
const args = process.argv.slice(2);
const [group, command, endpoint] = args;
if (group === 'api' && command.endsWith('/releases/latest')) {
  console.log(state.tag);
} else if (group === 'api' && args.at(-1).includes('/pulls?state=open&')) {
  const url = new URL('https://api.github.com/' + args.at(-1));
  if (url.searchParams.get('head') !== 'example:automation/task-inbox-release') process.exit(2);
  console.log(JSON.stringify([state.open ? [state.open] : []]));
} else if (group === 'api') {
  const sha = args.at(-1).match(/commits\\/([^/]+)\\/pulls/)[1];
  console.log(JSON.stringify([state.pulls[sha] || []]));
} else if (group === 'pr') {
  const title = args.includes('--title') ? args[args.indexOf('--title') + 1] : undefined;
  if (command === 'create') {
    if (!args.includes('--draft')) process.exit(2);
    state.open = { number: 10, title, draft: true, user: { login: 'github-actions[bot]' },
      head: { ref: 'automation/task-inbox-release', repo: { full_name: 'example/task-inbox' } } };
  } else if (command === 'ready' && args.includes('--undo')) {
    state.open.draft = true;
  } else if (command === 'edit') {
    state.open.title = title;
  } else if (command === 'close') {
    state.open = null;
  } else process.exit(2);
  state.calls.push(command);
  fs.writeFileSync(file, JSON.stringify(state));
} else process.exit(2);
`, { mode: 0o755 });

  function state() { return JSON.parse(readFileSync(statePath, 'utf8')); }
  function setState(value: ReturnType<typeof state>) { writeFileSync(statePath, JSON.stringify(value)); }
  function commit(title: string, number: number, names: string[]) {
    git('switch', 'main');
    writeFileSync(join(cwd, `change-${number}`), title);
    git('add', '.');
    git('commit', '-qm', title);
    const sha = git('rev-parse', 'HEAD');
    git('push', '-q', 'origin', 'HEAD:refs/heads/main');
    const current = state();
    current.pulls[sha] = [
      { number, title, labels: names.map((name) => ({ name })), base: { ref: 'main' }, head: { ref: 'feature', repo: { full_name: repository } },
        merge_commit_sha: sha, merged_at: 'fixture' },
      { number: 999, title: 'Unrelated pull', labels: [{ name: 'release:major' }], base: { ref: 'other' },
        head: { ref: 'other-feature' }, merge_commit_sha: sha, merged_at: 'fixture' },
    ];
    setState(current);
    return sha;
  }
  function release(...args: string[]) {
    return spawnSync(process.execPath, [script, ...args], { cwd, env, encoding: 'utf8' });
  }
  function reconcile() {
    const result = release();
    assert.equal(result.status, 0, result.stderr);
  }
  return { git, files, commit, release, reconcile, state, setState };
}

test('SemVer labels prefer the highest bump and notes escape PR titles', () => {
  assert.equal(bump('1.2.3', 'release:patch'), '1.2.4');
  assert.equal(bump('1.2.3', 'release:minor'), '1.3.0');
  assert.equal(bump('1.2.3', 'release:major'), '2.0.0');
  assert.equal(highestLabel([{ labels: [{ name: 'release:minor' }, { name: 'release:patch' }] }]), 'release:minor');
  assert.match(formatNotes('1.2.0', repository, [{ number: 12, title: '<img>\n[b]' }]), /&lt;img&gt; \\\[b\\\]/);
  assert.match(formatNotes('1.2.0', repository, [], "# What's new in v1.1.0\n\n    npm install\n"), /\n    npm install\n/);
});

test('one draft PR tracks the highest merged label and preserves edited release notes', (t) => {
  const f = fixture(t);
  f.commit('Unlabeled fix', 1, []);
  f.reconcile();
  assert.deepEqual(f.state().calls, []);
  f.commit('Patch fix', 2, ['release:patch']);
  f.reconcile();
  const state = f.state();
  state.open.draft = false;
  f.setState(state);
  assert.equal(state.open.title, 'Release Paseo Task Inbox v1.0.2');
  const lock = JSON.parse(f.git('show', `${branch}:package-lock.json`));
  assert.equal(lock.version, '1.0.2');
  assert.equal(lock.packages[''].version, '1.0.2');
  assert.match(f.git('show', `${branch}:docs/releases/v1.0.2.md`), /Unlabeled fix/);

  f.files.notes('1.0.2', priorNotes);
  f.git('add', 'docs/releases/v1.0.2.md');
  f.git('commit', '-qm', 'Edit the draft notes');
  f.git('push', '-q', 'origin', 'HEAD:refs/heads/automation/task-inbox-release');
  const reviewed = f.git('rev-parse', 'HEAD');
  f.commit('Add a feature', 3, ['release:minor']);
  f.reconcile();
  f.git('merge-base', '--is-ancestor', reviewed, branch);
  const notes = f.git('show', `${branch}:docs/releases/v1.1.0.md`);
  assert.match(notes, /^# What's new in v1\.1\.0/);
  assert.match(notes, /Keep the maintainer's upgrade instructions/);
  assert.match(notes, /Add a feature/);
  assert.equal(f.state().open.draft, true);
  f.reconcile();
  assert.deepEqual(f.state().calls, ['create', 'ready', 'edit']);
});

test('a lower version on main is blocked before publishing and queues a correction', (t) => {
  const f = fixture(t);
  f.commit('Patch fix', 1, ['release:patch']);
  const breaking = f.commit('Breaking feature', 2, ['release:major']);
  const fork = f.state();
  fork.pulls[breaking][0].head = { ref: 'automation/task-inbox-release', repo: { full_name: 'contributor/task-inbox' } };
  f.setState(fork);
  f.files.version('1.0.2');
  f.files.notes('1.0.2', priorNotes);
  f.git('add', '.');
  f.git('commit', '-qm', 'Merge stale release');
  f.git('push', '-q', 'origin', 'HEAD:refs/heads/main');
  const sha = f.git('rev-parse', 'HEAD');
  const blocked = f.release('--check', sha, '1.0.2');
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /below the release:major release/);
  const checked = f.release('--check', `${breaking}^`, '1.0.2');
  assert.equal(checked.status, 0, checked.stderr);
  f.reconcile();
  const notes = f.git('show', `${branch}:docs/releases/v2.0.0.md`);
  assert.match(notes, /Keep the maintainer's upgrade instructions/);
  assert.match(notes, /Breaking feature/);
  assert.equal(f.state().tag, 'v1.0.1');
});

test('a valid release in progress keeps later labels for the next draft', (t) => {
  const f = fixture(t);
  f.commit('Patch fix', 1, ['release:patch']);
  f.files.version('1.0.2');
  f.files.notes('1.0.2', priorNotes);
  f.git('add', '.');
  f.git('commit', '-qm', 'Merge valid release');
  f.git('tag', 'v1.0.2');
  f.commit('Add a feature', 2, ['release:minor']);
  f.reconcile();
  assert.deepEqual(f.state().calls, []);
  const state = f.state();
  state.tag = 'v1.0.2';
  f.setState(state);
  f.reconcile();
  const notes = f.git('show', `${branch}:docs/releases/v1.1.0.md`);
  assert.match(notes, /Add a feature/);
  assert.doesNotMatch(notes, /Patch fix|maintainer/);
});

test('removing the last pending label closes the obsolete draft', (t) => {
  const f = fixture(t);
  const change = f.commit('Patch fix', 1, ['release:patch']);
  f.reconcile();
  const state = f.state();
  state.pulls[change][0].labels = [];
  f.setState(state);
  f.reconcile();
  assert.deepEqual(f.state().calls, ['create', 'close']);
});
