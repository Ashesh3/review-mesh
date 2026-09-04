# Task 4 Report: Resilient explicit lens policy

## Status

Implemented and verified.

## RED

### Schema-v6 policy and migration

Command:

```powershell
npx vitest run tests/config/schemas.test.ts tests/config/manage.test.ts tests/config/resolve.test.ts tests/orchestrator/lens-policy.test.ts
```

Observed:

- Exit code 1.
- 4 test files failed.
- 9 intended assertions failed while 90 existing assertions passed.
- Missing behavior covered schema v6, explicit applicability/context, provider-concentration and zero-outage acknowledgements, managed migration, 3/3 five-model defaults, streaming defaults, and explicit always applicability.

### Orchestration and safe surfaces

Command:

```powershell
npx vitest run tests/orchestrator/review-feedback.test.ts tests/config/effective.test.ts tests/config/tui.test.ts
```

Observed:

- Exit code 1.
- 10 assertions failed while 25 passed.
- The failures showed that TUI creation, help/discovery text, and the explicit applicability discriminant had not reached every surface.
- A separate scalar-quorum RED test proved schema v6 still accepted an impossible 2-of-1 policy.

## GREEN

### Exact Task 4 suite

Command:

```powershell
npx vitest run tests/config/schemas.test.ts tests/config/manage.test.ts tests/config/resolve.test.ts tests/config/effective.test.ts tests/config/tui.test.ts tests/orchestrator/lens-policy.test.ts tests/orchestrator/review-feedback.test.ts
```

Observed:

- Exit code 0.
- 7 test files passed.
- 136 tests passed.

### TypeScript

Command: `npm run typecheck`

Observed: exit code 0; source and test TypeScript projects passed.

### Formatting and diff hygiene

Commands:

```powershell
npx prettier --check src/config/schemas.ts src/config/manage.ts src/config/resolve.ts src/config/effective.ts src/config/tui.ts src/config/load.ts src/config/command.ts src/orchestrator/lens-policy.ts src/orchestrator/run-review.ts src/orchestrator/state.ts src/protocol/schemas.ts src/discovery/help.ts tests/config/schemas.test.ts tests/config/manage.test.ts tests/config/resolve.test.ts tests/config/effective.test.ts tests/config/tui.test.ts tests/orchestrator/lens-policy.test.ts tests/orchestrator/review-feedback.test.ts tests/helpers/fixtures.ts
git diff --check
```

Observed: both commands exited 0; all matched files use Prettier style and no whitespace errors were reported.

## Implemented

- Added trusted configuration schema version 6 while preserving v1-v5 reads.
- Required explicit `applicability.mode` and `required_context` on every v6 lens.
- Added provider-concentration and zero-outage-tolerance acknowledgements.
- Validated primary topology across scalar and multi-model roster members.
- Defaulted five-model v6 lenses to quorum 3/provider groups 3 and scalar lenses to 1/1.
- Migrated legacy lenses to explicit always/empty policy without inventing globs or caller-context requirements.
- Preserved legacy strict quorum by adding explicit acknowledgements where required.
- Defaulted new v6 OpenAI-compatible adapters to streaming `auto`; legacy unspecified streaming resolves as `disabled`.
- Added TUI policy creation/editing and safe effective/describe topology, outage tolerance, applicability, and required-context diagnostics.
- Added compact `suite.resolved` policy/topology diagnostics and updated generated-schema/help coverage.
- Verified unmatched applicability and missing required context make zero provider calls.
- Verified two provider failures still allow a distributed five-model lens to pass at 3/3.

## Changed files

- `src/config/command.ts`
- `src/config/effective.ts`
- `src/config/load.ts`
- `src/config/manage.ts`
- `src/config/resolve.ts`
- `src/config/schemas.ts`
- `src/config/tui.ts`
- `src/discovery/help.ts`
- `src/orchestrator/lens-policy.ts`
- `src/orchestrator/run-review.ts`
- `src/orchestrator/state.ts`
- `src/protocol/schemas.ts`
- `tests/config/effective.test.ts`
- `tests/config/manage.test.ts`
- `tests/config/resolve.test.ts`
- `tests/config/schemas.test.ts`
- `tests/config/tui.test.ts`
- `tests/helpers/fixtures.ts`
- `tests/orchestrator/lens-policy.test.ts`
- `tests/orchestrator/review-feedback.test.ts`

## Caveats

- The active machine configuration was not read, written, or migrated; that remains Task 5 after release gates.
- Legacy configurations preserve their prior primary order and explicitly strict quorum semantics.

## Commit

`e10ec73` — `Require resilient explicit lens policy`

## Fix round 1

### RED

Command:

```powershell
npx vitest run tests/config/resolve.test.ts tests/config/effective.test.ts tests/config/tui.test.ts
```

Observed:

- Exit code 1.
- 3 test files failed; 3 new regressions failed while 37 existing assertions passed.
- V1 loading returned schema 1 instead of migrated schema 6 with explicit always/empty policy.
- TUI could not save a five-model roster split across two providers before the policy editor was reachable.
- Effective topology reported outage tolerance 0 for a 3+1+1 provider distribution at quorum 3/2, but emitted no zero-outage warning.

### GREEN

Focused command:

```powershell
npx vitest run tests/config/resolve.test.ts tests/config/effective.test.ts tests/config/tui.test.ts
```

Observed: exit code 0; 3 files and 40 tests passed.

Exact Task 4 command:

```powershell
npx vitest run tests/config/schemas.test.ts tests/config/manage.test.ts tests/config/resolve.test.ts tests/config/effective.test.ts tests/config/tui.test.ts tests/orchestrator/lens-policy.test.ts tests/orchestrator/review-feedback.test.ts
```

Observed: exit code 0; 7 files and 139 tests passed.

Additional verification:

- `npm run typecheck`: exit code 0.
- Targeted `npx prettier --check`: exit code 0.
- `git diff --check`: exit code 0.

### Fixes

- Active loading now migrates v1 through the same v6 managed migration as v2-v5, preserving reviewer order and legacy disabled streaming while adding explicit always applicability and empty required context.
- TUI materializes quorum policy before validation: five-model lenses default to pass quorum 3 and up to 3 distinct provider groups, so a two-provider roster is directly created as acknowledged 3/2 while three-or-more-provider rosters retain 3/3.
- Zero-outage warnings now use the same `providerOutageTolerance(...) === 0` calculation shown in effective topology, eliminating heuristic drift.

### Commit

Pending.
