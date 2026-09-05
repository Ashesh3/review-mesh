# Review Mesh v9 Dependable Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved v9 unattended review gate with finite deadlines, evidence-backed coverage, bounded result production, dependable liveness, and one authoritative immutable artifact.

**Architecture:** Preserve the existing TypeScript CLI, adapter registry, logical-lens scheduler, and embedded read-only dashboard. Add focused protocol, deadline, coverage, and artifact modules, then connect them through the existing orchestration and derived-view boundaries. Historical schemas stay separate from current writers so compatibility never weakens the v9 contract.

**Tech Stack:** Node >=22.12.0, TypeScript, Zod, Vitest, existing SDKs, embedded vanilla HTML/CSS/JavaScript, esbuild, Bun standalone packaging. No additional runtime dependency is required.

**Spec:** `docs/superpowers/specs/2026-09-05-review-mesh-v9-dependable-gate-design.md`

## Global Constraints

- Current versions: request `3`, config `7`, reviewer result `4`, adjudication result `2`, public event `6`, artifact format `2`, report `2`, status `3`, dashboard payload `2`.
- Readers accept request 2-3, config 1-7, result 1-4, adjudication 1-2, event 4-6, and artifact 1-2. Historical artifacts are never rewritten.
- Exit codes remain 0 clear, 1 complete with gate findings, 2 invalid pre-run input, 3 partial coverage or persistence failure, 4 caller cancellation.
- A run deadline includes queue, probe, semaphore, retry, continuation, adjudication, and fallback. Shutdown grace is cleanup time only.
- Adaptive tiers are inclusive: 3 files/16 KiB = 15 minutes; 10/64 KiB = 30 minutes; 50/512 KiB = 60 minutes; larger, truncated, or full review = 90 minutes.
- A clean contributing reviewer must independently satisfy the configured relevant changed-path ledger. Full review has not-applicable change coverage.
- Only core-mediated and hashed response bytes prove observed reads. Codex and opaque command processes are attested-only.
- Result pages are at most 32 KiB UTF-8. Assembled results remain at most 16 MiB and preserve legal 13 MiB narratives exactly after sanitization.
- Default output is concise-jsonl. A 40-model heartbeat and terminal event must be below 16 KiB. Every output mode requires a finalized artifact.
- No PR metadata service calls, automatic Git fetch, reviewed-workspace mutation, arbitrary reviewer command execution, or implicit weakening of quorum.
- Preserve the dependency-free embedded read-only dashboard, loopback/same-origin restrictions, redaction, path identity checks, and owned spool lifecycle.
- Work on the existing `codex/review-mesh-v9` branch. Preserve unrelated `.agents/` and existing worktrees.
- Use `https://packagefeedproxy.microsoft.io/npm/` for Node package operations and commit as `Ashesh3 <3626859+Ashesh3@users.noreply.github.com>`.
- Use focused tests during each task; run resource-heavy acceptance and full verification sequentially at integration. Record RED/GREEN evidence and exact commands in task reports.

## File and dependency map

| Task | Responsibility | New focused modules | Depends on |
| --- | --- | --- | --- |
| 1 | Versioned schemas and page assembly | `src/protocol/v9.ts`, `src/results/result-pages.ts` | Existing frozen schemas |
| 2 | Config migration, prerequisites, Git diagnostics, deadline selection | `src/orchestrator/deadlines.ts`, `src/config/topology.ts`, `src/context/required-input.ts` | 1 |
| 3 | Pinned snapshots and per-result coverage | `src/context/change-coverage.ts`, `src/adapters/file-tools.ts` | 1-2 |
| 4 | OpenAI bounded production and telemetry | Shared page collector and file tools | 1-3 |
| 5 | SDK and command production | Same collector and file tools | 1-4 |
| 6 | Canonical atomics, roots, eligibility | Existing findings modules | 1-3 |
| 7 | Artifact writer, index, normalized reader | `src/diagnostics/run-artifact.ts`, `src/diagnostics/run-index.ts`, `src/diagnostics/normalize-run.ts` | 1, 3, 6 |
| 8 | Deadline/liveness and v9 orchestration integration | `src/orchestrator/activity.ts` | 1-7 |
| 9 | Unified report/status/retry/dashboard views | Normalization module from task 7 | 6-8 |
| 10 | CLI/doctor parity, acceptance, documentation and release preparation | `tests/acceptance/v9-dependable-gate.test.ts` | 1-9 |

