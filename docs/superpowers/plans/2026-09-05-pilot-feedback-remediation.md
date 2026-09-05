# Pilot feedback remediation implementation plan

> **For agentic workers:** Use the subagent-driven-development and verification-before-completion workflows. All changes implement the user's explicit request to address the pilot feedback and release a new version.

**Goal:** Address RM-01 through RM-15 from the September 5 pilot and publish Review Mesh 9.2.0 with verified Windows and Linux artifacts.

**Architecture:** Preserve v9 fail-closed coverage, immutable captured evidence, paged results, strict quorum, private diagnostics, and the dependency-free dashboard. Correct evidence delivery and admission boundaries; recover argument/schema mistakes in the current conversation; expose compact operational state and controlled recovery.

**Tech stack:** TypeScript, Zod, Vitest, existing Node/Bun packaging.

**Spec:** The user-provided `REVIEW_MESH_PILOT_FEEDBACK.md` and the existing v9 dependable-gate design. The feedback's release acceptance table is the acceptance map.

## Constraints and decisions

- Work from verified v9.1.0, not the report's older installed v9.0.0. Preserve unrelated `.agents/` files.
- Run and lens deadlines include queue time. Candidate execution budgets begin at admission, bounded by remaining outer deadlines.
- Never weaken coverage or silently discard findings to make malformed output pass.
- Persist no secret-bearing raw response in public diagnostics. Raw retained diagnostics stay private with explicit retention/cleanup controls.
- Use the configured npm registry and Git identity. Release authorization is already explicit in the user request.
- Use distinct file ownership for concurrent implementation; integrate shared interfaces explicitly.

## Tasks and acceptance map

- [x] **Coverage broker (RM-02, RM-04, RM-10 API):** `src/context/change-coverage.ts`, shared read limits, and context tests. Capture readable changed files independent of coverage requirement. Export one read limit; return recoverable range errors and exact outstanding byte ranges. Regress relevant/nonrelevant/unchanged reads, both policies, boundaries, corrected retries, and Unicode.
- [x] **Adapter and pages (RM-03, RM-07, RM-08, RM-10, RM-11, RM-15):** prompt, SDK/OpenAI-compatible adapters, page collector, error contracts, spool storage and associated tests. Use core-owned delivery metadata; generic system page invariants with a current assignment; two bounded page repairs with sanitized violations and checkpoint references; exact coverage deficit recovery; per-run private spool manifests and safe explicit cleanup. Regress real prompt/adapter/ledger delivery, overflow, extra keys, wrong envelopes, Unicode, failed repair and page 1 continuity.
- [x] **Admission scheduler (RM-05, RM-06):** `src/orchestrator/run-v9.ts` and scheduler tests. Acquire provider capacity before execution workers. Distinguish queue/probe/execution clocks and expired boundaries. Regress delayed fallback, mixed-provider fairness, outer expiry, and reconciled attempt timestamps.
- [x] **Configuration and help (RM-01, RM-08 config, RM-14):** config command, discovery/help and CLI tests. Fresh export/populate/apply/effective succeeds; source parse locations only for actual parse failures; examples reflect request v3/config v7 and explicitly label legacy compatibility.
- [x] **Retry and operations (RM-09, RM-12):** retry preparation, status views, CLI control and tests. Reconstruct Git evidence with identity verification, compare safe evidence/control metadata, preserve compatible completed model results; compact status defaults with opt-in details, live artifact links, safe cancellation and resume through verified retry.
- [x] **Doctor (RM-13):** readiness facets and a real changed Git fixture exercising observed reads, diff delivery, paged finalization and retry. Basic probe explicitly reports only the facets it tested.
- [ ] **Integration and release:** run targeted tests after each task, independent review, sequential full suite, typecheck/build, scoped format validation, Windows/Linux standalone verification including a 50+ file changed fixture. Record any unavailable external live-model evidence explicitly. Update README/release notes/version, commit, integrate main, push annotated tag, publish binaries/checksums and verify remote digests.

## Verification commands

Use `node node_modules/vitest/vitest.mjs run <owned tests> --maxWorkers=1` for regression cycles. Integration uses `npm run typecheck`, `npm test -- --maxWorkers=1`, `npm run build`, and `npm run verify:standalone`. Format only changed files, then inspect `git diff --check`. Verify `HEAD == origin/main`, peeled release tag, published asset sizes and SHA256 digests.

## Execution record

- Baseline: main commit `8515660`, package/release v9.1.0, only unrelated `.agents/` untracked. Git identity verified as Ashesh3.

- Verified full sequential suite: 1,091 passed, 8 skipped. Final follow-up covers truthful doctor facets and ordinary empty-page repair.
- Windows/Linux standalone tests and the 57-file pilot protocol fixture passed. Independent reviews fixed inherited-quorum bypass and run-snapshot ownership across probe timeout.
- Live Windows structured doctor: Astra clear with complete observed coverage; Opus returned provider content_filter during result finalization and remained inconclusive. Credential values were not recorded in release files.

- Final binary bootstrap export/apply/effective succeeded with missing revision and config v7. Final live Opus verification correctly preserved successful authentication/streaming/read/diff/observed-coverage facets while reporting content_filter as result-page failure.
- Independent final acceptance audit found no uncovered release-blocking claims across RM-01 through RM-15.

- Final frozen full suite passed: 1,098 tests, 8 expected skips; build/typecheck and both standalone acceptance tests passed. Release binary SHA256 checks verified.
