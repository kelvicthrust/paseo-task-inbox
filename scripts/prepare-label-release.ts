import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { compareStableVersions, selectReleaseVersion } from './check-release-version.ts';

const branch = 'automation/task-inbox-release';
const remoteBranch = `refs/remotes/origin/${branch}`;
const main = 'refs/remotes/origin/main';
const labels = ['release:major', 'release:minor', 'release:patch'] as const;
type Label = typeof labels[number];

type MergedPull = {
  number: number;
  title: string;
  labels: { name: string }[];
  base: { ref: string };
  head: { ref: string; repo: { full_name: string } | null };
  merged_at: string | null;
  merge_commit_sha: string | null;
};

function run(command: string, ...args: string[]) {
  return execFileSync(command, args, { encoding: 'utf8' }).trim();
}

function git(...args: string[]) {
  return run('git', ...args);
}

export function bump(version: string, label: Label) {
  selectReleaseVersion(version);
  const [major, minor, patch] = version.split('.').map(BigInt) as [bigint, bigint, bigint];
  switch (label) {
    case 'release:major': return `${major + 1n}.0.0`;
    case 'release:minor': return `${major}.${minor + 1n}.0`;
    case 'release:patch': return `${major}.${minor}.${patch + 1n}`;
  }
}

function commitsAfter(base: string, tip: string) {
  return git('rev-list', '--first-parent', '--reverse', `${base}..${tip}`).split('\n').filter(Boolean);
}

function pendingPulls(repository: string, tag: string, tip: string) {
  git('merge-base', '--is-ancestor', `${tag}^{commit}`, tip);
  return commitsAfter(tag, tip).flatMap((commit) => {
    const pages = JSON.parse(run('gh', 'api', '--paginate', '--slurp',
      `repos/${repository}/commits/${commit}/pulls?per_page=100`)) as MergedPull[][];
    return pages.flat().filter((pull) => pull.base.ref === 'main' &&
      !(pull.head.ref === branch && pull.head.repo?.full_name === repository) &&
      pull.merged_at && pull.merge_commit_sha === commit).map((pull) => ({ ...pull, commit }));
  });
}

export function highestLabel(pulls: { labels: { name: string }[] }[]) {
  const names = new Set(pulls.flatMap((pull) => pull.labels.map(({ name }) => name)));
  return labels.find((label) => names.has(label));
}

function publishedTag(repository: string) {
  const tag = run('gh', 'api', `repos/${repository}/releases/latest`, '--jq', '.tag_name');
  if (!tag.startsWith('v')) throw new Error('Expected the latest published release to have a v-prefixed version tag.');
  selectReleaseVersion(tag.slice(1));
  return tag;
}

type ReleasePull = { number: number; user: { login: string }; title: string; draft: boolean; head: MergedPull['head'] };

function releasePull(repository: string) {
  const [owner] = repository.split('/');
  const head = encodeURIComponent(`${owner}:${branch}`);
  const pages = JSON.parse(run('gh', 'api', '--paginate', '--slurp',
    `repos/${repository}/pulls?state=open&base=main&head=${head}&per_page=100`)) as ReleasePull[][];
  const pulls = pages.flat().filter((pull) => pull.head.ref === branch && pull.head.repo?.full_name === repository);
  if (pulls.length > 1 || pulls.some((pull) => pull.user.login !== 'github-actions[bot]')) {
    throw new Error(`Expected a single GitHub Actions PR for ${branch}.`);
  }
  return pulls[0];
}

function notePath(version: string) {
  return `docs/releases/v${version}.md`;
}

