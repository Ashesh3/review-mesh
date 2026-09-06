# SDK-Owned Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore Review Mesh as a thin coordinator over vendor-owned coding-agent SDKs and remove its custom inference harness.

**Architecture:** Keep review scope, configuration, scheduling, lifecycle, result delivery, and persistence in Review Mesh. Each adapter starts one vendor agent session and consumes its events and final result. SDKs own inference, repository tools, conversation management, compaction, and transient retries.

**Tech Stack:** TypeScript, Node, Bun standalone builds, Claude Agent SDK, Codex SDK, optional GitHub Copilot SDK, existing Zod/Vitest infrastructure.

**Spec:** [SDK-owned review design and assessment](../specs/2026-09-06-sdk-owned-review-design.md).

**Status:** Accepted SDK routing; implementation proceeds with managed native runtimes.

## Global constraints

- SDKs own model requests, repository exploration, conversation state, compaction, and normal provider retries.
- Never convert malformed output, exhausted budget, missing completion, or a timeout into a clean review.
- No silent downgrade of coverage, isolation, reviewer roster, or gate semantics.
- Keep current configured gate/quorum/adjudication behavior during the execution migration.
- Preserve historical artifact readers independently from old executable inference code.
- Gemini integration is outside this proposal.
- Use `https://packagefeedproxy.microsoft.io/npm/` for package operations.
- Validate the compiled Windows artifact and the Linux release target independently.
- No runtime mode may silently fall back to a subprocess when zero-process operation is required.

## Task 1: Prove the selected runtime and deployment contract

**Files:**

- Create: `scripts/verify-sdk-runtime.mjs`.
- Create: `tests/acceptance/sdk-runtime-packaging.test.ts`.
- Modify when the chosen backend needs it: `scripts/standalone-entry.mjs`, `scripts/build-standalone.mjs`, `scripts/verify-standalone.mjs`.
- Modify package pins only after choosing the runtime: `package.json`, `package-lock.json`.
- Evidence: `docs/investigations/sdk-runtime-feasibility.md`.

**Consumes:** Selected SDK, exact version, approved process contract.
**Produces:** Reproducible source and compiled-runtime evidence before changing review semantics.

- [ ] Record the selected contract as `managed_process` or `in_process_required`; record shell-tool permissions separately.
- [ ] For Claude, embed the correct platform binary and use its documented extraction API:

```ts
// Windows entry-point example; Linux builds use their platform package.
import asset from "@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe" with { type: "file" };
import { extractFromBunfs } from "@anthropic-ai/claude-agent-sdk/extract";
const runtimePath = extractFromBunfs(asset);
// Supply runtimePath as pathToClaudeCodeExecutable when starting the SDK.
```

- [ ] Verify native startup/handshake and cleanup without inference first. Remove unrelated vendor CLI installations from the test process's PATH; do not alter machine configuration.
- [ ] For strict in-process operation, pin and inspect Copilot 1.0.13 plus its compatible native runtime. Start `RuntimeConnection.forInProcess()` under Node, then under the actual compiled Bun artifact. Capture child-process creation, handle cleanup, native callbacks, and sequential/concurrent shutdown behavior.
- [ ] Test whether per-client auth/env/directory requirements can be satisfied despite the documented FFI limitations. A failed requirement keeps this mode unavailable; it does not justify a hidden subprocess fallback.
- [ ] Disable shell tools, external MCP servers, hooks, extensions, and host Git actions for the strict-process test. Check native search/helper behavior as well as the SDK launcher.
- [ ] Record separate outcomes for imports, runtime startup, inference, packaging, process behavior, and shutdown. Passing imports alone is insufficient.

**Run:** `node scripts/verify-sdk-runtime.mjs --sdk claude --mode managed_process` for the recommended managed-runtime track; the script also accepts `--sdk copilot --mode in_process_required`. Run the corresponding compiled artifact check on each release OS.

**Exit condition:** A chosen runtime meets the selected process contract, or the strict contract is reported as unsupported with the exact failing observation. This task must not introduce custom HTTP/agent-loop fallback code.

## Task 2: Define a small native review contract and version coverage honestly

**Files:**

- Modify: `src/adapters/types.ts`, `src/adapters/errors.ts`, `src/protocol/schemas.ts`, `src/protocol/prompt.ts`.
- Create: `src/protocol/native-review.ts`, `tests/protocol/native-review.test.ts`.
- Modify: `src/discovery/schema.ts`, `src/discovery/description.ts`.