The exported signatures below are the contract between tasks. Extend existing types additively until the orchestration switch in task 8; do not weaken frozen historical parsers or globally rewrite legacy fixtures into v9 fixtures.

### Task 1: Versioned protocol and bounded result pages

**Files:** Create `src/protocol/v9.ts`, `src/results/result-pages.ts`, `tests/protocol/v9.test.ts`, `tests/results/result-pages.test.ts`; modify `src/protocol/schemas.ts`, `src/protocol/json-schema.ts`, `src/results/sanitize.ts`, `src/results/digest.ts` only as needed for new exports and lossless current result support.

**Interfaces:** Export `reviewRequestV3Schema`, `reviewerResultV4Schema`, `providerReviewerResultV4Schema`, `adjudicationResultV2Schema`, `publicEventV6Schema`, `changeCoverageResultSchema`, `resultPageSchema`, corresponding inferred types, and v9 enums. Keep historical schemas explicitly exported. Export `createResultPageCollector(options)`, with options `{ resultId: string; resultKind: "reviewer" | "adjudication"; candidateIds?: readonly string[] }`; collector methods `nextRequest()`, `addPage(raw: string)`, `complete`, and `assemble()`. `nextRequest()` returns the core-owned result ID, index, previous digest, and assigned candidate IDs. `assemble()` returns provider content (including attestation, without core change coverage) or adjudication v2. Export `ResultPageError` with typed incomplete reason.

- [ ] Write failing schema tests using actual UTF-8 byte boundaries, typed PR shapes, frozen v5 events, and provider rejection of core-owned coverage. Start from this assertion and supply literal valid fixtures in the test:

```ts
expect(reviewRequestV3Schema.safeParse({
  schema_version: "3", project_name: "demo", workspace: "/work/demo",
  instructions: "Review", review_scope: { mode: "changes" },
  pull_request: { id: "1", unexpected: true },
}).success).toBe(false);
expect(providerReviewerResultV4Schema.safeParse({
  ...validProviderResult, change_coverage: validCoverage,
}).success).toBe(false);
```

- [ ] Run `npm test -- tests/protocol/v9.test.ts tests/results/result-pages.test.ts --maxWorkers=1`; retain the expected missing-contract failure.
- [ ] Implement strict v9 schemas from the spec, including every named bound and enum; keep missing/value-invalid readiness values distinguishable from request object/type violations. Build discriminated page payloads. Check raw serialized bytes before parsing, then chain identity/index/digest/count/order, unique IDs, exact candidate assignment, attestation count/digest, narrative count/bytes, and final assembled limits. Collector errors preserve received bytes at the adapter spool boundary.

```ts
const previousDigest = createHash("sha256").update(raw, "utf8").digest("hex");
// State advances only after the exact raw page and its payload validate.
const nextIndex = acceptedPage.page_index + 1;
```

- [ ] Verify a multi-page six-finding result, 80 adjudication candidates, all malformed chains, a 13 MiB narrative, and an assembled result just below 16 MiB. Update `sanitizeReviewerOutput` to sanitize v4/v2 once without truncation and maintain the canonical digest contract. Historical result tests must still pass.
- [ ] Format touched files, run their tests and typecheck, self-review, and commit `feat: define v9 protocols and bounded result pages`.

### Task 2: Config v7, prerequisites, deadline selection and Git history

**Files:** Modify `src/config/{schemas,manage,resolve,effective,load,tui,command}.ts`, `src/context/resolve.ts`, `src/discovery/{describe,description,schema}.ts`; create `src/orchestrator/deadlines.ts`, `src/config/topology.ts`, `src/context/required-input.ts` and corresponding tests. Modify existing config/context tests while retaining historical inputs.

