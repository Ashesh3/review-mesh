# Task 3 Report: Canonical findings and enforceable adjudication

## Status

Implemented and committed-ready.

## RED

### Canonical findings

Command:

```powershell
npx vitest run tests/findings/canonical.test.ts tests/orchestrator/state.test.ts tests/diagnostics/run-report.test.ts
```

Observed:

- Exit code 1.
- `tests/findings/canonical.test.ts` could not import the missing `src/findings/canonical.ts`.
- New state/report assertions failed because `rawFindings`, `gateFindings`, and `finding_counts` did not exist.
- 33 pre-existing focused tests passed.

### Adjudication proof

Command:

```powershell
npx vitest run tests/findings/adjudication.test.ts tests/orchestrator/review-feedback.test.ts tests/protocol/prompt.test.ts
```

Observed:

- Exit code 1.
- `tests/findings/adjudication.test.ts` could not import the missing `src/findings/adjudication.ts`.
- 24 pre-existing focused tests passed.

## GREEN

### Exact Task 3 suite

Command:

```powershell
npx vitest run tests/findings/canonical.test.ts tests/findings/adjudication.test.ts tests/protocol/prompt.test.ts tests/orchestrator/state.test.ts tests/orchestrator/review-feedback.test.ts tests/diagnostics/run-report.test.ts tests/server/dashboard-data.test.ts
```

Observed:

- Exit code 0.
- 7 test files passed.
- 78 tests passed.

### TypeScript

Command:

```powershell
npm run typecheck
```

Observed:

- Exit code 0.
- Source and test TypeScript projects passed.

### Diff hygiene

Command:

```powershell
git diff --check
```

Observed:

- Exit code 0.
- No whitespace errors.

## Implemented

- Added one deterministic canonical findings module producing raw, consolidated, gate-effective, advisory, and explicit counts.
- Reused the canonical module in live aggregation, persisted report/findings, and dashboard data.
- Preserved raw source findings and full reviewer/adjudicator outputs after rejection or downgrade.
- Added a dedicated candidate-ID-keyed adjudication schema and candidate-bound JSON Schema generation.
- Added mechanical proof validation:
  - ordered two-step cited proof and cited failure point for reliability, concurrency, lifecycle, and cleanup;
  - cited base/head comparison for change-scoped confirmation or adjustment;
  - missing or invalid required proof becomes non-gating `needs_verification`.
- Selected and parsed the dedicated adjudication schema throughout adapter and orchestration output paths.
- Added `raw_findings`, `unique_findings`, `gate_findings`, and `advisory_findings` completion counts.

## Concerns

- Legacy ordinary-reviewer adjudication artifacts remain readable for compatibility, but only the new dedicated result carries enforceable candidate decisions.
- No broad suite rerun was performed after the exact focused Task 3 suite and typecheck, per parent instruction.

## Fix round 1

### RED

Command:

```powershell
npx vitest run tests/findings/adjudication.test.ts tests/server/dashboard-data.test.ts tests/diagnostics/run-report.test.ts
```

Observed:

- Exit code 1.
- Four focused regressions reproduced: location-free proof gated, adjusted payload was ignored, dashboard trusted requested adjudication decisions, and advisory-only report fallback returned findings.

### GREEN

Command:

```powershell
npm run typecheck
npx vitest run tests/findings/canonical.test.ts tests/findings/adjudication.test.ts tests/protocol/prompt.test.ts tests/orchestrator/state.test.ts tests/orchestrator/review-feedback.test.ts tests/diagnostics/run-report.test.ts tests/server/dashboard-data.test.ts
```

Observed:

- Exit code 0.
- Source and test TypeScript projects passed.
- 7 test files passed; 83 tests passed.

### Fixes

- Dashboard now parses the source/adjudicator results and calls `validateAdjudication` before canonicalization.
- Confirmation/adjustment proof requires concrete repository-relative path and positive line citations, including every ordered step, the failure point, and both base/head behaviors.
- Adjusted decisions produce an effective finding used by live/report/dashboard canonical counts while the original candidate and full adjudicator review remain stored.
- Report fallback derives `gate_outcome` from canonical gate-effective count, so advisory-only artifacts pass.

## Fix round 2

### RED

Command:

```powershell
npx vitest run tests/findings/adjudication.test.ts tests/findings/canonical.test.ts tests/orchestrator/state.test.ts tests/diagnostics/run-report.test.ts tests/server/dashboard-data.test.ts
```

Observed:

- Exit code 1.
- Nine focused failures reproduced unsafe/unreviewed proof citations, fabricated base/head locations, canonical threshold drift, and report/dashboard ignoring persisted non-default thresholds.

### GREEN

Command:

```powershell
npx vitest run tests/findings/adjudication.test.ts tests/findings/canonical.test.ts tests/orchestrator/state.test.ts tests/orchestrator/review-feedback.test.ts tests/diagnostics/run-report.test.ts tests/server/dashboard-data.test.ts
npm run typecheck
```

Observed:

- Exit code 0.
- 6 test files passed; 87 tests passed.
- Source and test TypeScript projects passed.

### Fixes

- Adjudication citations now reject URLs, absolute paths, traversal, dot/empty paths, backslashes, control characters, pathspec magic, invalid ranges, and evidence not bound to inspected candidate locations or authoritative Git context.
- Change-scoped base/head proof is parsed against old/new ranges in supplied diff hunks and must cite the corresponding side.
- Full-scope ordered proof can use concrete locations already covered by candidate evidence without requiring a diff.
- Canonicalization accepts resolved per-lens gate policies and applies severity/confidence thresholds deterministically.
- Live state derives those policies from resolved reviewers; persisted report/dashboard recover them from resolution metadata and produce matching counts/outcomes.

## Fix round 3

### RED

Command:

```powershell
npx vitest run tests/findings/evidence-verifier.test.ts tests/findings/adjudication.test.ts
```

Observed:

- Exit code 1.
- The core evidence verifier module was missing and full-scope candidate repetition still gated without authoritative verification.

### GREEN

Command:

```powershell
npm run typecheck
npx vitest run tests/findings/adjudication.test.ts tests/findings/evidence-verifier.test.ts tests/findings/canonical.test.ts tests/orchestrator/state.test.ts tests/orchestrator/review-feedback.test.ts tests/diagnostics/run-report.test.ts tests/server/dashboard-data.test.ts
```

Observed:

- Exit code 0.
- Source and test TypeScript projects passed.
- 7 test files passed; 96 tests passed.

### Fixes

- Added a bounded core-side evidence verifier using canonical workspace resolution, no-follow opens, regular-file checks, bounded line validation, and stable handle/path identity checks.
- Nonexistent paths, symlink escapes, out-of-range lines, and file replacement races fail closed as non-gating `needs_verification`.
- Pure adjudication validation now requires an authoritative core verification map; candidate evidence cannot self-authenticate.
- The orchestrator verifies evidence before gate evaluation and persists a validation attestation bound to candidate/adjudicator digests, context head, evidence-verification digest, and exact effective outcome.
- Strict reports and dashboard data consume and verify the persisted attestation, never rereading the workspace or re-trusting raw model proof after the run.
