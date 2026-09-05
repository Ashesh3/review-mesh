# Artifact lifecycle and recovery implementation plan

> **For agentic workers:** Use the debugging, test-driven-development, parallel-agent and verification-before-completion workflows. User authorized implementation and release.

**Goal:** Fix RM-16 missing-artifact diagnostics, recovery and lifecycle isolation, restore the affected historical run, and release v9.3.0.

**Architecture:** Active artifact bytes stay outside completed-retention selection. Finalization retains recoverable core bytes until verification and index publication succeed. Versioned indexes record identical verified backup copies and resolve a surviving copy when the primary is missing. Explicit recovery attaches a validated caller artifact to an existing orphaned index without rerunning models or weakening evidence checks.

**Spec:** RM-16 and its successful-run/orphaned-index addendum in the user-provided pilot feedback. The historical deletion actor remains unknown.

## Tasks

- [x] **Index and recovery:** versioned index with bounded verified alternate references; safe native error code/stage/path/recovery details; missing-primary fallback and explicit recovery compare index digest/bytes/run identity and complete artifact schema. Reject mismatches, tampering, symlinks, active or conflicting run artifacts. Preserve v1 index support and observed stream metadata.
- [x] **Artifact lifecycle:** protected active staging with live discovery; final publish without overwrite; keep recovery bytes if final verification/index publication fails. Register details backup whenever persistence is enabled. Update doctor to the same lifecycle. Test removal/replacement during finalization and post-success managed deletion.
- [x] **Retention isolation:** legacy retention selects only completed legacy-owned records, excludes active/current-format artifacts and their indexes; current-format retention keeps index/artifact consistency and never deletes caller-owned details. Concurrent review/doctor/retention tests and explicit ownership checks.
- [x] **CLI and recovery:** propagate structured artifact diagnostics through status/report/findings/retry; add recover command and help; projection exposes resolved backup/recovery information. Verify orphaned historical run from surviving details copy and repair its index using the shipped CLI.
- [ ] **Release:** independent review; regression cycles; sequential full suite; typecheck/build/changed-file formatting; Windows/Linux standalone acceptance for missing primary and explicit recovery; bump v9.3.0, commit/push/tag/publish, validate asset SHA256, update local CLI and restore historical run.

## Constraints

- No inference about which process deleted the historical artifact.
- Never overwrite another file, credit unverifiable evidence, or report a clear gate after failed durable publication.
- Keep raw provider spools separate from core artifact recovery; keep credentials out of public diagnostics.
- Preserve unrelated `.agents/` and user files. npm registry and Git identity remain the approved machine defaults.
- Exported details copies remain caller-owned; automatic retention never deletes them.

## Execution evidence

- Baseline v9.2.0 commit b3b68c2; only unrelated `.agents/` untracked.
- Historical run run_cb54fa59-ee11-4aec-b12b-13faea83e14f has surviving index, missing managed file, expected 1,008,629 bytes and SHA256 cca1334c8c65a69c3577c6b4c7e2f730252d0c888c270cf93bab1f57481f47c0.

- Targeted artifact/index/CLI/retention suite: 97 passed; dashboard and control integrations: 32 passed. Typecheck/build passed.
- Windows and Linux standalone tests passed, including missing-primary fallback and exact legacy-index recovery after a real 57-file Git review.
- Recovered the affected historical run with the new standalone binary: clear, complete coverage, zero findings, two completed reviewers and the original 1,008,629-byte checksum. Original index backed up privately before recovery.
- Independent final audit found no remaining P1/P2 issues; partial initial artifact/index publication was fixed through complete verified staging and exclusive linking.

- Final full sequential suite passed: 1,134 tests, 8 expected skips. Windows/Linux acceptance, build/typecheck and changed-file formatting passed. Local CLI updated to verified v9.3.0 with old binary backed up.
