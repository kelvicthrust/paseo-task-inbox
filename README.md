# Paseo Task Inbox

Collect bugs and screenshots while testing, then send a batch to an existing Codex or Claude chat. Each Paseo workspace keeps its own inbox. A verified fix moves to **Completed** with its pull request and evidence.

## Install on a pilot host

Use Paseo 0.16.1 or later with a daemon runtime that supports `node:sqlite`. The host needs Git and a GitHub CLI session with read access to the workspace's PRs. The agent in the selected chat needs its usual permission to publish fixes.

Check that trusted plugins are enabled for this daemon with `paseo daemon config get pluginsEnabled`. The daemon owner must explicitly opt in when the switch is off. Trusted plugins run with the host user’s file and process access.

Check out the reviewed revision on the daemon machine. From that checkout, install the locked build dependencies and use the Paseo CLI that belongs to the daemon. Use `--home` with the pilot daemon's directory when it differs from the default.

```sh
npm ci --ignore-scripts --include=dev
paseo plugin install "$PWD"
paseo plugin ls task-inbox
```

Paseo loads the installed plugin when its daemon starts. The plugin stores the inbox and screenshots in `$PASEO_HOME/plugin-data/task-inbox/inbox.sqlite3`. The default home is `~/.paseo`. To resume unattended work on restart, the plugin reconnects to this same daemon through its verified loopback listener or user-owned Unix socket.

### Enable screenshots from a phone or remote desktop

On the daemon machine, check `tailscale serve status` and reserve an unused private HTTPS port. The uploader itself listens on IPv4 loopback, port 47831. For example, when 47831 is free:

```sh
tailscale serve --bg --https=47831 http://127.0.0.1:47831
```

In **Task Inbox → Screenshot uploads**, save the HTTPS origin printed by Tailscale Serve, including the port. Open it from a device signed into your tailnet. The uploader requires an identified Tailscale user and accepts one PNG or JPEG per five-minute link. A web browser on the daemon machine can also use the loopback uploader with the setting empty.

## Use the inbox

1. Open **Task Inbox** in the Paseo sidebar and choose the workspace, or open it from that workspace's command center.
2. Add bugs as you find them. Choose **Attach screenshot** on an item and follow its link to the browser picker. Capture uses no agent turns.
3. Select an existing chat and click **Start work**. The selected items and their images form one batch. Later additions stay in the inbox. Each batch accepts up to 20 items and 24 MiB of images, with up to four images of 8 MiB each per item.
4. Follow progress in the workspace and selected chat. A final message in the bound chat shows the outcome without starting another agent turn. Completed items retain their check results and ready PR. Blocked items retain their reason.

The plugin waits for an occupied chat and checks again immediately before sending. Paseo 0.16.1 leaves a small race if another message starts a turn between the check and the send. A persistent message ID lets Paseo recognize the original dispatch after a reconnect.

## How completion is verified

The agent reports the test or manual step it performed and the passing result it observed for each bug. It records the item ID and fix commit in the PR body. The plugin reads the PR from GitHub, confirms the workspace repository, open review-ready status and reported head, and verifies that the commit listed for that item belongs to the PR. Merge and restart follow the workspace owner’s separate authorization.

## Development

Use Node 26 to install the locked development dependencies, type-check the plugin and run its tests. The upload tests open an ephemeral loopback listener.

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
```
