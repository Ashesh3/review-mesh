# Task 1 Report: Lossless reviewer results and run-bound persistence

## Status

Implemented the Task 1 contract: reviewer result v3, lossless result sanitization,
canonical SHA-256 digests, run-bound private records, immutable full-result
persistence, `reviewer.result` public events, result manifests, and default
`full-jsonl` delivery with explicit `compact-jsonl` compatibility mode.

## Implementation

- Added reviewer result schema version `3` with required `review_markdown`, the
  existing structured fields, and v3 finding category/verification/change-impact
  metadata. Reviewer result v1/v2 remain accepted for artifact compatibility.
- Added `sanitizeReviewerResult(value)` as the single accepted-result boundary.
  It recursively redacts credential-shaped keys/text, performs no per-string
  truncation, validates the v3 result, and rejects serialized results above
  16 MiB with `ResultSanitizationError.code = "result_too_large"`.
- Added `reviewerResultDigest(result)`, using lowercase SHA-256 over canonical
  JSON with recursively sorted object keys.
- Changed provider-facing JSON Schema generation and command-adapter validation
  to v3.
- Made `EventWriter.record()` inject the current `run_id` and reject a mismatched
  caller-supplied value. All orchestrator private-record producers now use this
  run-bound boundary, fixing the prior context-record omission at the producer.
- Exempted accepted `reviewer.result` records from the recorder's generic 64 KiB
  diagnostic-string truncation while retaining the generic bound for all other
  private diagnostics.
- Persisted the exact accepted sanitized result together with `digest` and
  `byte_count`; full mode emits that same object in `reviewer.result`.
- Added `run.completed.data.result_manifest` and `results_complete: true` after
  all result events are written successfully. Existing stdout failure handling
  prevents a failed/closed output stream from publishing a successful terminal
  assertion.
- Added `full-jsonl` and `compact-jsonl` output modes. Application/CLI default to
  `full-jsonl`; compact mode omits `reviewer.result` payloads but keeps the
  artifact/digest manifest.
- Extended strict run-report/status readers and discovery schemas for v3/full
  result records while preserving legacy schemas.

## Files

Created:

- `src/results/sanitize.ts`
- `src/results/digest.ts`
- `tests/results/sanitize.test.ts`

Modified:

- `src/protocol/schemas.ts`
- `src/protocol/json-schema.ts`
- `src/protocol/event-writer.ts`
- `src/diagnostics/run-recorder.ts`
- `src/diagnostics/run-report.ts`
- `src/diagnostics/run-status.ts`
- `src/orchestrator/run-review.ts`
- `src/app.ts`
- `src/cli.ts`
- `src/discovery/description.ts`
- `src/discovery/help.ts`
- `src/discovery/schema.ts`
- `src/adapters/command.ts`
- `src/adapters/errors.ts`
- `tests/protocol/schemas.test.ts`
- `tests/protocol/event-writer.test.ts`
- `tests/diagnostics/run-recorder.test.ts`
- `tests/orchestrator/run-review.test.ts`
- `tests/cli/review.test.ts`
- `tests/helpers/fixtures.ts`
- `tests/fixtures/command-adapter.mjs`

## RED evidence

Command:

`npx vitest run tests/protocol/schemas.test.ts tests/results/sanitize.test.ts`

Result: failed as intended. `reviewerResultV3Schema` was undefined and
`src/results/digest.js` / sanitizer modules did not exist. The schema test also
failed at the missing v3 parser. This demonstrated the tests exercised the new
contract rather than pre-existing behavior.

Command:

`npx vitest run tests/protocol/event-writer.test.ts tests/diagnostics/run-recorder.test.ts tests/diagnostics/run-report.test.ts tests/diagnostics/run-status.test.ts tests/orchestrator/run-review.test.ts tests/cli/review.test.ts`

Result: the new tests failed as intended: two event-writer run-id tests, one
lossless recorder test, and the full/compact orchestrator tests failed because
run-bound records, untruncated accepted-result persistence, public full-result
events, manifests, and output modes were absent.

## GREEN evidence

Command:

`npx vitest run tests/protocol/schemas.test.ts tests/results/sanitize.test.ts`

Result: 2 files passed, 16 tests passed.

Command:

`npx vitest run tests/results/sanitize.test.ts tests/protocol/schemas.test.ts tests/protocol/event-writer.test.ts tests/diagnostics/run-recorder.test.ts tests/diagnostics/run-report.test.ts tests/diagnostics/run-status.test.ts tests/orchestrator/run-review.test.ts tests/cli/review.test.ts tests/acceptance/compiled-cli.test.ts --reporter=dot`

Result: 9 files passed, 171 tests passed, 1 skipped; duration 112.31 seconds.
This is the exact Task 1 verification set from the brief and includes compiled
CLI acceptance, lossless redaction equality, full/compact delivery, and strict
artifact readers.

Command:

`npm run typecheck`

Result: passed for both production and test TypeScript projects after the final
reader/discovery changes.

Command:

`npx vitest run tests/diagnostics/run-report.test.ts tests/diagnostics/run-status.test.ts --reporter=dot`

