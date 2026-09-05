# V9 CLI acceptance migration report

## Scope

- Migrated `tests/acceptance/compiled-cli.test.ts`, `portable-cli.test.ts`, and `standalone-cli.test.ts` to request v3, config v7, command protocol v2 pages, result v4, public event v6, and artifact v2 expectations.
- Added `tests/helpers/v9-command-fixture.ts` for reusable paged command fixtures. Production code and the historical `tests/fixtures/command-adapter.mjs` fixture were not changed.

## Failure evidence

- The integration log failed before reviewer execution because legacy acceptance configs used `heartbeat_interval_ms = 100`; config v7 requires 1,000 through 300,000 ms.
- After fixing admission, command fixtures using protocol v1/result v3 and v5 terminal fields failed the current boundary.
- Attested command findings correctly remain non-gating when core cannot verify their cited evidence. The current acceptance expects retained canonical findings with exit 0 and `gate_outcome = no_gate_findings`; crash/coverage failure remains exit 3.
- A legal 13 MiB narrative requires explicit `--output-mode full-jsonl`; the compiled acceptance proves exact result bytes/digest and artifact/status/report readback.
- The portable OpenAI server now performs a real `read_file` tool turn and returns two core-assigned semantic pages, including the observed coverage path.

## Verification

- `npx vitest run tests/acceptance/compiled-cli.test.ts tests/acceptance/portable-cli.test.ts --maxWorkers=1` — 11 passed.
- `npx vitest run tests/acceptance/compiled-cli.test.ts -t "13 MiB full result" --maxWorkers=1` — 13 MiB full JSONL case passed.
- `npx tsc -p tsconfig.test.json --noEmit` — acceptance-owned type errors cleared; the latest run completed with exit 0.
- Standalone Windows/Linux execution was intentionally left for the root integration build because these tests require freshly built release binaries.
