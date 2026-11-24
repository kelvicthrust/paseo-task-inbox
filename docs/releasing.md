# Release Paseo Task Inbox

The **Plugin checks** workflow tests changes on pull requests. The **Release** workflow uses Node.js 26.3.1 and npm 11.21.3 to test and pack an archive on Ubuntu. A manual run builds a candidate for the chosen revision. It uploads the verified archive and its SHA-256 checksum as a workflow artifact.

## Publish the first version from your machine

1. Merge the release preparation PR. In **Actions → Release → Run workflow**, select `main` and leave **Finalize an npm version published locally** off. Note the run's exact commit. Download and extract the artifact named `paseo-task-inbox-0.1.0-<attempt>`.
2. In the extracted directory, verify the archive and stage it from a local npm session with permission to publish under `@kelvicthrust`.

   ```sh
   shasum -a 256 -c SHA256SUMS
   npm stage publish ./kelvicthrust-paseo-task-inbox-0.1.0.tgz --access public --registry=https://registry.npmjs.org/
   ```

3. Approve the staged publication on npm. From a fresh directory, download the exact version and check it against the original checksum.

   ```sh
   npm pack @kelvicthrust/paseo-task-inbox@0.1.0 --ignore-scripts --registry=https://registry.npmjs.org/
   shasum -a 256 -c /absolute/path/to/SHA256SUMS
   ```

4. Run **Release** again on the same commit with **Finalize an npm version published locally** on. Use `main` if it still points to the rehearsed commit. If it has moved, create and push `v0.1.0` at the rehearsed commit, then run `gh workflow run release.yml --ref v0.1.0 -f finalize_local_publish=true`. The workflow compares the built archive with the public npm download, then creates the GitHub release and attaches the verified tarball and checksum.

[npm staged publishing](https://docs.npmjs.com/staged-publishing/) · [GitHub release workflow](https://github.com/kelvicthrust/paseo-task-inbox/actions/workflows/release.yml)

## Configure future releases

In the published npm package's settings, add a GitHub Actions trusted publisher with owner **kelvicthrust**, repository **paseo-task-inbox**, workflow **release.yml**, and an empty environment. Enable **Allow npm publish** and **Allow npm dist-tag**. Merge the first version bump within two days of adding the publisher so its OIDC publication validates the connection. [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/)

For subsequent releases, run `npm version patch --no-git-tag-version` (or select a minor or major bump), review the package and lockfile changes, and merge the release PR into `main`. A higher stable version triggers the workflow. It publishes under `next`, compares the npm download with the tested archive, promotes the version to `latest`, and publishes a GitHub release at the tested commit.

If a job fails after npm accepts a version, rerun failed jobs on the original workflow run to reuse the approved artifact. If the version is already published with different bytes, prepare a new version.

## Submit to the Paseo catalog

After checking the public archive, install that exact version on a test daemon:

```sh
paseo plugin install npm:@kelvicthrust/paseo-task-inbox@0.1.0
paseo plugin ls task-inbox
```

Confirm **running**, open **Task Inbox** in a workspace, and save a sample bug. Then fill in the [official submission form](https://github.com/getpaseo/plugins/issues/new?template=submit-plugin.yml):

- **Title** — Task Inbox
- **Source** — `npm:@kelvicthrust/paseo-task-inbox@0.1.0`, or the exact version verified above
- **Categories** — Workspaces and Sidebar
- **Interface image** — `https://raw.githubusercontent.com/kelvicthrust/paseo-task-inbox/<release-commit>/assets/task-inbox.png`, with the full SHA of the verified release commit

The package includes the English overview, icon, and screenshot. After Paseo approves the listing, add its canonical URL to the README. [Paseo publishing guide](https://paseo.sh/docs/plugins/publishing)
