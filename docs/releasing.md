# Release Paseo Task Inbox

**Plugin checks** runs on pull requests. **Release** uses Node.js 26.3.1 and npm 11.21.3 to test and pack an archive on Ubuntu. A manual run with **Finalize an npm version published locally** off builds a candidate for the selected commit and uploads the verified archive and its SHA-256 checksum. [Release workflow](https://github.com/kelvicthrust/paseo-task-inbox/actions/workflows/release.yml)

## Verify the Explorer workflow

Install the candidate archive on an isolated daemon and use stock Paseo Desktop at the minimum version declared in `paseo-plugin.json`.

1. Confirm the plugin reports **running**. Open **+ → Task Inbox** in the right-side Explorer and save a sample bug. Open the workspace Command Center and confirm **Open Task Inbox** focuses the existing Explorer tab.
2. On Desktop and web, connect to a remote test daemon with the private screenshot address blank. Choose, paste, and drop sample images before adding a task. Remove one, retry an interrupted upload, and confirm the saved task has exactly the intended images. Edit its description and images, reload, then delete a second sample task and confirm its number is never reused.
3. In narrow and wider Explorer panels, check light and dark themes, keyboard access to attachment and row actions, the footer while scrolling, and focus after saving or deleting. Start work from another client while editing and confirm the reserved task is preserved.
4. Set an available model in **Task Inbox agent**. From a workspace with a terminal selected, attach a sample screenshot and start the batch. Check the dispatched description and image order and bytes against the saved report. Confirm the plugin creates one chat in the workspace, **Open chat** goes to that chat, and reloading preserves it.
5. If the interface changed, replace `assets/task-inbox.png` with a screenshot from the stable app using sample data. Check the image for private information. Confirm the archive includes the manifest media and `OVERVIEW.md`.

The capture-first build upgrades the private inbox database from schema 1 to schema 2 on first open. Verify an upgrade with pre-existing reports, screenshots and an active batch in an isolated copy. For a rollback rehearsal, stop the daemon and back up its private inbox database before the upgrade. An older plugin requires that pre-upgrade database.

## Draft What's new

Compare the release candidate with the last published tag. Include relevant changes from PRs merged since that tag and verify each claim against the candidate. Write for people upgrading Task Inbox in Paseo. Lead with what they can do and where to find it. Include fixes they can recognize, along with any compatibility changes, upgrade steps, or known limits that affect them. Link to PRs or guides where helpful.

Create `docs/releases/vX.Y.Z.md` in the version-bump PR. Use the actual version in the first heading, `# What's new in vX.Y.Z`, and follow it with a short summary or a few bullets. Run `node scripts/check-release-version.ts <previous-package-version>` from the candidate checkout using the previous version from `main`. **Check release version** enforces matching notes on version-bump PRs and publishing runs. Manual build-only runs can rehearse a candidate without notes.

## Publish with GitHub Actions

In the npm package's settings, configure the GitHub Actions trusted publisher with owner **kelvicthrust**, repository **paseo-task-inbox**, workflow **release.yml**, and an empty environment. Enable **Allow npm publish** and **Allow npm dist-tag**. [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/)

Run `npm version patch --no-git-tag-version` or choose a minor or major bump. Review the package and lockfile changes and the matching [What's new](#draft-whats-new) Markdown. Confirm **Check release version** passes before merging. Merging a higher stable version into `main` triggers **Release**. It publishes under `next`, checks the npm download against the tested archive, promotes the version to `latest`, and creates a GitHub release at the tested commit. The release uses the reviewed Markdown as its body and attaches it alongside the tarball and `SHA256SUMS`.

If a job fails after npm accepts a version, rerun failed jobs on the original workflow run to reuse the verified artifact. If that version exists with different bytes, prepare a new version.

## Publish locally when needed

Use a release commit on `main` with matching [What's new](#draft-whats-new) notes. Run **Release** on that revision with **Finalize an npm version published locally** off. Download and extract `paseo-task-inbox-<version>-<attempt>`. Replace `<version>` with the rehearsed version, verify `SHA256SUMS`, and stage the exact archive from a local npm session with publishing access to `@kelvicthrust`.

```sh
shasum -a 256 -c SHA256SUMS
npm stage publish './kelvicthrust-paseo-task-inbox-<version>.tgz' --access public --registry=https://registry.npmjs.org/
```

Approve the staged publication on npm. Verify the public archive as shown below. Run **Release** again on the same commit with **Finalize an npm version published locally** on. Use `main` while it points to that commit. If `main` has moved, create and push the matching `v<version>` tag at the rehearsed commit and select that tag. The workflow verifies the public npm download and publishes the GitHub release with the same reviewed notes and assets as the automatic path. [npm staged publishing](https://docs.npmjs.com/staged-publishing/)

## Verify the public npm release

From a fresh directory, replace `<version>` with the exact npm version and compare the public download against `SHA256SUMS` from the release artifact. If the checksum lists `v<version>.md`, download that Markdown from the same artifact into this directory so both checks can run.

```sh
npm pack '@kelvicthrust/paseo-task-inbox@<version>' --ignore-scripts --registry=https://registry.npmjs.org/
shasum -a 256 -c /absolute/path/to/SHA256SUMS
```

Install that exact npm version on the isolated test daemon. Confirm it reports **running** and repeat the Explorer smoke test above on the stable Paseo build.

```sh
paseo plugin install 'npm:@kelvicthrust/paseo-task-inbox@<version>'
paseo plugin ls task-inbox
```

## Update the Paseo catalog listing

Install the approved version with `paseo plugin add kelvicthrust/task-inbox`. New npm releases receive automatic catalog update PRs. Check that the review PR pins the intended npm version and includes the current overview and screenshot. The catalog keeps serving the approved version while the update is under review. [Task Inbox listing](https://paseo.sh/plugins/kelvicthrust/task-inbox)

If the reviewer requests an updated screenshot, link the sample-data PNG at the verified release commit in the review PR. After approval, install from the catalog on an isolated test daemon and confirm the listed version matches the approved release. [Paseo publishing guide](https://paseo.sh/docs/plugins/publishing#plugin-registry)