**Interfaces:** Add `TrustedConfigV7`, deadline fields on resolved execution, `kind`, `lensDeadlineMs`, `requiredInput`, and `changeCoverage: { relevantPaths: string[]; minimumInspection: "full_file" | "diff"; proof: "observed" | "attested" }` to resolved reviewer policy. Export `selectRunDeadline(context, execution, startedAt)` returning `{ mode, tier, duration_ms, started_at, deadline_at, inputs }`; export `deadlineCause({ now, cancelled, run, lens, candidate, attempt, progress })` using the specified precedence. Export `evaluateRequiredInput(request, selectors)` returning exact missing/invalid selector diagnostics, and `describeTopology(config)` returning shared stable warnings. Preserve raw captured diff byte count/digest in context and carry the normalized request/PR metadata for prerequisite evaluation.

- [ ] Add independent boundary cases and readiness cases before production edits:

```ts
expect(selectRunDeadline(fiveFileContext, adaptiveExecution, new Date(0)))
  .toMatchObject({ tier: "small", duration_ms: 1_800_000 });
expect(evaluateRequiredInput(requestWithoutPr,
  ["/request/pull_request/id"]))
  .toEqual([{ selector: "/request/pull_request/id", code: "missing_required_input" }]);
```

- [ ] Run focused config/context/deadline tests and observe the expected failures.
- [ ] Implement schema7 and pure migration preserving exact roster/order/quorum/acknowledgements. Defaults are adaptive, 300000 ms no-progress, 30000 ms heartbeat, full-file coverage, and adapter-specific proof. Convert `/x` required-context selectors to `/context/x`; validate all seven required readiness selectors. Expose migration/proof/topology warnings consistently; user-initiated saves confirm derived attested proof while read-only commands never write config.

```ts
const requiredInput = (legacy.required_context ?? []).map(p => `/context${p}`);
const lensDeadlineAt = Math.min(runDeadlineAt,
  startedAt + (policy.lensDeadlineMs ?? runDurationMs));
```

- [ ] Add structured `ReviewScopeError` codes/subtypes and safe shallow-history diagnostics. Probe shallow status before base/merge-base; never fetch. Exercise shallow/non-shallow missing base and merge-base, sufficient shallow history, and later collection failure. Keep caller input shape errors at exit 2 and selector errors available for exit 3.
- [ ] Run config, context and deadline tests; format, typecheck and commit `feat: add v9 configuration and preflight policies`.

### Task 3: Pinned changed-file coverage and shared read tools

**Files:** Create `src/context/change-coverage.ts`, `src/adapters/file-tools.ts`, `tests/context/change-coverage.test.ts`, `tests/adapters/file-tools.test.ts`; modify `src/adapters/types.ts` and `src/protocol/prompt.ts` for optional v9 coverage/page context.

**Interfaces:** Export `createChangeCoverageLedger({ context, policy, signal })` as an async factory. Its result exposes `scopeDigest`, `readFile({ path, offset?, byteCount? })`, `recordDiffDelivery(paths)`, `reconcileAttestation(attestation)`, `summary()`, `entries()`, and `close()`. Snapshot reads return exact bytes with offsets and hash metadata; adapters encode the returned bytes without shortening them. Export a common `createReadOnlyFileTools` wrapper with read/list/search operations backed by the ledger. Extend `AdapterReviewInput` with optional `coverage` ledger and `resultPages` collector options; extend capabilities with `observed_file_access` and `progress_observable`, and activity/progress events with a stable new identity/byte count. Do not infer observability from a phase string.

- [ ] Write real temporary-workspace tests for gap-free chunk coverage, changed snapshot identity, symlink escape, binary/oversize/deleted/untracked paths, incomplete diff, policy exclusions, and wrong attested digest. Prove partial reads cannot pass:

