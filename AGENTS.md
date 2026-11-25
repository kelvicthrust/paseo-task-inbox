# Paseo Task Inbox

Task Inbox is a Paseo workspace plugin that captures bugs in Explorer and starts a visible agent chat for a batch. See [the setup guide](README.md) for the workflow and [the release guide](docs/releasing.md) for Paseo compatibility requirements.

- Keep one inbox and at most one active batch per workspace. Reserve the chat ID before creation and reuse it during recovery. A running batch keeps its original workspace, chat, item IDs, image bytes, and dispatch receipt across tab switches, duplicate clicks, and reconnects.
- Mark an item completed only with verification evidence for that bug and a matching ready PR in its workspace repository. Keep unresolved items visible. Merge and deployment have separate authorization.
- Preserve private host storage and the scoped screenshot upload grant. Keep user screenshots, grants, credentials, and raw session transcripts out of Git and logs.
- For every new release, draft [What's new](docs/releasing.md#draft-whats-new) from the changes since the last published tag. Commit `docs/releases/vX.Y.Z.md` in the same PR as the version bump.
- During iteration run the focused Node tests for the behavior being changed. Before submitting runtime changes run `npm run typecheck` and `npm test`. Keep host integration claims specific to the SDK, client, provider, and path actually exercised.
