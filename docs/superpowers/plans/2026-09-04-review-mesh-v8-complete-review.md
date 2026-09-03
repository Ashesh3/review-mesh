# Review Mesh v8 Complete Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver every complete validated reviewer result losslessly to the original CLI caller while fixing the remaining persistence, provider, doctor, deduplication, adjudication, and policy defects.

**Architecture:** A single sanitized reviewer-result object and digest flow from adapter validation through orchestration, full stdout, immutable persistence, reporting, and the dashboard. Shared findings and adjudication modules provide deterministic live/report semantics; schema-v6 configuration makes topology, quorum, applicability, and required inputs explicit. The OpenAI-compatible adapter gains exact continuation and bounded SSE reconstruction, and doctor invokes the same execution mechanism as a real reviewer.

**Tech Stack:** TypeScript 5.9, Node.js 22+, Zod 4, Vitest 4, Bun 1.4 standalone builds.

**Spec:** `docs/superpowers/specs/2026-09-04-review-mesh-v8-complete-review-design.md`

## Global Constraints

- The complete sanitized reviewer result is the unit of truth; no consumer may summarize, shorten, omit, or silently truncate it.
- Credential-shaped values remain redacted before public or persistent output.
- The exact accepted result object and SHA-256 digest must agree across full stdout, immutable artifact, report, findings, and dashboard consumers.
- Any 16 MiB result-size, stdout, persistence, disk, or deadline limit fails explicitly; it never substitutes shortened content.
- `review-mesh review` defaults to `full-jsonl`; `compact-jsonl` remains explicit compatibility mode.
- Public lifecycle events remain bounded except the explicit full `reviewer.result` payload.
- Same-version strict status/report/findings round-trip is a release gate.
- Raw findings and complete reviews remain available after adjudication and consolidation.
- New implementation follows failing-test-first TDD; every task records RED and GREEN commands.
- Preserve existing v1/v2 reviewer-result and v1-v5 configuration/artifact read compatibility.
- Do not edit or consume the user's unrelated outer-checkout changes.
- Release version is `8.0.0` because the default CLI output contract changes.

---

### Task 1: Lossless reviewer results and run-bound persistence

**Files:**
- Create: `src/results/sanitize.ts`
- Create: `src/results/digest.ts`
- Modify: `src/protocol/schemas.ts`
- Modify: `src/protocol/json-schema.ts`
- Modify: `src/protocol/event-writer.ts`
- Modify: `src/diagnostics/run-recorder.ts`
- Modify: `src/diagnostics/run-report.ts`
- Modify: `src/diagnostics/run-status.ts`
- Modify: `src/orchestrator/run-review.ts`
- Modify: `src/orchestrator/state.ts`
- Modify: `src/app.ts`
- Modify: `src/cli.ts`
- Modify: `src/discovery/description.ts`
- Modify: `src/discovery/help.ts`
- Modify: `src/discovery/schema.ts`
- Test: `tests/protocol/schemas.test.ts`
- Test: `tests/protocol/event-writer.test.ts`
- Test: `tests/diagnostics/run-recorder.test.ts`
- Test: `tests/diagnostics/run-report.test.ts`
- Test: `tests/diagnostics/run-status.test.ts`
- Test: `tests/orchestrator/run-review.test.ts`
- Test: `tests/cli/review.test.ts`
- Test: `tests/acceptance/compiled-cli.test.ts`

**Interfaces:**
- Produces `sanitizeReviewerResult(value): ReviewerResultV3`, which redacts credential-shaped text without length truncation and rejects serialized output above 16 MiB.
- Produces `reviewerResultDigest(result): string`, the lowercase SHA-256 of canonical JSON for the accepted sanitized result.
- Produces `RunBoundRecordWriter.record(recordWithoutRunId)`, which injects and validates the current `run_id` before persistence.
- Adds public `reviewer.result` events and `run.completed.data.result_manifest` / `results_complete`.
- Adds CLI output modes `full-jsonl` and `compact-jsonl`; default is `full-jsonl`.

- [ ] **Step 1: Write failing schema and sanitization tests**