```ts
await ledger.readFile({ path: "worker.ts", offset: 0, byteCount: 3 });
expect(ledger.summary()).toMatchObject({ status: "incomplete", deficit_count: 1 });
await ledger.readFile({ path: "worker.ts", offset: 3 });
expect(ledger.summary()).toMatchObject({ status: "complete", deficit_count: 0 });
```

- [ ] Observe RED with the focused new tests.
- [ ] Implement normalized NFC workspace-relative scope identity, pinned safe reads, exact byte interval reconciliation, diff obligations and core-owned summaries. Core, not tool argument metadata, records response byte ranges. Keep material failures sticky, cap attested paths at 256, and reject claimed observed proof from opaque adapters. Hash fixed-key-order scope/ledger serialization and return deterministic bounded deficits.
- [ ] Add prompt instructions for core result/page IDs, coverage obligations, attestation proof labels, and explicit unavailable files. File content remains untrusted evidence.
- [ ] Run coverage/tool/prompt tests, format and typecheck; commit `feat: verify per-reviewer changed-file coverage`.

### Task 4: OpenAI-compatible paged production and progress

**Files:** Modify `src/adapters/openai-compatible.ts`, `src/adapters/openai-stream.ts`, `src/adapters/result-spool.ts`, `src/adapters/errors.ts`, `tests/adapters/openai-compatible.test.ts`, `tests/adapters/openai-stream.test.ts`, `tests/adapters/result-spool.test.ts`.

**Interfaces:** Consume `AdapterReviewInput.coverage`, `.resultPages`, common file tools and page collector from tasks 1/3. Emit stable progress identities for new transport bytes, response admission, completed tools and pages. Preserve resultStorage lifecycle and exact raw page bytes. The orchestrator injects final core coverage; provider final payload cannot supply it.

- [ ] Add scripted HTTP transport tests that force six findings across pages, exact length-fragment continuation, malformed chains, file-read failures, response-boundary progress, and unsupported-stream negotiation. Assert the actual prompts/requests contain the next page identity and candidate assignment, with unchanged initial deadlines.

```ts
expect(nextRequest.page_index).toBe(1);
expect(nextRequest.previous_page_digest).toBe(firstRawPageSha256);
expect(receivedResult.review_markdown).toBe(originalNarrative);
```

- [ ] Run focused adapter tests to show RED.
- [ ] Replace v9 final monolithic generation with collector-driven semantic pages, preserving legacy behavior only for explicitly legacy inputs used by compatibility tests. Reuse checkpoint retry and exact continuation within the same attempt; don't reinflate a new review for a page. Use shared pinned file tools for observed proof and report typed page/transport failures without dropping received bytes.
- [ ] Verify large legal narratives, invalid/incomplete pages and exact digests with existing stream/spool regressions. Format, typecheck and commit `feat: produce bounded OpenAI result pages`.

### Task 5: SDK and command adapter v9 parity

**Files:** Modify `src/adapters/{claude,copilot,codex,command,types,registry}.ts`, respective adapter tests, and `tests/fixtures/command-adapter.mjs`. Add small adapter-specific bridge modules only if needed to keep responsibilities focused.

**Interfaces:** Use the same page collector, file tools, result storage and progress event identities as task4. Claude and Copilot expose Review Mesh-owned tool handlers and observed proof; Codex remains attested-only. Command protocol v2 carries bounded page/access claims and monotonically new activity IDs; v1 remains a historical attested transport without observed capability.

- [ ] Write facade-level tests covering actual SDK request shapes, mediated read handlers, disabled mutation tools, multi-page continuation and cancellation. Test that Codex never advertises observed proof and command access claims cannot promote evidence to observed.

```ts
expect(codexCapabilities.observed_file_access).toBe(false);
expect(copilotCapabilities.observed_file_access).toBe(true);
expect(commandClaimSummary.proof_kind).toBe("attested");
```

- [ ] Run affected adapter tests and preserve RED evidence.
- [ ] Implement SDK page turns with core-supplied next page metadata and no reset of the caller signal. Use installed SDK types as authority for in-process tool registration. For opaque providers retain core-pinned digest attestations and verify through the common ledger; never call an SDK-native file read observed. Bound and validate command v2 event shapes and page claims.
- [ ] Run each adapter suite and compile actual SDK interfaces. Format and commit `feat: align SDK adapters with v9 pages and coverage`.

