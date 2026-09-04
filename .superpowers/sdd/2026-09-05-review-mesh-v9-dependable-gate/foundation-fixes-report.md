# Foundation fixes report

## Changes

- Added `createSafeArtifactParent(path)` in `src/diagnostics/run-index.ts`. It finds and validates the deepest existing directory, creates each missing component separately, validates every created or concurrently existing component, and returns the pinned final parent identity. Artifact and index writers now use this helper before opening output files.
- Added artifact and index regressions using `redirected/missing/...`; both assert the redirected outside tree never receives the missing descendant.
- Marked raw findings produced by `buildCanonicalRawFindings` with current `reviewer_result_v4` provenance. Current v4 findings fail closed when evidence or source coverage proof is missing/incomplete.
- Derived ordered-proof requirement for medium-or-higher current v4 findings in reliability, concurrency, lifecycle, and cleanup categories. Historical/manual canonical inputs remain on the existing permissive path.
- Kept change-impact gating context-driven: `change_impact_required` and `change_impact_verified` remain facts supplied by orchestration/normalization.

## RED evidence

Command:

`node node_modules/vitest/vitest.mjs run tests/diagnostics/run-artifact.test.ts tests/findings/canonical-v9.test.ts --maxWorkers=1 --reporter=verbose`

Result: exit 1. Two expected failures: artifact creation returned after already creating the redirected descendant, and the current v4 finding remained gate eligible without proof.

Command:

`node node_modules/vitest/vitest.mjs run tests/diagnostics/run-index.test.ts --maxWorkers=1 --reporter=verbose`

Result: exit 1. The new redirected missing runs-directory regression failed before the shared creation helper was implemented.

## GREEN verification

Command:

`node node_modules/vitest/vitest.mjs run tests/diagnostics/run-artifact.test.ts tests/diagnostics/run-index.test.ts tests/findings/canonical-v9.test.ts --maxWorkers=1 --reporter=dot`

Result: exit 0, 3 files and 41 tests passed.

Command:

`node node_modules/typescript/bin/tsc --noEmit --pretty false --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --types node,vitest/globals src/diagnostics/run-artifact.ts src/diagnostics/run-index.ts src/findings/canonical.ts tests/diagnostics/run-artifact.test.ts tests/diagnostics/run-index.test.ts tests/findings/canonical-v9.test.ts`

Result: exit 0.

Command:

`node node_modules/prettier/bin/prettier.cjs --check src/diagnostics/run-artifact.ts src/diagnostics/run-index.ts src/findings/canonical.ts tests/diagnostics/run-artifact.test.ts tests/diagnostics/run-index.test.ts tests/findings/canonical-v9.test.ts`

Result: exit 0, all matched files use Prettier style.

Command:

`git diff --check -- src/diagnostics/run-artifact.ts src/diagnostics/run-index.ts src/findings/canonical.ts tests/diagnostics/run-artifact.test.ts tests/diagnostics/run-index.test.ts tests/findings/canonical-v9.test.ts`

Result: exit 0.

The full repository typecheck was also attempted. It is currently blocked by unrelated concurrent `src/orchestrator/run-v9.ts` errors concerning `attemptStartedAt`, `adjudicationResult`, and `candidates`; that file is outside this fix ownership.

## Root integration contract

For every current v4 source reference, root orchestration/normalization must supply a `CanonicalFindingCoreProof` entry through `proofBySourceRef`:

- `evidence_verified: true` only after core repository evidence verification.
- `source_coverage_verified: true` only after the causal source path is covered.
- `ordered_proof_verified: true` for medium-or-higher reliability, concurrency, lifecycle, or cleanup findings only after ordered proof passes. The canonicalizer derives that this proof is required, so callers do not need to set `ordered_proof_required` for those categories.
- `change_impact_required: true` when run context requires base/head causal proof, with `change_impact_verified: true` only after that proof passes.
- Existing adjudication, scope, policy, and unrelated-deficit facts retain their current meanings.

Missing or partial current-v4 proof records now produce stable `evidence_unverified`, `ordered_proof_missing`, and/or `source_coverage_unverified` reasons instead of a gate-eligible finding.
