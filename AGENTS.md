# Paseo Task Inbox

Task Inbox is a Paseo workspace plugin that captures bugs in Explorer and sends a batch to the active chat in the main pane. See [the setup guide](README.md) for the published and preview workflows. See [the release guide](docs/releasing.md) for Paseo compatibility requirements.

- Keep one inbox and at most one active batch per workspace. The host's active chat sets the next batch destination. A running batch keeps its original workspace, chat, item IDs, image bytes, and dispatch receipt across tab switches, duplicate clicks, and reconnects.
- Mark an item completed only with verification evidence for that bug and a matching ready PR in its workspace repository. Keep unresolved items visible. Merge and deployment have separate authorization.
- Preserve private host storage and the scoped screenshot upload grant. Keep user screenshots, grants, credentials, and raw session transcripts out of Git and logs.
- During iteration run the focused Node tests for the behavior being changed. Before submitting runtime changes run `npm run typecheck` and `npm test`. Keep host integration claims specific to the SDK, client, provider, and path actually exercised.
