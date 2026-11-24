# Paseo Task Inbox

Task Inbox is a private Paseo sidebar plugin for collecting bugs while testing and dispatching a batch to an existing chat. See [the setup guide](README.md) for host requirements and the capture workflow.

- Keep workspace, selected chat, item IDs, image bytes, and dispatch receipts bound together. A double-click or reconnect must preserve the identity of a batch already sent.
- Mark an item completed only with verification evidence for that bug and a matching ready PR in its workspace repository. Keep unresolved items visible. Merge and deployment have separate authorization.
- Preserve private host storage and the scoped screenshot upload grant. Keep images, grants, credentials, and raw session transcripts out of Git and logs.
- During iteration run the focused Node tests for the behavior being changed. Before submitting runtime changes run `npm run typecheck` and `npm test`. Keep host integration claims specific to the SDK, client, provider, and path actually exercised.