### Task 6: Canonical atomics, roots and gate reasons

**Files:** Modify `src/findings/{canonical,adjudication,attestation,evidence-verifier}.ts`, tests under `tests/findings`; use a focused helper module if the atomic/grouping algorithm outgrows the existing file.

**Interfaces:** Preserve immutable raw findings and historical normalization. Extend `canonicalizeFindings` output with `atomics`, `roots`, `semantic_proposals` and the exact seven v6 named count fields. Every atomic has core-derived `gate_eligibility: { eligible, reasons }`; each root has `subfindings`. Keep historical aliases internal only until task9 migrates all current views. Expose a deterministic candidate builder for adjudication, preserving every source ID and the 256-candidate limit.

- [ ] Add shuffled-arrival fixtures: exact duplicate claims, two distinct failure modes under one root, conflicting explicit duplicates, rootless/rooted stale-documentation variants, unrelated changed-path evidence, and every exclusion reason.

```ts
expect(canonical.roots[0]?.subfindings).toHaveLength(2);
expect(canonical.counts.atomic_subfindings).toBe(2);
expect(canonical.atomics.every(f => f.gate_eligibility.eligible
  ? f.gate_eligibility.reasons.length === 0
  : f.gate_eligibility.reasons.length > 0)).toBe(true);
```

- [ ] Run findings tests to demonstrate RED.
- [ ] Implement normalized trigger/behavior/outcome/category/evidence compatibility, evidence overlap, stable codepoint ordering and pairwise semantic proposal threshold from the spec. A shared root groups without collapsing; proposals never change counts or gates. Derive eligibility from policy, proof, adjudication and coverage; unrelated file deficits must not suppress a finding whose own causal evidence is verified.
- [ ] Apply exact candidate coalescing before paging; retain distinct candidates and source IDs. Missing decisions cause partial execution coverage. Format, test, typecheck, and commit `feat: preserve atomic findings and explain gate eligibility`.

### Task 7: Immutable artifact v2 and shared normalization

**Files:** Create `src/diagnostics/{run-artifact,run-index,normalize-run}.ts`; modify `src/diagnostics/{run-recorder,run-record-reader}.ts`, `src/protocol/event-writer.ts`; add artifact/index/normalization tests and extend recorder/writer tests.

**Interfaces:** Export `ArtifactReference { path, sha256, byte_count, completed_results }`. Recorder adds format2 initialization and `finalize(summary): Promise<ArtifactReference>`; immutable terminal summary precedes a preterminal digest record. `EventWriter` supports an optional `finalizeArtifact(draft)` callback before constructing the public terminal and an `observePublicStream(outcome)` callback after writing it. Export `readNormalizedRun(path, options)` and `resolveRunArtifact(runId, options)` returning one normalized model with raw source results, canonical findings, reported historical values, deadline/coverage/outcome dimensions, warnings, artifact identity and digest status. Index records external identity/digest plus observed public delivery.

- [ ] Add tests proving exact final ordering, no digest recursion, a 13 MiB narrative reconstructed from 24 KiB private chunks, strict unknown-version/type rejection, legacy result preservation, index-bound digest verification, orphan digest-unavailable labels, and no event after terminal.

```ts
expect(records.at(-2)?.record).toBe("run.terminal_summary");
expect(records.at(-1)?.record).toBe("run.artifact_terminal");
expect(records.some(r => r.event === "run.completed")).toBe(false);
expect(createHash("sha256").update(finalBytes).digest("hex"))
  .toBe(artifact.sha256);
```