**Consumes:** Existing request/scope/roster plus the runtime capability result.
**Produces:** `NativeReviewInput`, `NativeReviewOutput`, `NativeReviewResult`, `NativeReviewEvent`, and `NativeReviewAdapter`.

- [ ] Add a contract that excludes model history, context budgets, page collectors, and continuation attempts:

```ts
export interface NativeReviewInput {
  runId: string;
  reviewerId: string;
  workspace: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  resultJsonSchema: Record<string, unknown>;
  signal: AbortSignal;
}

export interface NativeReviewOutput {
  verdict: "pass" | "findings";
  summary: string;
  findings: Array<{
    title: string;
    body: string;
    severity: "critical" | "high" | "medium" | "low";
    path: string;
    startLine: number;
    endLine: number;
  }>;
}

export interface NativeReviewResult extends NativeReviewOutput {
  nativeFinalReport: string;
  coverageBasis: "native_observed" | "model_attested" | "unknown";
}

export type NativeReviewEvent =
  | { type: "activity"; message: string }
  | { type: "result"; result: NativeReviewResult }
  | { type: "failure"; code: string; message: string };

export interface NativeReviewAdapter {
  run(input: NativeReviewInput): AsyncIterable<NativeReviewEvent>;
  forceCleanup(): Promise<void>;
}
```

- [ ] Define `parseNativeReviewOutput(value: unknown): NativeReviewOutput` using Zod plus verdict/finding consistency checks. Derive the model-output JSON schema from this definition; do not maintain divergent handwritten schemas. Capture `nativeFinalReport` from the SDK result and assign `coverageBasis` from verified telemetry or the explicitly weaker attestation contract, never from a model's choice of metadata.
- [ ] Preserve existing finding fields needed by configured policy when mapping this internal result into public artifacts. Do not drop original evidence or raw final report in normalization.
- [ ] Test the product invariant with an actual invalid result:

```ts
expect(() => parseNativeReviewOutput({
  verdict: "pass", summary: "Clear",
  findings: [{ title: "Null access", body: "Fails for an empty input.",
    severity: "high", path: "src/a.ts", startLine: 3, endLine: 3 }],
})).toThrow();
```

- [ ] Add explicit coverage-basis metadata. Reject migration of exact-byte-coverage requirements when the selected SDK cannot prove them. Unknown coverage must not be promoted to observed coverage by normalization.
- [ ] Record live-worktree consistency and initial/final provenance. A mutation during review must not retain an immutable-snapshot claim. Do not add model-driven snapshot acquisition or repair loops.
- [ ] Retain the full terminal report; an oversize report fails explicitly with preserved available evidence, rather than truncating to pass.

**Run:** `node node_modules/vitest/vitest.mjs run tests/protocol/native-review.test.ts` and `npm run typecheck`.

## Task 3: Deliver one full Claude review through the public CLI

**Files:**

- Modify: `src/adapters/claude.ts`, `src/adapters/registry.ts`.
- Modify: `src/app-v9.ts`, `src/orchestrator/run-v9.ts` only at the adapter invocation seam.
- Create: `tests/acceptance/sdk-review-cli.test.ts`.
- Modify: `tests/adapters/claude.test.ts`, `tests/live/live-adapters.test.ts`.

**Consumes:** Task 2's native contract and Task 1's runtime path.
**Produces:** A native review execution path with one SDK session and complete terminal delivery.

- [ ] Adapt `createClaudeAdapter` to the native contract using `query`, `outputFormat`, native `Read`/`Glob`/`Grep`, explicit tool permissions, and the caller's AbortSignal.
- [ ] Keep trusted prompt boundaries and intentionally selected SDK configuration. Remove forced snapshot tools, page assignments, coverage reprompts, and host-driven schema-repair turns from this path.
- [ ] Pass SDK errors through a small sanitized failure mapping. Do not call `query()` again merely because the provider is rate limited or the result is malformed.
- [ ] Add fake-SDK stream tests for valid result, missing `structured_output`, native failure, cancellation, and stream ending without completion. Assert the SDK start count is one for terminal failures.
- [ ] Exercise `review-mesh review` with isolated fixture config, a seeded defect, and its corrected variant. Ensure the acceptance test uses the new production path rather than direct `adapter.run` with legacy input.
- [ ] Verify native read/search access, unchanged repository bytes, full result/report output, cancellation, and no visible Windows console. Authenticate through the supported chosen provider; never print credentials.

**Run:** `node node_modules/vitest/vitest.mjs run tests/adapters/claude.test.ts tests/acceptance/sdk-review-cli.test.ts`; then the opt-in real public-CLI case and compiled-artifact case with controlled credentials and fixtures.

