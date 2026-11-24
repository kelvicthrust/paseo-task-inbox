# Paseo Task Inbox

[![npm version](https://badgen.net/npm/v/@kelvicthrust/paseo-task-inbox)](https://www.npmjs.com/package/@kelvicthrust/paseo-task-inbox)

Capture bugs and screenshots while you test in Paseo. Start a batch from the workspace’s right-side Explorer and Task Inbox opens a Codex or Claude Code chat to work on it. Keep capturing bugs while the agent works, and find verified fixes with links to their pull requests.

![The right-side Task Inbox panel with sample bugs and the configured model for Start work](assets/task-inbox.png)

## Get started

Use Paseo Desktop 0.17.4 or later and a Paseo daemon with a Node.js runtime that supports `node:sqlite`.

For dispatch and verification, use a workspace with a GitHub `origin`, Codex or Claude Code configured on the host, and Git and an authenticated GitHub CLI (`gh`) on the host.

In Paseo, select that host and turn on **Enable plugins** under **Settings → Plugins**. Paseo plugins are trusted code and run with the daemon user's file and process access. [Paseo plugin setup](https://paseo.sh/docs/plugins)

### Install from npm

With npm available on the daemon host, install the plugin.

```sh
paseo plugin install npm:@kelvicthrust/paseo-task-inbox
```

### Install from source

On the daemon host, use Node.js 26 and npm to install from a checkout.

```sh
git clone https://github.com/kelvicthrust/paseo-task-inbox.git
cd paseo-task-inbox
npm ci --ignore-scripts --include=dev
paseo plugin install "$PWD"
```

### Open Task Inbox

Run `paseo plugin ls task-inbox` and look for **running**. If your daemon uses a custom home, pass `--home /path/to/paseo-home` to the install and status commands. In your workspace, open **+ → Task Inbox** in the right-side Explorer. You can also choose **Open Task Inbox** in the workspace Command Center to open or focus the same tab.

Before you send your first batch, go to **Settings → Plugins → Task Inbox**. On the **Task Inbox agent** tab, select the Codex or Claude Code model to use on that host.

## Capture and send bugs

1. Open the workspace inbox. Describe what went wrong and select **Add to inbox**. You can capture bugs without starting an agent turn.
2. To include an image, select **Attach screenshot** on the bug and open the browser picker. Each link accepts one PNG or JPEG and expires after five minutes.
3. Select the bugs to fix, check the model shown beside **Start work**, and start the batch. Task Inbox creates a visible chat in that workspace, even when the main pane shows a terminal.
4. Follow the batch in Task Inbox or select **Open chat**. The batch stays with that chat when you switch tabs or reload.

All chats in the workspace share one inbox. Task Inbox allows one active batch per workspace, with up to 20 bugs and 24 MiB of images per batch. Each bug can have up to four images of 8 MiB each.

If **Start work** asks for a model, choose an available one in **Task Inbox agent**. You can still capture bugs and attach screenshots.

### Upload screenshots from another device

A browser on the daemon host can use the built-in loopback uploader with the screenshot address left blank. For a phone, desktop app, or browser on another device, use private Tailscale Serve on the daemon host. Check `tailscale serve status` first and choose an unused HTTPS port. For example:

```sh
tailscale serve --bg --https=47831 http://127.0.0.1:47831
```

In **Settings → Plugins → Task Inbox**, open **Screenshot uploads** and save the HTTPS origin printed by Tailscale, including its port. Open the upload link from a device signed into your tailnet under a user account. [Tailscale Serve setup](https://tailscale.com/docs/features/tailscale-serve)

## Verified fixes and blocked batches

**Completed** means the agent reported a passing test or manual check for that bug, and Task Inbox confirmed the matching fix evidence on GitHub. The plugin uses the host's `gh` session to check that the PR is open and ready for review in the workspace repository, that its head matches the reported revision, and that the commit named for the bug belongs to the PR. Merging and deploying each require separate authorization.

Task Inbox queues a batch while its chat is busy. Another message can start a turn between the idle check and dispatch. A reconnect reuses the original dispatch ID. If a daemon restart restores chat history without enough information to match the original turn, the batch stays **Blocked** with its receipt preserved. Bugs also stay visible when verification fails or the agent reports a blocker.

## Data and permissions

Task Inbox stores bug reports, attached images, and dispatch records in `$PASEO_HOME/plugin-data/task-inbox/inbox.sqlite3` on the daemon host. The default Paseo home is `~/.paseo`. The Explorer update uses the existing inbox and batch history in the same Paseo home. When you start work, the selected bug descriptions and images go to the displayed chat and its configured provider. Task Inbox reads that chat's activity and results to follow the batch, and reads the fix PR from GitHub to verify the outcome.

## Contribute

Bug reports and pull requests are welcome. Include the Paseo version, client, and steps to reproduce when reporting an issue. Use sample data for screenshots and logs. [GitHub Issues](https://github.com/kelvicthrust/paseo-task-inbox/issues)

Use Node.js 26 and npm 11.21.3 to match the package checks in CI. The upload tests use a temporary loopback listener.

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run pack:release
npm run test:package
```

See the [maintainer release guide](https://github.com/kelvicthrust/paseo-task-inbox/blob/main/docs/releasing.md) for GitHub Actions releases, npm archive verification, and Paseo catalog submission.

## License

Paseo Task Inbox is available under the [MIT License](LICENSE).