- [ ] Observe RED against the focused persistence tests.
- [ ] Implement strict per-record version dispatch and bounded streaming reads, narrative chunk reconstruction and per-result verification. Serialize and hash exact owned file bytes; sync/close, publish without overwrite, reverify, index, then permit the public terminal. Keep immutable planned versus mutable observed delivery separate. Failed stdout still leaves an authoritative terminal artifact. External details replacement/deletion returns typed failure and never stale staging.
- [ ] Normalize v5 no_findings only in derived v9 values, preserve reported values, and mark legacy changes coverage unknown/partial. Unknown future schemas fail strict reading; best-effort salvages independently valid records with explicit warnings.
- [ ] Run persistence/writer/large-artifact tests, format, typecheck and commit `feat: finalize and verify v2 run artifacts`.

### Task 8: Integrate v9 scheduling, evidence and continuous liveness

**Files:** Modify `src/orchestrator/{run-review,state,lens-policy}.ts`, `src/app.ts`, `src/protocol/event-writer.ts`, `src/adapters/errors.ts`, `tests/orchestrator`, `tests/cli/review.test.ts`; create `src/orchestrator/activity.ts` and focused activity/deadline integration tests.

**Interfaces:** Switch newly written events/results to v6/v4/v2 only. `RunCompletion` exposes run/gate/coverage dimensions and named canonical counts. Invoke task2 deadline/prerequisite/topology, task3 per-result ledger, task6 canonicalizer and task7 finalizer. Concise event lists include totals/omissions/digests and one artifact reference; explicit full-jsonl delivers every exact accepted result.

- [ ] Reproduce the motivating heartbeat defect under fake time with attempt timeout, retry, fallback and adjudication. Add five-file 23285-byte deadline, queue/semaphore time, caller/run/lens/candidate/attempt/progress precedence, identical activity, file-unavailable pass, disjoint partial quorum, incomplete adjudication and absent readiness metadata tests.

```ts
expect(completion).toMatchObject({
  runOutcome: "inconclusive", gateOutcome: "no_gate_findings",
  coverageOutcome: "partial", exitCode: 3,
});
expect(Math.max(...heartbeatGaps)).toBeLessThanOrEqual(interval + tolerance);
expect(providerCallsForReadiness).toBe(0);
```

- [ ] Demonstrate expected failures with the focused scheduler tests.
- [ ] Start run/lens deadlines at the single run.started instant; queue/probe/backoff/continuations never reset them. Scope attempt timers/controllers locally. Reset no-progress only on monotonically new identities/bytes or completed operations. Store simultaneous abort causes with stable primary precedence, stop admissions and clean up within one shutdown grace.
- [ ] Keep the suite heartbeat alive through retry and finalization, coalesce repetitive activity, enforce 2048/1 MiB private defaults (16384/8 MiB full), and use minimal public liveness records after the 1 MiB budget. Cap active samples at eight without truncating values. Persist full details privately.
- [ ] Reconcile result-specific coverage before clean quorum admission. Preserve syntactically valid incomplete results for diagnosis; keep finding evidence visible. Derive coverage-first outcomes and single artifact delivery status; finalize artifact/index before unmirrored terminal output. Require details path before run admission when managed persistence is disabled. Bound config/context preflight at 60000 ms.
- [ ] Test 40-model terminal/heartbeat byte ceilings, 10000 repetitive activities and 81-minute fake-clock liveness. Run scheduler/app/writer tests, format/typecheck, commit `feat: enforce bounded dependable v9 review runs`.

### Task 9: Unify all derived views and dashboard

**Files:** Modify `src/diagnostics/{run-report,run-status}.ts`, `src/server/{dashboard-data,dashboard-ui,dashboard-server}.ts`, `src/cli.ts`, `src/discovery/{schema,description,describe,help}.ts`, and matching diagnostics/server/CLI tests.

**Interfaces:** All post-run readers consume `readNormalizedRun`/`resolveRunArtifact`. Current report/status/dashboard schemas are 2/3/2. `findings --deduplicate` exposes roots with atomic subfindings. Retry reuse requires verified parent result ledgers with identical scope and policy; otherwise rerun inspection.

