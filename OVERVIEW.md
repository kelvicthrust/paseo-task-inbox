# Task Inbox

Collect bugs and screenshots in a Paseo workspace while you test. Select the bugs you want fixed and start a batch. Task Inbox opens a chat for that batch, and you can keep capturing bugs while the agent works.

Open **+ → Task Inbox** in the workspace's right-side Explorer or choose **Open Task Inbox** in the workspace Command Center. All tabs in the workspace share the inbox. On Desktop and web, write a description and attach, paste or drop a screenshot before choosing **Add task**. Use a waiting task’s menu to edit its text and screenshots or delete it. Select the bugs to send, check the configured model, and start the batch. Select **Open chat** to follow the batch in its chat.

Use Paseo Desktop 0.17.4 or later and a daemon whose Node.js runtime supports SQLite. Choose an available Codex or Claude Code model in **Task Inbox agent** settings. Dispatch and verification need a workspace with a GitHub origin, Git, and an authenticated GitHub CLI on the host. Desktop and web uploads use the existing Paseo connection. Native mobile clients can attach to a saved report through a private Tailscale Serve address. Each mobile upload link accepts one image and expires after five minutes.

Each workspace can have one active batch. A busy chat queues the batch, and the batch and its result stay with the original chat when you switch tabs or reconnect. The plugin marks a bug complete after the agent reports a passing check and GitHub confirms the matching fix evidence on an open, ready PR in the workspace repository. Blocked bugs keep their status and explanation. Merging and deploying require separate authorization.

Task Inbox runs with the daemon user's access. It stores bug reports, screenshots, and delivery records in a private SQLite database under the Paseo home. When you send a batch, its descriptions and images go to the selected chat and its configured provider. The plugin reads that chat's projected activity and results and uses the host's GitHub CLI session to read the reported PR. If the daemon restarts and the restored chat history cannot identify the original turn, the plugin preserves the delivery receipt and leaves the batch blocked.

The catalog screenshot uses sample data.
