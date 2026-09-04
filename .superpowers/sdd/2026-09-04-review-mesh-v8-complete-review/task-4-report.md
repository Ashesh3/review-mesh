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

Pending.