Result: 2 files passed, 27 tests passed after the report/status integration.

Command:

`git diff --check`

Result: passed.

## Self-review

- Confirmed the accepted sanitized result object is reused for state, private
  persistence, public full output, byte count, and digest; no summary object is
  substituted for full delivery.
- Confirmed generic diagnostic records retain their existing 64 KiB string
  bound; only already-validated reviewer-result records bypass it.
- Confirmed run-bound persistence rejects mismatched IDs and fixes the context
  producer without weakening strict readers.
- Confirmed result digests are independent of object insertion order.
- Confirmed lifecycle summaries remain compact and the explicit
  `reviewer.result` event is the only unbounded public payload.
- Confirmed the existing sticky stdout/backpressure behavior remains the
  authority for whether `run.completed.results_complete` can be emitted.
- Reviewed the diff for unrelated outer-checkout or machine changes; none were
  made.

## Concerns

- A duplicate rerun of the exact 9-file set was manually interrupted after
  roughly 60 seconds on direct instruction to finalize. It had emitted only
  progress dots and no failure. The immediately preceding complete run of the
  same command passed 171 tests with 1 skipped, and the post-change typecheck
  plus focused report/status suite passed.
- Native SDK adapters still contain their own v2 parsing points. Task 1 changes
  the provider-facing schema and core acceptance path; follow-on provider work
  (Task 2) is expected to align those adapter-specific finalization paths with
  v3 while adding continuation/streaming behavior.

## Fix round: six review findings

### Implementation

1. Made persisted `reviewer.result` authoritative over later terminal copies.
   Its reader priority is now strictly higher, and equal/lower-priority records
   cannot overwrite it.
2. Made `compact-jsonl` automatically publish the immutable internal run
   artifact even when configured persistence is disabled and no details file is
   supplied. The terminal manifest points to that artifact.
3. Added strict private `reviewer.result` parsing to run status. Status exposes
   the complete result, digest, and byte count from compact artifacts and keeps
   the full record authoritative over the terminal summary/copy.
4. Made result-record persistence required. A failed result write terminalizes
   the reviewer with `persistence_failed`, returns incomplete/exit 3, leaves the
   manifest empty, and emits `results_complete: false` instead of claiming
   completeness.
5. Reworked URL sanitization to preserve benign query keys, values, order, and
   surrounding text. It redacts credential-shaped parameter keys and also
   credential-shaped values under otherwise benign keys.
6. Made `digest` and `byte_count` mandatory for persisted v3 result records.
   Strict report/status readers recompute both from the accepted object and
   reject missing or mismatched values with the exact `reviewer.result` record,
   line, and `digest`/`byte_count` schema path. Legacy v1/v2 records retain
   optional integrity metadata and remain readable.

### RED evidence

Command:

`npx vitest run tests/results/sanitize.test.ts tests/diagnostics/run-report.test.ts tests/diagnostics/run-status.test.ts tests/orchestrator/run-review.test.ts tests/cli/review.test.ts --reporter=verbose`

Result: failed on the new regressions as intended. Observed failures were:

- run status did not load a private v3 result and accepted a wrong digest;
- sanitizer replaced the complete URL query rather than preserving benign
  parameters;
- run report allowed the terminal copy to replace the full result and accepted
  missing/wrong integrity fields;
- orchestrator returned passed/results-complete after a failed result record;
- compact mode produced no durable artifact reference.

An additional failing test proved a credential-shaped GitHub token under a
benign query key was initially preserved, requiring value-sensitive redaction.

### GREEN evidence

Command:

`npm run typecheck`

Result: PASS. Both production and test TypeScript projects completed with exit
code 0.

Command:

`npx vitest run tests/results/sanitize.test.ts tests/diagnostics/run-report.test.ts tests/diagnostics/run-status.test.ts tests/orchestrator/run-review.test.ts tests/cli/review.test.ts --reporter=dot`

Result: PASS. 5 test files passed; 112 tests passed; 1 skipped; duration 115.61
seconds in the worker run. The controller independently reran the same command:
5 files passed, 112 passed, 1 skipped, duration 114.93 seconds.

### Fix-round self-review

- Verified authoritative precedence is monotonic: private full results use
  priority 3, terminals priority 2, and replacement requires strictly greater
  priority.
- Verified v3 integrity is checked twice at strict reader boundaries: required
  field shape first, then recomputed digest and serialized byte count.
- Verified v1/v2 compatibility remains through the legacy result-record branch.
- Verified compact output does not regain a stdout payload; it gains only the
  required durable artifact and manifest reference.
- Verified result manifest entries are added only after the required private
  result write succeeds.
- Verified ordinary non-result diagnostics remain best-effort and bounded;
  only the completeness-critical result record is promoted to required.
- Verified URL redaction does not round-trip through URL serialization, so
  benign query spelling/order is preserved rather than normalized.
- Verified no outer checkout, machine configuration, or unrelated project file
  was modified.

### Fix-round concerns

None for the six reviewed findings. Provider-specific v3/continuation work
remains explicitly assigned to Task 2, as noted above.