**Exit condition:** A real native-agent review works from the shipped entry point. Keep legacy execution available only as an explicit transition choice until migration is complete.

## Task 4: Restore Codex and optionally add Copilot to the same contract

**Files:**

- Modify: `src/adapters/codex.ts`, `src/adapters/copilot.ts`, `src/copilot/runtime.ts`, `src/copilot/account.ts`.
- Modify: `src/config/schemas.ts`, `src/config/resolve.ts`, `src/config/manage.ts`.
- Modify: `tests/adapters/codex.test.ts`, `tests/adapters/copilot.test.ts`, `tests/copilot/runtime.test.ts`, `tests/acceptance/sdk-review-cli.test.ts`.

**Consumes:** Native contract and completed runtime feasibility.
**Produces:** Independently selectable vendor adapters without shared inference machinery.

- [ ] Reproduce the current Codex blocker before changing it:

```powershell
node node_modules/vitest/vitest.mjs run tests/adapters/codex.test.ts -t "characterizes the pinned runtime skill leak that keeps production unavailable"
```

- [ ] Replace blanket `isolationVerified` injection with supported runtime controls and characterization of hostile project config/skills. Require actual runtime evidence before production registration reports available.
- [ ] Define explicit Codex authentication using supported runtime credentials. Preserve current API-key operation and add another mode only with a demonstrated supported workflow. Do not copy private login state as an implicit fallback.
- [ ] Run one Codex thread with `runStreamed` and `outputSchema`; remove page/repair loops. Validate that its native sandbox and necessary command tools satisfy the selected process/tool contract.
- [ ] For Copilot, use one session and vendor context management. Add a schema-backed `submit_review` terminal tool; validate its arguments with `parseNativeReviewOutput`. A validation failure is a tool result inside the SDK loop, not a host-created conversation.
- [ ] Implement Copilot BYOK only through the official `provider` configuration if retained custom endpoints require it. Keep model, harness, protocol, and credential identity explicit. No protocol conversion or provider request interception in Review Mesh.
- [ ] Expose experimental FFI only if Task 1 passes; managed mode remains the initial production recommendation where allowed. Never silently switch modes.
- [ ] Run the same public CLI defect/corrected/cancel/failure cases separately for each enabled SDK.

**Run:** `node node_modules/vitest/vitest.mjs run tests/adapters/codex.test.ts tests/adapters/copilot.test.ts tests/copilot/runtime.test.ts tests/acceptance/sdk-review-cli.test.ts` plus the opt-in native CLI acceptance matrix.

## Task 5: Remove the redundant execution engine and migrate configuration

**Files:**

- Modify: `src/orchestrator/run-v9.ts`, `src/adapters/registry.ts`, `src/app.ts`, `src/config/schemas.ts`, `src/config/manage.ts`, `src/config/resolve.ts`.
- Modify: `src/diagnostics/retry-v9.ts` and its tests to prevent incompatible completion/coverage inheritance.
- Delete from executable dependency graph, then remove after reference checks: `src/adapters/openai-compatible.ts`, `openai-stream.ts`, `openai-pages.ts`, `context-budget.ts`, `segmented-review.ts`, `segment-followups.ts`, `segment-evidence-memory.ts`, `checkpoint-response.ts`, `inspection-session.ts`.
- Split or remove live model-facing sections of `src/adapters/sdk-pages.ts`, `result-spool.ts`, `src/results/result-pages.ts`; retain artifact readers/storage that still serve historical or current delivery.
- Review consumers before removing `src/adapters/file-tools.ts` or provider-error helpers; a narrow deterministic custom tool may still be required for strict-process execution.
- Modify: `tests/orchestrator/`, `tests/config/`, `tests/diagnostics/`, relevant adapter fixtures.

**Consumes:** Successful native public-CLI adapters.
**Produces:** One live execution architecture, with no custom provider inference or recovery engine.

