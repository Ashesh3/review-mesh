# Adapter review fix report

Implemented all six adapter-review findings within the assigned adapter scope.

- Claude and Copilot defer observed-read credit until a native SDK admission event carries the exact model-facing tool-result text.
- Claude and Copilot record captured diff delivery only after the initial SDK request returns a response and only when the prompt includes the complete untruncated diff.
- Claude multi-page output resumes from an adapter-owned persisted session under an isolated temporary `CLAUDE_CONFIG_DIR`, which is removed when the adapter run ends.
- OpenAI inspection, Claude, Copilot, Codex, and command-v2 emit stable identities and byte progress where the runtime exposes them. Command-v1 reports `progress_observable: false`; command-v2 rejects identity-less meaningful progress/activity.
- OpenAI, Claude, Copilot, Codex, and command page results expose spool-backed `resultStorage.pages()` entries with raw text and SHA-256 before persistence wipes the spools. Incomplete chains are abandoned for bounded diagnostics.
- Result-page failures preserve typed v9 reasons and received-byte diagnostics. Claude `max_tokens` and Copilot `assistant.usage.finishReason === "length"` map to `output_truncated` before page parsing.

Claude Agent SDK exposes `structured_output` as a parsed object rather than the provider's original JSON bytes. Claude pages therefore use deterministic `JSON.stringify` bytes and mark `resultStorage.serializationBoundary` as `sdk_canonical_json`. Copilot, Codex, command, and OpenAI retain the text or bytes exposed by their native result carrier.

Verification:

- Focused adapter suite: 248 passed, 2 skipped.
- Production TypeScript compile: passed.
- Test TypeScript compile has unrelated concurrent v9 acceptance failures outside adapter scope; no adapter or adapter-test diagnostics remain.
