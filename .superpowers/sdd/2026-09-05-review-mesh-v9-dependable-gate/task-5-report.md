# Task 5 report: SDK and command adapter v9 parity

Implemented v9 paged-result support for Claude, Copilot, Codex, and command adapters while preserving the explicit legacy no-`resultPages` path.

## Delivered behavior

- Added `src/adapters/sdk-pages.ts` as the small shared bridge from core collector requests to provider page prompts and JSON Schemas.
- Claude uses Review Mesh-owned MCP `list_files`, `read_file`, and `search_text` handlers for v9 runs, disables SDK-native read tools, resumes the same Claude session for continuation pages, and emits stable accepted-page progress identities.
- Copilot registers actual SDK custom tools, disables built-in read/shell/write surfaces for v9, returns the exact serialized read response credited by the ledger, and sends every page request through the same SDK session.
- Codex remains attested-only, explicitly reports `observed_file_access: false`, and the real facade retains one SDK thread across page turns.
- Command protocol v2 keeps stdin open for core `request_page` envelopes, validates bounded activity/access-claim identities, accepts only collector-assigned result pages, normalizes read claims to coverage attestations, and never promotes them to observed proof. Protocol v1 retains the historical terminal-result path.
- Added focused facade/adapter tests for SDK option shapes, core handler serialization and acknowledgment, multi-page continuation, stable progress identities, attested capability reporting, v2 interactive paging, and duplicate claim rejection.

## TDD evidence

Initial focused runs failed only at the new boundaries:

- Claude, Copilot, and Codex returned `failure` because the old adapters validated v9 pages as monolithic v3 results.
- Command v2 rejected the new activity/page events as unsupported protocol events.

After implementation, the focused adapter run passes 139 tests across four files.

## Verification

- `npm test -- --run tests/adapters/claude.test.ts tests/adapters/copilot.test.ts tests/adapters/codex.test.ts tests/adapters/command.test.ts` — PASS, 139 tests.
- Scoped TypeScript compile of the four adapters, bridge, and corresponding tests with strict NodeNext/exact-optional flags — PASS.
- `git diff --check` for all Task 5-owned source, test, fixture, and report files — PASS.
- Repository-wide `npx tsc --noEmit --pretty false` — PASS on the final post-commit verification. An earlier run briefly encountered a concurrent dashboard `dirname` edit, which was resolved before final verification.

## Integration note

The command protocol configuration enum must include `review-mesh-command-v2`; root updated `src/config/schemas.ts` during this task. No Task 5 commit includes that root-owned file.