- [ ] Remove provider circuit state, cooldown admission, turn-level retries, context-budget knobs, semantic checkpoint settings, and model-facing result pagination from native execution.
- [ ] Retain reviewer concurrency, run/reviewer wall-clock deadlines, cancellation, terminal errors, and explicit user-requested whole-review retry.
- [ ] Keep existing gate/quorum/adjudication meaning during this step; give an adjudication job to a native SDK through the same thin boundary if configured.
- [ ] Reject obsolete raw-provider registrations with a concrete migration diagnostic. Offer supported SDK provider mappings without silently changing a model or authentication source. Retire command registrations only if the simplified SDK-only product surface is accepted; they are not themselves a custom inference loop.
- [ ] Fingerprint harness, model, runtime version, source/scope identity, coverage contract, and workspace consistency when inheriting results for explicit retries. An absent/incompatible fingerprint requires a rerun of the affected reviewer. Test a historic observed-snapshot result retried after migration to native live-worktree execution; it must not inherit completion or proof.
- [ ] Keep historical artifact loading separate from executable legacy orchestration. Remove `src/orchestrator/run-review.ts` only after runtime imports and legacy fixtures have been separated.
- [ ] Assert architecture by checking the executable import graph: native SDK adapters and core must not import removed model transport/budget/segmentation modules. Network requests in vendor SDK code are expected; an application-wide `fetch` ban would be the wrong test.
- [ ] Test that a terminal SDK rate-limit failure starts no second reviewer attempt automatically and still preserves another reviewer's findings.
- [ ] Test config migration rejects unsupported exact-byte coverage rather than silently accepting weaker telemetry.
- [ ] Preserve explicit policy-driven `skipped` terminal dispositions while the existing quorum/adjudication policy remains in use.

**Run:** `npm run typecheck` and targeted orchestrator/config/artifact tests after updating their product expectations. Search references with `rg` before deleting any shared module.

## Task 6: Validate quality, compatibility, and the distributable

**Files:**

- Modify: `tests/live/live-adapters.test.ts`, `tests/acceptance/sdk-review-cli.test.ts`, `scripts/evaluate-quality.mjs`, `scripts/verify-standalone.mjs`.
- Modify: `README.md`, discovery/help/schema text, migration documentation.
- Preserve: existing read-only dashboard and artifact recovery behavior.

**Consumes:** The native execution architecture and explicit configuration migration.
**Produces:** Release-quality evidence and accurate product claims.

- [ ] Run the existing buggy/corrected quality corpus through each selected SDK using the public CLI. Record completion, defect recall, false positives, duration, and provider-reported usage separately.
- [ ] Include a repository large enough to trigger native compaction. Confirm compaction events originate from the vendor runtime and that Review Mesh sends no synthetic checkpoint/summary-repair conversation.
- [ ] Verify authentication failure, persistent quota/rate errors, cancellation, missing structured output, output overflow, and interrupted artifact storage. These cases must not become clean reviews.
- [ ] Verify historic artifacts, result retrieval, status, report, dashboard, retention, and recovery with native-produced results.
- [ ] Change a fixture file during a native review and verify live-worktree mutation reporting. Verify retry inheritance rejects a changed execution/coverage contract.
- [ ] Validate Windows and Linux distributables on environments without separately installed vendor CLIs; verify no console windows and correct native asset cleanup. Run zero-process acceptance only for the strict FFI profile.
- [ ] Rewrite README claims around the actual supported packaging and harness boundary. Explain that vendor retries/compaction remove implementation responsibility but cannot guarantee exhaustive bug detection or unlimited service availability.
- [ ] Run required repository checks once the final code is ready:

```powershell
npm run verify
npm run verify:standalone
```

- [ ] Report baseline/environment failures separately from regressions; do not fix unrelated formatting or user files to make a broad command pass.
- [ ] Present the reviewed diff and validation evidence before publishing a release. Follow the user's explicit commit/push/release authorization in the execution session.

## Plan self-review

- Process requirement gates runtime selection in Task 1; no unanswered preference is treated as approval.
- Tasks 2–4 replace the agent-execution boundary before Task 5 removes the existing backend.
- Native tool output, semantic review quality, and coverage proof remain distinct.
- Artifact durability and historical readers survive removal of inference machinery.
- The existing disabled Codex adapter and misleading legacy live-test path have explicit regression coverage.
- A separate policy decision is still required before replacing configured quorum/adjudication with the original all-independent-reviewers policy.

## Execution notes

Implementation follows the accepted per-model-family routing with managed native runtimes. Plan examples were adapted to retain existing result-v4 findings and v6 artifact compatibility instead of introducing a second title/body result shape. The raw inference engine and dedicated tests are removed; command-only compatibility remains and mixed runs require separate rosters. SDK/native-runtime versions are recorded separately. Source and compiled runtime checks use local fixtures; live synthetic model outcomes are recorded in docs/sdk-validation.md; a large-context compaction benchmark remains pending.

See `docs/sdk-migration.md` for the implemented configuration and deployment contract. The implementation ledger and individual validation reports are in the ignored `.superpowers/sdd/2026-09-06-sdk-owned-review/` workspace.
