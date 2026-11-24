# Paseo Task Inbox

[![npm version](https://badgen.net/npm/v/@kelvicthrust/paseo-task-inbox)](https://www.npmjs.com/package/@kelvicthrust/paseo-task-inbox)

Capture bugs and screenshots while you test in Paseo. Send a batch from the workspace’s right-side Explorer to the Codex or Claude Code chat you have open. Keep capturing bugs while the agent works, and find verified fixes with links to their pull requests.

> **Explorer preview.** The instructions below describe the development branch. The published npm version, `0.1.0`, opens Task Inbox from the sidebar and asks you to pick a chat. [Guide for npm 0.1.0](https://github.com/kelvicthrust/paseo-task-inbox/blob/f12281c4c200f860faa34eb1e27a448e4b7aeefa/README.md)

<details>
<summary>See Task Inbox in Explorer</summary>

![The right-side Explorer panel showing three sample bugs and the chat next to Start work](https://raw.githubusercontent.com/kelvicthrust/paseo/19619967f5a72f96429d18886d268be22174a6e5/task-inbox-explorer-desktop.png)

_Sample data in a Paseo development build._

</details>

## Get started

Use a Paseo daemon at version 0.16.1 or later with a Node.js runtime that supports `node:sqlite`. Sending from Explorer also requires a Paseo app build with active chat context for workspace panels. [Paseo change for active chat context](https://github.com/getpaseo/paseo/pull/10681)

For dispatch and verification, use a workspace with a GitHub `origin`, an existing chat that can publish a fix PR, and Git and an authenticated GitHub CLI (`gh`) on the daemon host.

In Paseo, select that host and turn on **Enable plugins** under **Settings → Plugins**. Paseo plugins are trusted code and run with the daemon user's file and process access. [Paseo plugin setup](https://paseo.sh/docs/plugins)

### Install from npm

With npm available on the daemon host, install the published sidebar version.

```sh
paseo plugin install npm:@kelvicthrust/paseo-task-inbox@0.1.0
```

### Try the Explorer preview from source

On the daemon host, use Node.js 26 and npm to install the Explorer branch.

```sh
git clone --branch feat/explorer-inbox https://github.com/kelvicthrust/paseo-task-inbox.git
cd paseo-task-inbox
npm ci --ignore-scripts --include=dev
paseo plugin install "$PWD"
```

### Open Task Inbox

Run `paseo plugin ls task-inbox` and look for **running**. If your daemon uses a custom home, pass `--home /path/to/paseo-home` to the install and status commands. In your workspace, open **+ → Task Inbox** in the right-side Explorer. You can also choose **Open Task Inbox** in the workspace Command Center to open or focus the same tab.

## Capture and send bugs

1. Open the workspace inbox. Describe what went wrong and select **Add to inbox**. You can capture bugs without starting an agent turn.
2. To include an image, select **Attach screenshot** on the bug and open the browser picker. Each link accepts one PNG or JPEG and expires after five minutes.
3. Select a chat tab in the main workspace pane. Check the **Send to** label, select the bugs to fix, then choose **Start work**. The destination follows the selected chat and stays selected while you work in Explorer.
4. Follow the batch in Task Inbox or select **Open chat** to return to its original chat. Switching tabs changes the destination for the next batch. Work already sent and its outcome stay with the original chat, including after you reload.

All chats in the workspace share one inbox. Task Inbox allows one active batch per workspace, with up to 20 bugs and 24 MiB of images per batch. Each bug can have up to four images of 8 MiB each.

If the main pane shows a terminal or another non-chat tab, **Start work** is disabled. Select an available chat to send a batch. If Task Inbox asks you to update Paseo, your app build lacks active chat context. Bug capture and screenshot attachments are available in both cases.

### Upload screenshots from another device

A browser on the daemon host can use the built-in loopback uploader with the screenshot address left blank. For a phone, desktop app, or browser on another device, use private Tailscale Serve on the daemon host. Check `tailscale serve status` first and choose an unused HTTPS port. For example:

```sh
tailscale serve --bg --https=47831 http://127.0.0.1:47831
```

In **Settings → Plugins**, open the settings cog for **Task Inbox** on the daemon host. Under **Screenshot uploads**, save the HTTPS origin printed by Tailscale, including its port. Open the upload link from a device signed into your tailnet under a user account. [Tailscale Serve setup](https://tailscale.com/docs/features/tailscale-serve)

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