export function formatNotes(
  version: string, repository: string, pulls: Pick<MergedPull, 'number' | 'title'>[], priorNotes = '',
) {
  const heading = `# What's new in v${version}`;
  const priorBody = priorNotes.replace(/^# What's new in v[^\r\n]+\r?\n/, '')
    .replace(/^(?:[ \t]*\r?\n)+/, '').trimEnd();
  const additions = pulls.map(({ number, title }) => {
    const plain = title.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      .replace(/[\\`*_{}\[\]()~]/g, '\\$&');
    return `- ${plain} ([#${number}](https://github.com/${repository}/pull/${number}))`;
  });
  return [heading, priorBody, additions.join('\n')].filter(Boolean).join('\n\n') + '\n';
}

function versionAt(ref: string) {
  return selectReleaseVersion(JSON.parse(git('show', `${ref}:package.json`)).version);
}

function versionCommit(tag: string, tip: string, version: string) {
  const commits = git('log', '--first-parent', '--format=%H', `${tag}..${tip}`, '--', 'package.json').split('\n').filter(Boolean);
  let introduction: string | undefined;
  for (const commit of commits) {
    if (versionAt(commit) !== version) break;
    introduction = commit;
  }
  if (!introduction) throw new Error(`Could not locate the v${version} change on main.`);
  return introduction;
}

function updateVersions(previous: string, version: string) {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
  if (pkg.version !== previous || lock.version !== previous || lock.packages?.['']?.version !== previous) {
    throw new Error('package.json and package-lock.json must agree before preparing a release.');
  }
  pkg.version = lock.version = lock.packages[''].version = version;
  writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
  writeFileSync('package-lock.json', JSON.stringify(lock, null, 2) + '\n');
}

function differsFrom(ref: string) {
  const result = spawnSync('git', ['diff', '--cached', '--quiet', ref], { stdio: 'inherit' });
  if (result.status !== 0 && result.status !== 1) throw new Error('Could not compare the generated release tree.');
  return result.status === 1;
}

function updateRelease(
  repository: string, tag: string, tip: string, previous: string, version: string,
  changes: ReturnType<typeof pendingPulls>, pull: ReleasePull | undefined,
) {
  const title = `Release Paseo Task Inbox v${version}`;
  const branchExists = Boolean(git('for-each-ref', '--format=%(objectname)', remoteBranch));
  if (pull && !branchExists) throw new Error('Fetch the current automation branch before refreshing its PR.');
  let priorNotes = '';
  let additions = changes;
  if (pull) {
    priorNotes = git('show', `${remoteBranch}:${notePath(versionAt(remoteBranch))}`);
    const since = new Set(commitsAfter(git('merge-base', tip, remoteBranch), tip));
    additions = changes.filter(({ commit }) => since.has(commit));
  } else if (previous !== tag.slice(1) && git('ls-tree', '--name-only', tip, '--', notePath(previous))) {
    // A stale release PR already merged. Keep its reviewed notes in the correction.
    priorNotes = git('show', `${tip}:${notePath(previous)}`);
    additions = changes.filter(({ number }) => !priorNotes.includes(`/pull/${number})`));
  }
  git('switch', '--detach', tip);
  updateVersions(previous, version);
  const notes = notePath(version);
  writeFileSync(notes, formatNotes(version, repository, additions, priorNotes));
  git('add', '--', 'package.json', 'package-lock.json', notes);

  if (!branchExists || differsFrom(remoteBranch)) {
    if (pull && !pull.draft) run('gh', 'pr', 'ready', String(pull.number), '--repo', repository, '--undo');
    git('commit', '-m', title);
    if (branchExists) {
      // Preserve the bot branch history while using the new tree prepared from main.
      git('merge', '--no-edit', '-s', 'ours', remoteBranch);
    }
    git('-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential',
      'push', 'origin', `HEAD:refs/heads/${branch}`);
  }
  if (!pull) {
    const body = 'Review the version and the generated What’s new notes in Files changed. Edit the notes as needed, approve workflow runs if GitHub prompts, and mark the PR ready before merging.';
    console.log(run('gh', 'pr', 'create', '--repo', repository, '--base', 'main', '--head', branch,
      '--draft', '--title', title, '--body', body));
  } else if (pull.title !== title) {
    run('gh', 'pr', 'edit', String(pull.number), '--repo', repository, '--title', title);
  }
}

export function reconcile(repository: string) {
  if (git('status', '--porcelain')) throw new Error('Release preparation requires a clean checkout.');
  const tip = git('rev-parse', main);
  const tag = publishedTag(repository);
  const previous = versionAt(tip);
  const published = tag.slice(1);
  if (compareStableVersions(previous, published) < 0) throw new Error('Main is behind the latest published version.');
  const changes = pendingPulls(repository, tag, tip);
  const label = highestLabel(changes);
  const version = label ? bump(published, label) : published;
  const pull = releasePull(repository);

  if (previous !== published) {
    const candidate = versionCommit(tag, tip, previous);
    const included = new Set(commitsAfter(tag, candidate));
    const candidateLabel = highestLabel(changes.filter(({ commit }) => included.has(commit)));
    if (!candidateLabel || compareStableVersions(previous, bump(published, candidateLabel)) >= 0) {
      if (pull) run('gh', 'pr', 'close', String(pull.number), '--repo', repository);
      console.log(`Waiting for v${previous} to publish before preparing the next draft.`);
      return;
    }
  }

  if (compareStableVersions(version, previous) <= 0) {
    if (pull) run('gh', 'pr', 'close', String(pull.number), '--repo', repository);
    console.log(`No further version bump is needed from ${previous}.`);
    return;
  }
  git('config', 'user.name', 'github-actions[bot]');
  git('config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com');
  updateRelease(repository, tag, tip, previous, version, changes, pull);
}

export function checkLabelRelease(repository: string, tip: string, version: string) {
  const tag = publishedTag(repository);
  const published = tag.slice(1);
  const order = compareStableVersions(selectReleaseVersion(version), published);
  if (order < 0) throw new Error(`v${version} is behind the published ${tag}.`);
  if (order === 0) {
    // A retry can reach this check after publishing the verified candidate.
    if (git('rev-parse', `${tag}^{commit}`) !== git('rev-parse', tip)) {
      throw new Error(`Published ${tag} points to a different commit.`);
    }
    return;
  }
  const label = highestLabel(pendingPulls(repository, tag, tip));
  if (label && compareStableVersions(version, bump(published, label)) < 0) {
    throw new Error(`v${version} is below the ${label} release pending from ${tag}. Merge the correction release PR.`);
  }
}

if (import.meta.main) {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) throw new Error('GITHUB_REPOSITORY is required.');
  const [, , option, tip, version] = process.argv;
  if (option === undefined) reconcile(repository);
  else if (option === '--check' && tip && version) checkLabelRelease(repository, tip, version);
  else throw new Error('Usage: prepare-label-release.ts [--check <commit> <version>]');
}
