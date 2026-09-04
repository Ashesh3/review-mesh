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