Add tests proving reviewer-result v3 accepts a `review_markdown` string larger than 8 KiB; credentials are redacted without changing surrounding review text; v1/v2 remain readable; serialized sanitized results above 16 MiB fail with `result_too_large`; and the digest is stable across equivalent objects.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npx vitest run tests/protocol/schemas.test.ts tests/results/sanitize.test.ts`

Expected: FAIL because reviewer-result v3, lossless sanitizer, and digest module do not exist.

- [ ] **Step 3: Implement reviewer-result v3 and the single sanitization/digest boundary**

Implement the interfaces above. Remove per-field truncation from the accepted result path while retaining explicit 16 MiB validation. Generate the provider-facing JSON Schema from v3.

- [ ] **Step 4: Write failing full-output and run-bound writer tests**

Add tests proving `EventWriter.record` injects `run_id`; a real `runReviewApplication` invocation persists a context record readable in strict mode; full mode emits the exact result and digest; compact mode omits the payload but retains its artifact reference; closed stdout cannot emit `results_complete: true`.

- [ ] **Step 5: Run the integration tests and verify RED**

Run: `npx vitest run tests/protocol/event-writer.test.ts tests/diagnostics/run-recorder.test.ts tests/diagnostics/run-report.test.ts tests/diagnostics/run-status.test.ts tests/orchestrator/run-review.test.ts tests/cli/review.test.ts`

Expected: FAIL because private records can omit `run_id` and full-result events/output modes are absent.

- [ ] **Step 6: Implement run-bound persistence and full CLI delivery**

Route every private record through the run-bound writer. Persist and emit the same sanitized object/digest. Default review output to `full-jsonl`; preserve `compact-jsonl`. Ensure lifecycle/event summaries cannot replace the result payload.

- [ ] **Step 7: Verify Task 1 GREEN**

Run: `npx vitest run tests/results/sanitize.test.ts tests/protocol/schemas.test.ts tests/protocol/event-writer.test.ts tests/diagnostics/run-recorder.test.ts tests/diagnostics/run-report.test.ts tests/diagnostics/run-status.test.ts tests/orchestrator/run-review.test.ts tests/cli/review.test.ts tests/acceptance/compiled-cli.test.ts`

Expected: PASS, including byte-for-byte post-redaction equality and strict produced-artifact round trip.

- [ ] **Step 8: Commit Task 1**

Commit message: `Add lossless full review delivery`

---

### Task 2: Exact continuation, streaming transport, and doctor parity

**Files:**
- Create: `src/adapters/openai-stream.ts`
- Create: `src/adapters/result-spool.ts`
- Modify: `src/adapters/openai-compatible.ts`
- Modify: `src/adapters/errors.ts`
- Modify: `src/adapters/types.ts`
- Modify: `src/config/schemas.ts`
- Modify: `src/config/manage.ts`
- Modify: `src/config/resolve.ts`
- Modify: `src/config/effective.ts`
- Modify: `src/config/tui.ts`
- Modify: `src/cli.ts`
- Modify: `src/discovery/description.ts`
- Modify: `src/discovery/help.ts`
- Test: `tests/adapters/openai-stream.test.ts`
- Test: `tests/adapters/result-spool.test.ts`
- Test: `tests/adapters/openai-compatible.test.ts`
- Test: `tests/adapters/errors.test.ts`
- Test: `tests/config/resolve.test.ts`
- Test: `tests/config/manage.test.ts`
- Test: `tests/config/effective.test.ts`
- Test: `tests/config/tui.test.ts`
- Test: `tests/cli/report.test.ts`

**Interfaces:**
- Produces a bounded SSE parser that reconstructs assistant content, tool-call IDs/names/arguments, finish reason, and optional usage.
- Produces a result spool with append/read/cleanup semantics, 16 MiB total limit, no symlink following, and no reviewed-workspace visibility.
- Adds OpenAI-compatible `streaming = "auto" | "required" | "disabled"`.
- Adds one in-place retry for `provider_response_invalid` before reviewer failure.
- Replaces compact truncation recovery with exact continuation assembly.
- Makes doctor invoke the real reviewer execution mechanism and return stage-specific typed diagnostics.

- [ ] **Step 1: Write failing SSE and spool tests**

Cover fragmented UTF-8/SSE lines, `[DONE]`, content deltas, split tool-call arguments, finish reasons, malformed/oversize streams, cancellation, spool identity checks, cleanup, and 16 MiB rejection.

- [ ] **Step 2: Run SSE/spool tests and verify RED**

Run: `npx vitest run tests/adapters/openai-stream.test.ts tests/adapters/result-spool.test.ts`

Expected: FAIL because both modules are absent.

- [ ] **Step 3: Implement the bounded streaming and spool primitives**

Keep these modules provider-independent and separately testable. Do not add review logic here.

- [ ] **Step 4: Write failing adapter/doctor behavior tests**

Cover auto streaming, required-stream failure, unsupported-stream non-stream fallback, exact multi-fragment continuation with no compact/shorten prompt, no repeated repository tools, empty choices retried once in place, model effort forwarded by doctor, tool-stage errors correctly labeled, and full diagnostics retained.

- [ ] **Step 5: Run adapter/doctor tests and verify RED**

Run: `npx vitest run tests/adapters/openai-compatible.test.ts tests/cli/report.test.ts tests/config/resolve.test.ts tests/config/manage.test.ts`

Expected: FAIL on current one-shot JSON transport, compact recovery prompt, and synthetic doctor implementation.

- [ ] **Step 6: Integrate streaming, continuation, transient envelope retry, and doctor parity**

Use the same `run()` path for doctor against a synthetic temporary workspace, selected effort, and v3 result schema. Expose stage-specific checks from real adapter events/diagnostics.

- [ ] **Step 7: Verify Task 2 GREEN**

Run: `npx vitest run tests/adapters/openai-stream.test.ts tests/adapters/result-spool.test.ts tests/adapters/openai-compatible.test.ts tests/adapters/errors.test.ts tests/config/resolve.test.ts tests/config/manage.test.ts tests/config/effective.test.ts tests/config/tui.test.ts tests/cli/report.test.ts`

Expected: PASS with exact continuation bytes and no reinspection.

- [ ] **Step 8: Commit Task 2**

Commit message: `Align provider recovery and doctor execution`

---

### Task 3: Canonical findings and enforceable adjudication

**Files:**
- Create: `src/findings/canonical.ts`
- Create: `src/findings/adjudication.ts`
- Modify: `src/protocol/schemas.ts`
- Modify: `src/protocol/json-schema.ts`
- Modify: `src/protocol/prompt.ts`
- Modify: `src/orchestrator/state.ts`
- Modify: `src/orchestrator/run-review.ts`
- Modify: `src/diagnostics/run-report.ts`
- Modify: `src/server/dashboard-data.ts`
- Test: `tests/findings/canonical.test.ts`
- Test: `tests/findings/adjudication.test.ts`
- Test: `tests/protocol/prompt.test.ts`
- Test: `tests/orchestrator/state.test.ts`
- Test: `tests/orchestrator/review-feedback.test.ts`
- Test: `tests/diagnostics/run-report.test.ts`
- Test: `tests/server/dashboard-data.test.ts`

**Interfaces:**
- Produces `canonicalizeFindings(rawFindings): CanonicalFindingSet` with raw, consolidated, gate-effective, and advisory collections/counts.
- Produces `validateAdjudication(candidateResult, adjudicationResult, context): AdjudicationOutcome`.
- Adds a dedicated adjudication-result schema keyed to source finding IDs.
- Makes live completion counts and report/findings use the same canonical set.

- [ ] **Step 1: Write failing canonicalization tests**

Cover confirming adjudicators, rejected sources, explicit roots, rootless findings with identical titles/different descriptions, ambiguous identical titles, explicit duplicate references, stable ordering, and equality between completion/report deduplicated counts.

- [ ] **Step 2: Run canonicalization tests and verify RED**

Run: `npx vitest run tests/findings/canonical.test.ts tests/orchestrator/state.test.ts tests/diagnostics/run-report.test.ts`

Expected: FAIL because live and report paths use distinct algorithms.

- [ ] **Step 3: Implement and integrate the shared canonical findings module**

Remove duplicate consolidation implementations. Retain every raw source and every full review. Rename/count raw, unique, gate, and advisory populations explicitly.

- [ ] **Step 4: Write failing adjudication-proof tests**

Create the reported contradiction: a candidate says an enum throws post-ingest while cited ordering proves mapping occurs pre-ingest. Assert that an adjudication without an ordered two-step proof and base/head comparison cannot gate, is classified `needs_verification`, and remains visible in raw results.

- [ ] **Step 5: Run adjudication tests and verify RED**

Run: `npx vitest run tests/findings/adjudication.test.ts tests/orchestrator/review-feedback.test.ts tests/protocol/prompt.test.ts`

Expected: FAIL because v7 trusts ordinary adjudicator findings.

- [ ] **Step 6: Implement dedicated adjudication schema and mechanical validation**

Generate a candidate-ID-bound schema/prompt. Require ordered proof for reliability/concurrency/lifecycle/cleanup and base/head proof for change-scoped confirmed decisions. Downgrade invalid proof without deleting reviews.

- [ ] **Step 7: Verify Task 3 GREEN**

Run: `npx vitest run tests/findings/canonical.test.ts tests/findings/adjudication.test.ts tests/protocol/prompt.test.ts tests/orchestrator/state.test.ts tests/orchestrator/review-feedback.test.ts tests/diagnostics/run-report.test.ts tests/server/dashboard-data.test.ts`

Expected: PASS; one canonical count appears everywhere and contradictory proof cannot gate.

- [ ] **Step 8: Commit Task 3**

Commit message: `Unify findings and enforce adjudication proof`

---

### Task 4: Schema-v6 resilient policy and active configuration migration

**Files:**
- Modify: `src/config/schemas.ts`
- Modify: `src/config/manage.ts`
- Modify: `src/config/resolve.ts`
- Modify: `src/config/effective.ts`
- Modify: `src/config/tui.ts`
- Modify: `src/orchestrator/lens-policy.ts`
- Modify: `src/orchestrator/run-review.ts`
- Modify: `src/discovery/schema.ts`
- Modify: `src/discovery/help.ts`
- Test: `tests/config/schemas.test.ts`
- Test: `tests/config/manage.test.ts`
- Test: `tests/config/resolve.test.ts`
- Test: `tests/config/effective.test.ts`
- Test: `tests/config/tui.test.ts`
- Test: `tests/orchestrator/lens-policy.test.ts`
- Test: `tests/orchestrator/review-feedback.test.ts`
- External update after source release gates: `C:\Users\asheshkumar\AppData\Roaming\review-mesh\Config\config.toml`

**Interfaces:**
- Adds trusted configuration schema version `6`.
- Adds explicit applicability discriminant `always | changed_paths` and required `required_context` arrays.
- Adds `execution.allow_provider_concentration` and per-lens `allow_zero_outage_tolerance`.
- Defaults five-model lenses to pass quorum 3/provider groups 3.

- [ ] **Step 1: Write failing schema-v6 validation tests**

Cover missing explicit applicability/context, concentrated primaries rejected unless acknowledged, strict 5/5 rejected unless acknowledged, default 3/3 five-model quorum, distributed primaries, and legacy migration to explicit always/empty policies without invented semantics.

- [ ] **Step 2: Run configuration tests and verify RED**

Run: `npx vitest run tests/config/schemas.test.ts tests/config/manage.test.ts tests/config/resolve.test.ts tests/orchestrator/lens-policy.test.ts`

Expected: FAIL because schema v6 and acknowledgements do not exist.

- [ ] **Step 3: Implement schema-v6 policy and migration**

Update safe effective views, TUI, JSON schema, and help. Preserve read compatibility for v1-v5 and require schema-v6 saves.

- [ ] **Step 4: Write failing end-to-end applicability/quorum tests**

Assert a deployment lens with unmatched declared paths runs zero provider calls; change readiness without required PR context runs zero calls and reports missing input; distributed five-model lenses tolerate two provider failures and pass at 3/3.

- [ ] **Step 5: Run orchestration policy tests and verify RED**

Run: `npx vitest run tests/orchestrator/review-feedback.test.ts tests/config/effective.test.ts tests/config/tui.test.ts`

Expected: FAIL until schema-v6 policies reach the orchestrator.

- [ ] **Step 6: Integrate policy behavior and machine-readable diagnostics**

Surface exact provider topology, outage tolerance, applicability mode, and required context in `describe`/`config effective`.

- [ ] **Step 7: Verify Task 4 GREEN**

Run: `npx vitest run tests/config/schemas.test.ts tests/config/manage.test.ts tests/config/resolve.test.ts tests/config/effective.test.ts tests/config/tui.test.ts tests/orchestrator/lens-policy.test.ts tests/orchestrator/review-feedback.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit Task 4**

