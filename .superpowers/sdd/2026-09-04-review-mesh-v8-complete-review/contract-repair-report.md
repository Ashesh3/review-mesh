# Contract repair report

## Scope

Implemented the cross-task v8 repair so accepted current reviewer and adjudication results remain complete across stdout, immutable persistence, strict status/report/findings readers, dashboard detail/UI, and Markdown reporting. No version, README release notes, external configuration, or build/release assets were changed.

## RED evidence

- Baseline: `npx vitest run tests/protocol/event-writer.test.ts tests/orchestrator/run-review.test.ts tests/diagnostics/run-recorder.test.ts tests/diagnostics/run-status.test.ts tests/diagnostics/run-report.test.ts tests/server/dashboard-data.test.ts tests/server/dashboard-ui.test.ts tests/adapters/command.test.ts tests/adapters/openai-compatible.test.ts tests/adapters/openai-stream.test.ts tests/config/schemas.test.ts tests/config/manage.test.ts tests/config/resolve.test.ts tests/config/effective.test.ts tests/config/tui.test.ts`
  - 302 passed, 2 skipped, 2 failed: both stuck-heartbeat cases silently resolved instead of surfacing/handling output backpressure correctly.
- Persistence/status/dashboard RED: focused tests for complete adjudication status, compact public result persistence, and exact dashboard result all failed on the old v3-only/truncating/duplicating paths.
- Report/UI RED: compact persisted public result references failed the live public schema, Markdown omitted full reviews, and the dashboard Result UI omitted `review_markdown`.
- Transport/config RED: command output above the old 1/8 MiB caps and a four-fragment result with one whole-result attempt failed; `continuation_attempts` was rejected by schema/resolve/effective paths.
- Whole-run RED: `npx vitest run tests/acceptance/large-artifact.test.ts` rejected a legal five-result artifact above 64 MiB at the fixed status limit.

## GREEN implementation

- Required public lifecycle/result/terminal writes now await real stream backpressure without a shutdown-grace timeout. Optional heartbeats are single-lane, non-overlapping, and droppable before start; a started failed output write fails explicitly.
- The private `reviewer.result` is the sole full artifact record. Persisted public `reviewer.result` and completed `reviewer.terminal` records are integrity references; strict readers join and verify digest/byte count while retaining legacy full-record compatibility.
- Recorder mirror queue accounting uses the compact persisted representation, so legal >1 MiB results do not overflow the old 1 MiB queue.
- Status accepts and verifies both current reviewer and adjudication results. Dashboard detail preserves exact verified results and tuple while bounded metadata remains redacted. Dashboard Result UI and Markdown reports render the complete review.
- Command terminal allowance derives from the 16 MiB accepted result plus worst-case JSON escaping. OpenAI JSON/SSE wire allowance is separately bounded for a worst-case escaped 16 MiB result.
- Schema-v6 `execution.continuation_attempts` (1-10, default/migration 2) flows through manage, resolve, effective/describe, TUI/help, registry/application, and doctor. Continuation fragments have an independent counter from whole-result retry attempts.
- Status/report/dashboard read JSONL incrementally with fatal UTF-8 decoding, an 18 MiB per-record cap, a bounded record count, final active-tail semantics, and post-read file/path identity checks. Strict readers and direct dashboard detail accept legal aggregate artifacts above 64 MiB; dashboard snapshots omit full review text.
- Credential redaction remains at the accepted-result boundary and does not truncate surrounding non-secret review text.

## GREEN evidence

- Final focused contract suite:
  - `npx vitest run tests/protocol/event-writer.test.ts tests/orchestrator/run-review.test.ts tests/diagnostics/run-status.test.ts tests/diagnostics/run-recorder.test.ts tests/diagnostics/run-report.test.ts tests/server/dashboard-data.test.ts tests/server/dashboard-ui.test.ts tests/adapters/command.test.ts tests/adapters/openai-compatible.test.ts tests/adapters/openai-stream.test.ts tests/config/schemas.test.ts tests/config/manage.test.ts tests/config/resolve.test.ts tests/config/effective.test.ts tests/config/tui.test.ts tests/cli/review.test.ts tests/acceptance/large-artifact.test.ts`
  - 17 files passed; 367 passed, 3 skipped.