- [ ] Add one real v2 artifact fixture consumed by report, status, findings, retry selection and dashboard. Assert exact canonical order/count parity, complete narrative/digests, warnings, skip ledger, deadline metadata, coverage-first headline and historical reported values.

```ts
expect(report.canonical.counts).toEqual(status.canonical.counts);
expect(dashboard.canonical.counts).toEqual(report.canonical.counts);
expect(markdown).toContain("Inconclusive: partial coverage");
expect(markdown).not.toContain("No findings were available");
```

- [ ] Run new view tests for RED.
- [ ] Route readers through shared strict normalization and verified artifact lookup; remove parallel interpretation logic. Update read-only UI with outcome, deadlines/progress, evidence deficits, roots/subfindings and related-finding proposals. Preserve existing vanilla design/accessibility and server restrictions. Keep full result drill-down lossless.
- [ ] Exercise orphan/legacy/external missing/replaced artifact cases and schema discovery. Format/typecheck/test diagnostics, CLI and server; commit `feat: present consistent v9 run evidence and outcomes`.

### Task 10: Doctor parity, release acceptance and documentation

**Files:** Modify `src/cli.ts`, `src/discovery/help.ts`, `README.md`, `package.json`, `package-lock.json`, `scripts/verify-standalone.mjs`, relevant CLI/acceptance tests; create `tests/acceptance/v9-dependable-gate.test.ts` and release notes under `docs/releases/`.

**Interfaces:** `doctor --structured-output` uses the same v9 run path with a temporary owned workspace and explicit artifact destination. It reports readiness, progress/streaming, file access, pages, coverage, schema and deadline stages with real typed failures. Current CLI defaults and examples advertise request3/config7/event6/result4, concise default, PR prerequisites and digest-verified retrieval.

- [ ] Add doctor integration tests proving actual common-path file/page/coverage/deadline handling. Add cross-surface acceptance for 13 MiB narrative and near-16 MiB result; validate 40-model concise bounds, external details authority, strict historical reading and exit semantics.

```ts
expect(doctorResult.stages.coverage.status).toBe("passed");
expect(readBack.review_markdown).toBe(largeNarrative);
expect(Buffer.byteLength(terminalLine, "utf8")).toBeLessThan(16 * 1024);
```

- [ ] Observe RED for new acceptance/doctor contracts, then implement remaining integration and command help.
- [ ] Update version to 9.0.0, document deliberate compatibility changes and migration without modifying the user's machine config. Explain weaker attested proof, required PR metadata, topology warnings and concise/full artifact behavior with concrete commands.
- [ ] Run `npm run format:check`, `npm run typecheck`, `npm test -- --maxWorkers=1`, `npm run build`, and Windows/Linux standalone acceptance sequentially. If unrelated baseline formatting drift persists, document it and verify all touched files without unrelated churn. Resolve any new failures. Verify standalone version and artifact SHA256SUMS.
- [ ] Run an independent whole-branch review against all 35 acceptance criteria, resolve material findings, and commit final release preparation. Publication must use the verified final commit and checksums; do not publish while any required gate remains unmet.

## Acceptance trace

| Spec acceptance | Task(s) |
| --- | --- |
| 1-4: heartbeat/deadlines/progress | 2, 8 |
| 5-9: coverage/read proofs/quorum | 3-5, 8 |
| 10-13: bounded pages/large results/adjudication | 1, 4-5, 6-7, 10 |
| 14-18: outcome/atomic/root/semantic/count parity | 6, 8-9 |
| 19-23: concise bounds/activity/liveness/full delivery | 7-8, 10 |
| 24-28: execution/readiness/topology/defaults | 2, 6, 8, 10 |
| 29: shallow-history safety | 2 |
| 30: doctor parity | 10 |
| 31-33: compatibility/finalization/external artifacts | 7-10 |
| 34: CAS/migration/proof confirmation | 2, 10 |
| 35: full verification/review/packaging | 10 |

## Completion record

The ignored task ledger contains the current task, commit ranges, review reports, test evidence and any implementation decisions. Check it and Git history before resuming; never redispatch completed work from conversational memory alone.
