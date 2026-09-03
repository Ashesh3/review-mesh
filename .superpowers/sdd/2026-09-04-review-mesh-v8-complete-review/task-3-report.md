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