Commit message: `Require resilient explicit lens policy`

---

### Task 5: v8 integration, documentation, machine configuration, and release

**Files:**
- Modify: `README.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `tests/acceptance/portable-cli.test.ts`
- Modify: `tests/acceptance/standalone-cli.test.ts`
- Modify: `tests/acceptance/compiled-cli.test.ts`
- External update after backup: `C:\Users\asheshkumar\AppData\Roaming\review-mesh\Config\config.toml`

**Interfaces:**
- Publishes version `8.0.0` with portable JS, Windows x64, Linux x64, and `SHA256SUMS.txt`.
- Migrates the active machine configuration through `config export`/`config apply` with a timestamped backup and exact post-write `describe` validation.

- [ ] **Step 1: Add failing acceptance tests for the default full review contract**

Assert source, portable, Windows standalone, and Linux standalone expose version 8.0.0, default to `full-jsonl`, emit full result payloads/digests, strictly read their own artifacts, and report canonical counts.

- [ ] **Step 2: Run acceptance tests and verify RED**

Run: `npx vitest run tests/acceptance/compiled-cli.test.ts tests/acceptance/portable-cli.test.ts tests/acceptance/standalone-cli.test.ts`

Expected: FAIL before the version/docs/build updates.

- [ ] **Step 3: Update version and documentation**

Document the breaking output/config contracts, exact full/compact invocation, artifact guarantees, continuation behavior, streaming caveats, doctor semantics, counts, and migration guidance.

- [ ] **Step 4: Run complete source verification**

Run: `npm run verify`

Expected: PASS without modifying unrelated baseline files.

- [ ] **Step 5: Run an independent whole-branch review**

Review against the spec and this plan. Any Critical or Important finding must be fixed and re-reviewed before release. The reviewer must explicitly verify losslessness, artifact round-trip, provider recovery, adjudication enforcement, canonical counts, policy migration, and secret handling.

- [ ] **Step 6: Build and verify standalone artifacts**

Run: `npm run verify:standalone` with the official SHA-256-verified Bun 1.4.0 Linux runtime supplied through `BUN_LINUX_X64_EXE` if Bun download TLS fails.

Expected: Windows/Linux binaries pass acceptance and match `SHA256SUMS.txt`.

- [ ] **Step 7: Migrate active machine configuration safely**

First copy the exact current config to `config.toml.pre-v8-<timestamp>.bak`. Export/transform/apply through Review Mesh's CAS interface. If the active config is not the eight-lens suite described by the user, migrate only its schema/mechanism defaults and do not invent lens mappings. Verify with `review-mesh describe . --json` and `review-mesh doctor . --structured-output`; report any external provider failures separately.

- [ ] **Step 8: Commit Task 5**

Commit message: `Release Review Mesh v8.0.0`

- [ ] **Step 9: Integrate and publish**

Verify `HEAD` descends from current `origin/main`, fast-forward main, push source, create annotated `v8.0.0`, publish the three assets, download them into a fresh temporary directory, and compare hashes.

- [ ] **Step 10: Verify remote release state**

Confirm `HEAD == origin/main == v8.0.0^{}`, the release is neither draft nor prerelease, every asset is uploaded, remote hashes match `SHA256SUMS.txt`, and the working tree is clean.

