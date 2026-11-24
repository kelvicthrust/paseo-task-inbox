# Task Inbox

Collect bugs and screenshots in a Paseo workspace while you test. When you are ready, select the bugs to fix and send them as one batch to an existing chat. You can keep capturing bugs while the chat works through the batch.

Open **+ → Task Inbox** in the workspace's right-side Explorer or choose **Open Task Inbox** in the workspace Command Center. All chats in the workspace share the inbox. Add a description and use **Attach screenshot** for a PNG or JPEG. Select a chat tab in the main workspace pane, check the **Send to** label, and choose **Start work** for the selected bugs. You can keep capturing bugs when the main pane shows a terminal or when your app needs an update to start work.

Starting work from Explorer requires a Paseo app that provides the active chat to workspace panels. The daemon's Node.js runtime must support SQLite. Dispatch and verification also need a workspace with a GitHub origin, Git and authenticated GitHub CLI on the host, and an existing chat that can publish a fix PR. The screenshot picker uses a local browser on the daemon host or a private Tailscale Serve address for remote uploads. Upload links accept one image and expire after five minutes.

Each workspace can have one active batch. A busy chat queues the batch, and the batch and its result stay with the original chat when you switch tabs or reconnect. The plugin marks a bug complete after the agent reports a passing check and GitHub confirms the matching fix evidence on an open, ready PR in the workspace repository. Blocked bugs keep their status and explanation. Merging and deploying require separate authorization.

Task Inbox runs with the daemon user's access. It stores bug reports, screenshots, and delivery records in a private SQLite database under the Paseo home. When you send a batch, its descriptions and images go to the selected chat and its configured provider. The plugin reads that chat's projected activity and results and uses the host's GitHub CLI session to read the reported PR. If the daemon restarts and the restored chat history cannot identify the original turn, the plugin preserves the delivery receipt and leaves the batch blocked.

The catalog screenshot uses sample data.