- `npm run typecheck`
  - PASS (`tsc -p tsconfig.json --noEmit` and `tsc -p tsconfig.test.json --noEmit`).
- Targeted Prettier check over every touched source/test file
  - PASS.
- `git diff --check`
  - PASS.

## Files

Touched adapter transport/registry, configuration schema/manage/resolve/effective/TUI/discovery, event writer/orchestration, recorder/status/report/incremental reader, dashboard data/UI, and corresponding focused/integration/acceptance tests.

## Commit

This report ships in the repair commit `Guarantee end-to-end full review delivery`.

## Caveats

- This repair intentionally does not change the package version, README release notes, external machine configuration, or build/release assets.
- Full standalone/release verification remains outside this repair task.

## Independent review fix round 1

### Findings addressed

1. A permanently pending optional heartbeat could be awaited forever by required/final output.
2. The mirror queue retained the full reviewer result object even though byte accounting used the compact reference.
3. Dashboard readers did not reconcile persisted public result references against the authoritative private tuple.
4. Active readers either skipped post-read identity validation or rejected legitimate append growth.
5. Dashboard snapshots bypassed the aggregate quota for the first large artifact and retained full review payloads.
6. Strict status did not reject records carrying a mismatched run id.
7. Final required mirror append/publication could hang indefinitely.

### RED evidence

- Permanent optional heartbeat regression timed out instead of resolving or rejecting within shutdown grace.
- EventWriter mirror callback received the full 1.1 MiB reviewer result rather than a compact reference.
- Dashboard accepted orphaned and mismatched compact public result references.
- Strict status accepted a private record with another run id.
- Active path replacement tests for status/report initially resolved successfully instead of rejecting.
- A bounded snapshot test showed the first oversized candidate bypassing the aggregate quota.
- Final mirror-close reuse test showed the recorder close callback was invoked twice after a required persistence timeout.

### Fixes

- EventWriter now has a serialized optional-emission path that can be cancelled before physical write, plus an explicit output-failure hook for a started stuck write. Run orchestration bounds optional settlement by shutdown grace and fails explicitly rather than deadlocking or bypassing backpressure.
- The mirror queue now stores `PersistedMirrorEvent`; public reviewer results are converted to digest/byte-count/reference objects before queueing, so the full result is retained only by stdout and the authoritative private record.
- Required final mirror append/close is bounded by the configured mirror timeout, fails as persistence, and reuses one close promise after timeout.
- Dashboard verifies compact public result references against the private authoritative result and rejects missing/mismatched tuples.
- Status validates present run ids against the requested run.
- Status/report/dashboard pin the initial active-file length, read only that stable prefix, tolerate append growth, and still reject pathname/inode replacement. Bigint file identities avoid Windows inode precision loss.
- Dashboard snapshot selection never bypasses its aggregate byte quota. Omitted artifacts appear as explicit compact unreadable summaries in recency order; direct run/reviewer detail remains available and exact.

### GREEN evidence

- Final 17-file focused suite after this round: 17 files passed; 380 passed, 3 skipped.
- Focused active-growth/replacement suite: 6 passed.
- Focused critical heartbeat/compact-mirror suite: passed.
- Focused final mirror append/close timeout suite: passed.
- `npm run typecheck`: passed.
- Targeted Prettier check: passed.
- `git diff --check`: passed.

## Independent review fix round 2

### Finding addressed

Status accepted recognized current public events and private records whose `run_id` was absent. Historical public schema-v3/v4 envelopes and every private record schema since their introduction required `run_id`, so there is no supported missing-identity legacy form to preserve.

### RED evidence

- Focused missing-identity test: 3 failed. A schema-v5 `run.started`, private `reviewer.result`, and private `context` all resolved instead of rejecting.

### Fix

- Status now requires every recognized object (`record` or `event`) to carry a non-empty `run_id` equal to the requested run. Unrecognized JSON objects retain the prior ignore behavior.
- Existing schema-v4 status fixtures with valid `run_id` remain readable, preserving the actual legacy contract without inventing an unsupported missing-id exception.

### GREEN evidence

- Focused identity tests: 4 passed.
- Full status suite: 21 passed.
- Final 17-file focused suite: 17 files passed; 383 passed, 3 skipped.
- `npm run typecheck`: passed.
- Targeted Prettier check: passed.
- `git diff --check`: passed.
