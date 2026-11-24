# Paseo Task Inbox

[![npm version](https://img.shields.io/npm/v/@kelvicthrust/paseo-task-inbox?logo=npm)](https://www.npmjs.com/package/@kelvicthrust/paseo-task-inbox)

Capture bugs and screenshots while you test, then send the ones you want fixed to an existing Codex or Claude Code chat in Paseo. Each workspace has its own inbox, so you can keep testing while the agent works through the current batch. Verified fixes appear with the check result and a link to the pull request.

![Task Inbox workspace panel in Paseo showing three sample bugs and the Start work button](assets/task-inbox.png)

_Task Inbox with sample data._

## Get started

Use Paseo 0.16.1 or later on the machine that runs your agents. The daemon's Node.js runtime must support `node:sqlite`. To send a batch and verify fixes, use a workspace with a GitHub `origin`, Git and an authenticated GitHub CLI (`gh`) on the daemon host, and an existing chat that can publish a fix PR.

In Paseo, select that host and turn on **Enable plugins** under **Settings → Plugins**. Paseo plugins are trusted code and run with the daemon user's file and process access. [Paseo plugin setup](https://paseo.sh/docs/plugins)

### Install from npm

With npm available on the daemon host, install the latest release.

```sh
paseo plugin install npm:@kelvicthrust/paseo-task-inbox
```

Append a version such as `@0.1.0` to install a specific release.

### Install from source

On the daemon host, with Node.js 26 and npm available:

```sh
git clone https://github.com/kelvicthrust/paseo-task-inbox.git
cd paseo-task-inbox
npm ci --ignore-scripts --include=dev
paseo plugin install "$PWD"
```

### Open Task Inbox

Run `paseo plugin ls task-inbox` to verify the plugin is **running**. If your daemon uses a custom home, pass `--home /path/to/paseo-home` to the install and status commands. Open **Task Inbox** in the sidebar or choose **Open Task Inbox** in the workspace Command Center.

## Capture and send bugs

1. Open the workspace inbox. Describe what went wrong and select **Add to inbox**. You can capture bugs without starting an agent turn.
2. To include an image, select **Attach screenshot** on the bug and open the browser picker. Each link accepts one PNG or JPEG and expires after five minutes.
3. Select the bugs you want fixed, choose an existing chat, and select **Start work**. A batch can hold up to 20 bugs and 24 MiB of images. Each bug can have up to four images of 8 MiB each.
4. Follow the batch in Task Inbox or select **Open chat**. New bugs stay in the inbox for a later batch. When the current batch finishes, Task Inbox also posts an outcome in the selected chat.

### Upload screenshots from another device

A browser on the daemon host can use the built-in loopback uploader with the screenshot address left blank. For a phone, desktop app, or browser on another device, use private Tailscale Serve on the daemon host. Check `tailscale serve status` first and choose an unused HTTPS port. For example:

```sh
tailscale serve --bg --https=47831 http://127.0.0.1:47831
```

In **Task Inbox → Screenshot uploads**, save the HTTPS origin printed by Tailscale, including its port. Open the upload link from a device signed into your tailnet under a user account. [Tailscale Serve setup](https://tailscale.com/docs/features/tailscale-serve)

## Verified fixes and blocked batches

**Completed** means the agent reported a passing test or manual check for that bug, and Task Inbox confirmed the matching fix evidence on GitHub. The plugin uses the host's `gh` session to check that the PR is open and ready for review in the workspace repository, that its head matches the reported revision, and that the commit named for the bug belongs to the PR. Merging and deploying each require separate authorization.

Task Inbox queues a batch while the selected chat is busy. Paseo 0.16.1 has a brief window in which another message can start a turn just as the plugin sends. A reconnect reuses the original dispatch ID. If a daemon restart restores chat history without enough information to match the original turn, the batch stays **Blocked** with its receipt preserved. Bugs also stay visible when verification fails or the agent reports a blocker.

## Data and permissions

Task Inbox stores bug reports, attached images, and dispatch records in `$PASEO_HOME/plugin-data/task-inbox/inbox.sqlite3` on the daemon host. The default Paseo home is `~/.paseo`. When you start work, the selected bug descriptions and images go to the selected chat and its configured provider. Task Inbox reads that chat's projected activity and results to follow the batch, and reads the fix PR from GitHub to verify the outcome.

## Contribute

Bug reports and pull requests are welcome. Include the Paseo version, client, and steps to reproduce when reporting an issue. Use sample data for screenshots and logs. [GitHub Issues](https://github.com/kelvicthrust/paseo-task-inbox/issues)

Use Node.js 26 to install the locked dependencies and run the plugin and package checks. The upload tests use a temporary loopback listener.

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
