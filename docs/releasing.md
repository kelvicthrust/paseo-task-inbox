# Release Paseo Task Inbox

**Plugin checks** runs on pull requests. **Release** uses Node.js 26.3.1 and npm 11.21.3 to test and pack an archive on Ubuntu. A manual run with **Finalize an npm version published locally** off builds a candidate for the selected commit and uploads the verified archive and its SHA-256 checksum. [Release workflow](https://github.com/kelvicthrust/paseo-task-inbox/actions/workflows/release.yml)

## Prepare the first Explorer release

Wait for a stable Paseo app release that provides active chat context to workspace panels. Install the candidate archive on an isolated daemon and test it with that stable app. [Upstream Paseo change](https://github.com/getpaseo/paseo/pull/10681)

1. Confirm the plugin reports **running**. Open **+ → Task Inbox** in the right-side Explorer and save a sample bug. Open the workspace Command Center and confirm **Open Task Inbox** focuses the existing Explorer tab.
2. Open two chats and a terminal in the same workspace. Confirm the inbox is shared, **Send to** follows the active chat, and **Start work** is disabled with the terminal selected. Start a batch in the first chat, switch chats, and reload. Use **Open chat** to confirm the batch still points to the first chat.
3. Set the verified minimum in `paseo-plugin.json` and the docs. Update the plugin SDK dependency and lockfile to the verified SDK version that declares `activeAgentId`. Replace the README preview instructions with the Explorer release instructions and use an absolute GitHub URL for this guide so the link works from npm.
4. Capture the stable Explorer interface with sample data and replace `assets/task-inbox.png`. Check the image for private information. Use the packaged image in the README and confirm the archive includes the manifest media and `OVERVIEW.md`.

## Publish with GitHub Actions

In the npm package's settings, configure the GitHub Actions trusted publisher with owner **kelvicthrust**, repository **paseo-task-inbox**, workflow **release.yml**, and an empty environment. Enable **Allow npm publish** and **Allow npm dist-tag**. [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/)

Run `npm version patch --no-git-tag-version` or choose a minor or major bump. Review the package and lockfile changes. Merging a higher stable version into `main` triggers **Release**. It publishes under `next`, checks the npm download against the tested archive, promotes the version to `latest`, and creates a GitHub release at the tested commit.

If a job fails after npm accepts a version, rerun failed jobs on the original workflow run to reuse the verified artifact. If that version exists with different bytes, prepare a new version.

## Publish locally when needed

Use a release commit on `main`. Run **Release** on that revision with **Finalize an npm version published locally** off. Download and extract `paseo-task-inbox-<version>-<attempt>`. Replace `<version>` with the rehearsed version, verify `SHA256SUMS`, and stage the exact archive from a local npm session with publishing access to `@kelvicthrust`.

```sh
shasum -a 256 -c SHA256SUMS
npm stage publish './kelvicthrust-paseo-task-inbox-<version>.tgz' --access public --registry=https://registry.npmjs.org/
```

Approve the staged publication on npm. Verify the public archive as shown below. Run **Release** again on the same commit with **Finalize an npm version published locally** on. Use `main` while it points to that commit. If `main` has moved, create and push the matching `v<version>` tag at the rehearsed commit and select that tag. The workflow verifies the public npm download and attaches the tested tarball and checksum to the GitHub release. [npm staged publishing](https://docs.npmjs.com/staged-publishing/)

## Submit to the Paseo catalog

From a fresh directory, replace `<version>` with the exact npm version and compare the public download against the SHA-256 checksum from the release artifact.

```sh
npm pack '@kelvicthrust/paseo-task-inbox@<version>' --ignore-scripts --registry=https://registry.npmjs.org/
shasum -a 256 -c /absolute/path/to/SHA256SUMS
```

Install that version on the test daemon. Confirm it reports **running** and repeat the Explorer smoke test above on the stable Paseo build.

```sh
paseo plugin install 'npm:@kelvicthrust/paseo-task-inbox@<version>'
paseo plugin ls task-inbox
```

Use these details in the official submission. [Paseo submission form](https://github.com/getpaseo/plugins/issues/new?template=submit-plugin.yml)

- **Title** — Task Inbox
- **Source** — `npm:@kelvicthrust/paseo-task-inbox@<version>`
- **Categories** — Workspaces and Sidebar
- **Interface image** — `https://raw.githubusercontent.com/kelvicthrust/paseo-task-inbox/<release-commit>/assets/task-inbox.png`, using the full commit SHA for the verified release

After approval, add the official listing URL to the README. [Paseo publishing guide](https://paseo.sh/docs/plugins/publishing)
