# Review Mesh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first production-shaped `review-mesh review` CLI that runs the entire trusted reviewer roster, streams normalized JSONL progress, and returns a unanimous pass, findings, or incomplete result across command, Copilot, Claude, and Codex adapters.

**Architecture:** A neutral TypeScript orchestrator owns request/configuration resolution, live-worktree context discovery, concurrent reviewer lifecycle, schema validation, JSONL serialization, and final aggregation. Each runtime adapter owns its native agent session and translates native activity into one internal adapter contract; no adapter can change the public protocol or select the suite.

**Tech Stack:** Node.js `>=22.12.0`, TypeScript 5.9, npm lockfile, Zod 4, `smol-toml`, `env-paths`, Execa 10, Vitest 4, Git CLI, GitHub Copilot SDK 1.0.11, Claude Agent SDK 0.3.251, Codex SDK 0.151.0.

**Spec:** `docs/superpowers/specs/2026-08-29-review-mesh-design.md`

## Global Constraints

- The only MVP public operation is `review-mesh review`, reading exactly one versioned JSON object from stdin.
- Stdout contains JSONL protocol events only; diagnostics go to stderr or the application-data directory.
- Public protocol version is the string literal `"1"`.
- One invocation represents one stateless review round and attempts every resolved reviewer exactly once as a logical job.
- The caller cannot select, skip, disable, replace, or reorder reviewers.
- A round passes only when every reviewer returns a valid `pass` with zero actionable findings.
- Round precedence is `incomplete > findings > passed`; exit codes are `0`, `1`, `2`, `3`, and `4` as defined by the spec.
- Reviewers run independently and concurrently, subject to deterministic roster-order queueing.
- Review Mesh does not snapshot, lock, or invalidate a changing workspace; report `consistency_mode: "live_worktree"`.
- Do not consolidate, rank, deduplicate, or pass findings between reviewers in the MVP.
- The core never intentionally writes under the reviewed workspace.
- Repository policy is untrusted additive data and cannot register executables, credentials, adapters, models, or increased privileges.
- Configuration expresses an `IsolationPolicy` of `prefer_enforced` or `require_enforced`; runtime events report an achieved `IsolationLevel` of `enforced_read_only`, `runtime_read_only`, or `prompt_only`.
- Under `prefer_enforced`, adapters attempt their strongest supported read-only boundary and may degrade to `prompt_only` with explicit disclosure. Under `require_enforced`, anything less than `enforced_read_only` makes that reviewer incomplete.
- SDK package versions and method names below were verified on 2026-08-29. Before implementing each live adapter, rerun its task-specific `npm view` and declaration-file checks; implement against the pinned lockfile version instead of silently upgrading.
- Use ESM (`"type": "module"`) and `moduleResolution: "NodeNext"`.
- Use `npm ci` after the first committed lockfile; do not replace npm with another package manager during this plan.
- Use TDD for every task: failing focused test, minimal implementation, focused pass, then full relevant suite.
- Commit after each task with the exact natural-language commit message shown; do not use AI or automation prefixes.

## File map

```text
package.json                         package metadata, scripts, CLI bin, pinned dependencies
package-lock.json                    reproducible npm dependency graph
tsconfig.json                        production TypeScript build
tsconfig.test.json                   test and fixture typechecking
vitest.config.ts                     deterministic test configuration
.gitignore                           build, coverage, and local diagnostic exclusions
.prettierignore                      keep approved design/plan artifacts byte-stable
README.md                            machine-facing install, configuration, and protocol examples

src/cli.ts                           process entrypoint, stdin/stdout/stderr, signals, exit code
src/app.ts                           dependency-injected review application composition
src/protocol/schemas.ts              request, finding, reviewer-result, and public-event Zod schemas
src/protocol/json-schema.ts          JSON Schema generated from reviewer-result Zod schema
src/protocol/event-writer.ts         serialized monotonic JSONL event emission
src/protocol/prompt.ts               invariant/reviewer/context prompt construction

src/config/schemas.ts                trusted and repository TOML schemas
src/config/paths.ts                  platform application-data and isolated runtime paths
src/config/load.ts                   read and parse configuration files
src/config/resolve.ts                trust-aware layered merge and instruction provenance

src/context/git.ts                   read-only bounded Git command runner and parsers
src/context/resolve.ts               canonical live-worktree context manifest

src/adapters/types.ts                adapter, capability, input, event, and registry contracts
src/adapters/errors.ts               adapter-error taxonomy and sanitization
src/adapters/registry.ts             trusted adapter factories keyed by adapter ID
src/adapters/command.ts              generic external-command adapter
src/adapters/copilot.ts              GitHub Copilot SDK adapter
src/adapters/claude.ts               Claude Agent SDK adapter
src/adapters/codex.ts                Codex SDK adapter

src/orchestrator/state.ts            reviewer/suite lifecycle state and final aggregation
src/orchestrator/run-review.ts       preflight, queue, timeouts, heartbeats, cancellation
src/diagnostics/run-recorder.ts       best-effort sanitized JSONL run persistence

tests/helpers/async-queue.ts          controllable async event stream for fake adapters
tests/helpers/fake-adapter.ts         deterministic adapter double
tests/helpers/fixtures.ts             request, config, context, and result builders
tests/fixtures/command-adapter.mjs    external-adapter behavior fixture
tests/fixtures/git-repo.ts            temporary Git repository builder
tests/fixtures/valid-request.json     canonical compiled-CLI smoke request

tests/protocol/schemas.test.ts
tests/protocol/event-writer.test.ts
tests/protocol/prompt.test.ts
tests/config/resolve.test.ts
tests/context/resolve.test.ts
tests/orchestrator/state.test.ts
tests/orchestrator/run-review.test.ts
tests/adapters/command.test.ts
tests/adapters/copilot.test.ts
tests/adapters/claude.test.ts
tests/adapters/codex.test.ts
tests/diagnostics/run-recorder.test.ts
tests/cli/review.test.ts
tests/live/live-adapters.test.ts
```

---

### Task 1: Bootstrap the package and public protocol schemas

**Files:**
- Create: `package.json`
- Create: `package-lock.json`
- Create: `tsconfig.json`
- Create: `tsconfig.test.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `.prettierignore`
- Create: `src/protocol/schemas.ts`
- Create: `src/protocol/json-schema.ts`
- Create: `tests/protocol/schemas.test.ts`

**Interfaces:**
- Produces: `JsonValue`, `ReviewRequest`, `ReviewerResult`, `PublicEvent`, `ReviewerPhase`, `ReviewerTerminalRecord`, `RunStatus`, `IsolationPolicy`, `IsolationLevel`, `IncompleteReason`, `reviewRequestSchema`, `reviewerResultSchema`, `publicEventSchema`, and `reviewerResultJsonSchema`.
- Consumes: nothing; this task establishes the canonical wire vocabulary used by every later task.

- [ ] **Step 1: Add the package and compiler configuration**

Create `package.json` with this dependency baseline and scripts:

```json
{
  "name": "review-mesh",
  "version": "0.1.0",
  "private": true,
  "description": "Agent-first multi-runtime code review gate",
  "type": "module",
  "bin": {
    "review-mesh": "./dist/cli.js"
  },
  "engines": {
    "node": ">=22.12.0"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "verify": "npm run format:check && npm run typecheck && npm test && npm run build"
  },
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "0.3.251",
    "@anthropic-ai/sdk": "0.122.0",
    "@github/copilot-sdk": "1.0.11",
    "@modelcontextprotocol/sdk": "1.30.0",
    "@openai/codex-sdk": "0.151.0",
    "env-paths": "4.0.0",
    "execa": "10.0.1",
    "smol-toml": "1.8.0",
    "zod": "4.5.2"
  },
  "devDependencies": {
    "@types/node": "22.20.0",
    "prettier": "3.9.6",
    "tsx": "4.23.12",
    "typescript": "5.9.3",
    "vitest": "4.1.11"
  }
}
```

Create `tsconfig.json` with `target: "ES2022"`, `module: "NodeNext"`, `moduleResolution: "NodeNext"`, `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, `rootDir: "src"`, `outDir: "dist"`, declarations and source maps enabled, and `include: ["src/**/*.ts"]`.

Create `tsconfig.test.json` extending the production config, setting `noEmit: true`, `rootDir: "."`, `types: ["node", "vitest/globals"]`, and including `src/**/*.ts`, `tests/**/*.ts`, and `vitest.config.ts`.

Create `vitest.config.ts` with Node environment, `tests/**/*.test.ts`, `restoreMocks: true`, and `clearMocks: true`. Ignore `dist/`, `coverage/`, `.review-mesh-runs/`, and `*.log` in `.gitignore`.

Create `.prettierignore` containing:

```text
dist/
coverage/
node_modules/
docs/superpowers/
package-lock.json
```

This keeps the already approved design and implementation-plan artifacts out of later mechanical formatting commits.

- [ ] **Step 2: Install the exact graph and verify the empty toolchain**

Run:

```powershell
npm install
npm run typecheck
```

Expected: npm writes `package-lock.json`; TypeScript succeeds with no source files.

- [ ] **Step 3: Write failing schema tests**

Create `tests/protocol/schemas.test.ts` covering these exact behaviors:

```ts
import { describe, expect, it } from "vitest";
import {
  reviewRequestSchema,
  reviewerResultSchema,
} from "../../src/protocol/schemas.js";

describe("reviewRequestSchema", () => {
  it("preserves raw instructions and arbitrary context", () => {
    const request = reviewRequestSchema.parse({
      schema_version: "1",
      request_id: "caller-7",
      workspace: "F:\\Projects\\demo",
      instructions: "Review current changes exactly as supplied.",
      scope_hints: { base: "origin/master", staged: false },
      context: { nested: { custom: [1, true, "x"] } },
    });

    expect(request.instructions).toBe(
      "Review current changes exactly as supplied.",
    );
    expect(request.context).toEqual({ nested: { custom: [1, true, "x"] } });
  });

  it("rejects reviewer selection and unknown top-level fields", () => {
    expect(() =>
      reviewRequestSchema.parse({
        schema_version: "1",
        workspace: ".",
        instructions: "review",
        reviewers: ["security-claude"],
      }),
    ).toThrow();
  });
});

describe("reviewerResultSchema", () => {
  it("accepts a clean pass", () => {
    expect(
      reviewerResultSchema.parse({
        schema_version: "1",
        verdict: "pass",
        summary: "No actionable findings.",
        actionable_findings: [],
        informational_notes: [],
      }).verdict,
    ).toBe("pass");
  });

  it("rejects a pass containing actionable findings", () => {
    expect(() =>
      reviewerResultSchema.parse({
        schema_version: "1",
        verdict: "pass",
        summary: "Contradictory",
        actionable_findings: [
          {
            id: "f-1",
            severity: "high",
            title: "Bug",
            description: "Broken invariant",
            evidence: [{ detail: "Repository-wide evidence" }],
            suggested_direction: "Restore the invariant.",
          },
        ],
        informational_notes: [],
      }),
    ).toThrow(/pass.*empty/i);
  });
});
```

- [ ] **Step 4: Run the focused test and confirm RED**

Run:

```powershell
npx vitest run tests/protocol/schemas.test.ts
```

Expected: FAIL because `src/protocol/schemas.ts` does not exist.

- [ ] **Step 5: Implement the canonical Zod schemas and JSON Schema export**

In `src/protocol/schemas.ts`, define strict schemas and inferred types. Use this public vocabulary exactly:

```ts
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export const protocolVersionSchema = z.literal("1");
export const runStatusSchema = z.enum(["passed", "findings", "incomplete"]);
export const isolationPolicySchema = z.enum([
  "prefer_enforced",
  "require_enforced",
]);
export const isolationLevelSchema = z.enum([
  "enforced_read_only",
  "runtime_read_only",
  "prompt_only",
]);
export const incompleteReasonSchema = z.enum([
  "adapter_unavailable",
  "authentication_failed",
  "model_unavailable",
  "read_failure",
  "timeout",
  "process_crashed",
  "protocol_violation",
  "invalid_result",
  "cancelled",
  "unknown",
]);
```

Define `reviewRequestSchema` as `z.strictObject` with required `schema_version`, non-empty `workspace`, non-empty `instructions`, optional non-empty `request_id`, optional strict `scope_hints`, and optional `context: z.json()`.

Define finding evidence so `detail` is required while `path`, `start_line`, and `end_line` are optional; refine line ranges so both lines require `path`, both are positive integers, and `end_line >= start_line`.

Define `reviewerResultSchema` with a `superRefine` enforcing:

```ts
if (value.verdict === "pass" && value.actionable_findings.length !== 0) {
  ctx.addIssue({ code: "custom", message: "pass requires an empty actionable_findings array" });
}
if (value.verdict === "fail" && value.actionable_findings.length === 0) {
  ctx.addIssue({ code: "custom", message: "fail requires at least one actionable finding" });
}
```

Define the strict public event union for all nine MVP events. The shared envelope fields are `schema_version`, `event`, `run_id`, optional `request_id`, increasing integer `seq`, RFC 3339 `timestamp`, optional `reviewer_id`, and strict event-specific `data`.

Use these exact event payloads:

| Event | Required `data` fields |
| --- | --- |
| `run.started` | `consistency_mode: "live_worktree"` |
| `context.resolved` | `context: z.json()` |
| `suite.resolved` | `total`, ordered `reviewers[]` containing `id`, `purpose`, `adapter`, `model`, `isolation_policy`, and `instruction_sources[]` |
| `reviewer.started` | `purpose`, `adapter`, `model`, `isolation_policy` |
| `reviewer.progress` | `phase`, optional bounded `message` |
| `reviewer.heartbeat` | `phase`, `elapsed_ms`, optional `last_activity_at`, `suite` counts, optional achieved `isolation` |
| `reviewer.completed` | `adapter`, `model`, achieved `isolation`, `elapsed_ms`, validated `result` |
| `reviewer.incomplete` | `adapter`, `model`, optional achieved `isolation`, `elapsed_ms`, `reason`, bounded `message`, `retryable` |
| `run.completed` | `status`, `exit_code`, `consistency_mode`, `total_elapsed_ms`, `suite` counts, and ordered `reviewers[]` terminal records |

Define `reviewerPhaseSchema` as `queued | probing | starting | reviewing | validating | terminal`. A terminal reviewer record is a discriminated union with `status: "completed"` plus result/isolation/timing metadata, or `status: "incomplete"` plus failure/optional-isolation/timing metadata. Reuse that union inside `run.completed`; do not maintain a second terminal-result shape.

Export inferred TypeScript types with `z.infer`.

In `src/protocol/json-schema.ts`, export:

```ts
import { z } from "zod";
import { reviewerResultSchema } from "./schemas.js";

export const reviewerResultJsonSchema = z.toJSONSchema(reviewerResultSchema, {
  target: "draft-07",
});
```

- [ ] **Step 6: Run focused and static verification**

Run:

```powershell
npx vitest run tests/protocol/schemas.test.ts
npm run typecheck
npm run build
```

Expected: all commands PASS and `dist/protocol/schemas.js` exists.

- [ ] **Step 7: Commit the protocol foundation**

```powershell
git add package.json package-lock.json tsconfig.json tsconfig.test.json vitest.config.ts .gitignore .prettierignore src/protocol tests/protocol/schemas.test.ts
git commit -m "Establish Review Mesh protocol schemas"
```

---

### Task 2: Serialize monotonic JSONL events

**Files:**
- Create: `src/protocol/event-writer.ts`
- Create: `tests/protocol/event-writer.test.ts`

**Interfaces:**
- Consumes: `PublicEvent` and event data types from `src/protocol/schemas.ts`.
- Produces: `EventWriter`, `EventSink`, `EventDraft`, and `createEventWriter(options)`.

- [ ] **Step 1: Write failing concurrency and failure tests**

Create `tests/protocol/event-writer.test.ts`:

```ts
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { createEventWriter } from "../../src/protocol/event-writer.js";

describe("EventWriter", () => {
  it("serializes concurrent emissions with strictly increasing sequence numbers", async () => {
    const output = new PassThrough();
    const chunks: string[] = [];
    output.setEncoding("utf8");
    output.on("data", (chunk) => chunks.push(chunk));

    const writer = createEventWriter({
      output,
      runId: "run-1",
      requestId: "caller-1",
      now: () => new Date("2026-08-29T10:00:00.000Z"),
    });

    await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        writer.emit({
          event: "reviewer.progress",
          reviewer_id: `reviewer-${index % 3}`,
          data: { phase: "reviewing", message: `step-${index}` },
        }),
      ),
    );
    await writer.close();

    const events = chunks.join("").trim().split("\n").map(JSON.parse);
    expect(events.map((event) => event.seq)).toEqual(
      Array.from({ length: 50 }, (_, index) => index + 1),
    );
    expect(events.every((event) => event.request_id === "caller-1")).toBe(true);
  });

  it("rejects emission after close and surfaces stream errors", async () => {
    const output = new PassThrough();
    const writer = createEventWriter({ output, runId: "run-2" });
    await writer.close();
    await expect(
      writer.emit({ event: "run.started", data: { consistency_mode: "live_worktree" } }),
    ).rejects.toThrow(/closed/i);
  });
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run `npx vitest run tests/protocol/event-writer.test.ts`.

Expected: FAIL because the writer module does not exist.

- [ ] **Step 3: Implement one queued writer over `Writable`**

Define:

```ts
export type EventSink = Pick<NodeJS.WritableStream, "write" | "once">;

export interface EventWriter {
  emit(draft: EventDraft): Promise<PublicEvent>;
  close(): Promise<void>;
}
```

`createEventWriter` must:

- Keep one private promise tail and append every serialization/write operation to it.
- Increment `seq` inside the queued operation, not before queueing.
- Use `JSON.stringify(event) + "\n"` exactly.
- Await backpressure when `write()` returns false.
- Validate the fully materialized event with `publicEventSchema` before writing.
- Record the first stream error and reject all later emissions with it.
- Make `close()` wait for the current tail and prevent new emissions; it must not end `process.stdout` itself.

Use an injectable `now` defaulting to `() => new Date()` so tests do not fake global timers.

- [ ] **Step 4: Run focused verification**

Run:

```powershell
npx vitest run tests/protocol/event-writer.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit the event stream**

```powershell
git add src/protocol/event-writer.ts tests/protocol/event-writer.test.ts
git commit -m "Add ordered JSONL event streaming"
```

---

### Task 3: Resolve trusted configuration and additive repository policy

**Files:**
- Create: `src/config/schemas.ts`
- Create: `src/config/paths.ts`
- Create: `src/config/load.ts`
- Create: `src/config/resolve.ts`
- Create: `tests/config/resolve.test.ts`
- Create: `tests/helpers/fixtures.ts`

**Interfaces:**
- Consumes: isolation and protocol types from `src/protocol/schemas.ts`.
- Produces: `TrustedConfig`, `RepositoryPolicy`, `ResolvedConfig`, `ResolvedReviewer`, `AdapterRegistration`, `resolveConfig(input)`, `loadConfigFiles(input)`, and `getAppPaths()`.

- [ ] **Step 1: Write failing trust-boundary tests**

Create `tests/config/resolve.test.ts` with table-driven cases:

```ts
it("keeps baseline reviewers mandatory and appends repository instructions", () => {
  const resolved = resolveConfig({
    trusted: trustedConfig({
      reviewer_profiles: {
        security: {
          adapter: "claude-main",
          model: "claude-model",
          purpose: "Find security defects",
          instructions: "Find security bugs.",
          isolation: "prefer_enforced",
          timeout_ms: 1_800_000,
          runtime: {},
        },
      },
      reviewers: [{ id: "security-claude", profile: "security" }],
    }),
    repository: repositoryPolicy({
      reviewer_overrides: [{ id: "security-claude", append_instructions: "Check tenant isolation." }],
    }),
  });

  expect(resolved.reviewers).toHaveLength(1);
  expect(resolved.reviewers[0]?.instruction_layers).toEqual([
    { source: "trusted", content: "Find security bugs." },
    { source: "repository", content: "Check tenant isolation." },
  ]);
});

it.each([
  ["adapter", "command"],
  ["model", "different-model"],
  ["disabled", true],
])("rejects repository attempts to override baseline %s", (key, value) => {
  expect(() =>
    resolveConfig({
      trusted: trustedConfig(),
      repository: { schema_version: "1", reviewer_overrides: [{ id: "baseline", [key]: value }] },
    }),
  ).toThrow(/repository policy/i);
});

it("namespaces repository reviewer ids and forbids executable registration", () => {
  const resolved = resolveConfig({
    trusted: trustedConfig(),
    repository: repositoryPolicy({
      reviewers: [{ id: "project-security", profile: "security-profile", instructions: "Review project policy." }],
    }),
  });

  expect(resolved.reviewers.at(-1)?.id).toBe("repo:project-security");
  expect(() =>
    repositoryPolicySchema.parse({
      schema_version: "1",
      adapters: { evil: { command: "malware.exe" } },
    }),
  ).toThrow();
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run `npx vitest run tests/config/resolve.test.ts`.

Expected: FAIL because config modules and fixture builders do not exist.

- [ ] **Step 3: Define strict TOML-facing schemas**

Use snake_case fields in TOML-facing schemas. Trusted configuration must contain:

```ts
type TrustedConfig = {
  schema_version: "1";
  execution: {
    max_concurrency: number;
    heartbeat_interval_ms: number;
    shutdown_grace_period_ms: number;
  };
  diagnostics: {
    persist_runs: boolean;
    max_runs: number;
  };
  adapters: Record<string, AdapterRegistration>;
  reviewer_profiles: Record<string, ReviewerProfile>;
  reviewers: TrustedReviewerDefinition[];
};
```

`ReviewerProfile` has exact fields `{ adapter: string; model: string; purpose: string; instructions?: string; instructions_file?: string; isolation: IsolationPolicy; timeout_ms: number; runtime?: Record<string, JsonValue> }` and requires exactly one of `instructions` or `instructions_file`. `TrustedReviewerDefinition` has `{ id: string; profile: string; append_instructions?: string }`.

Resolution produces these exact core shapes:

```ts
export interface ResolvedReviewer {
  id: string;
  purpose: string;
  adapterId: string;
  adapter: AdapterRegistration;
  model: string;
  instruction_layers: Array<{
    source: "trusted" | "repository";
    content: string;
  }>;
  isolationPolicy: IsolationPolicy;
  timeoutMs: number;
  runtime: Record<string, JsonValue>;
}

export interface ResolvedConfig {
  execution: TrustedConfig["execution"];
  diagnostics: TrustedConfig["diagnostics"];
  repository_context?: JsonValue;
  reviewers: ResolvedReviewer[];
}
```

`AdapterRegistration` is a discriminated union:

- `{ type: "copilot"; env_allowlist?: string[]; use_logged_in_user?: boolean }`
- `{ type: "claude"; env_allowlist?: string[]; executable?: string }`
- `{ type: "codex"; env_allowlist?: string[]; executable?: string }`
- `{ type: "command"; command: string; args?: string[]; env_allowlist?: string[]; protocol: "review-mesh-command-v1" }`

Profiles bind trusted `adapter`, `model`, `purpose`, `instructions`, `isolation`, optional runtime options, and timeout. Baseline reviewers reference a profile and may append trusted instructions.

Repository policy contains only `schema_version`, optional `context`, additive `reviewers`, and `reviewer_overrides` with `append_instructions`, lower `timeout_ms`, and optional `require_enforced: true`. Define it as a strict schema so `command`, `args`, `env`, `adapter`, `model`, `disabled`, global execution settings, and arbitrary isolation strings are rejected.

- [ ] **Step 4: Implement platform paths and loaders**

`getAppPaths()` uses `env-paths("review-mesh", { suffix: "" })` and returns `{ configFile, reviewersDirectory, runsDirectory }`.

`loadConfigFiles({ configFile, workspace })`:

- Reads trusted TOML from the explicit path or `getAppPaths().configFile`.
- Reads optional `<workspace>/.review-mesh.toml`.
- Parses with `smol-toml` and validates with Zod.
- Resolves trusted `instructions_file` values relative to the trusted config directory only.
- Rejects instruction paths that escape that directory after `realpath`/canonicalization.
- Never writes missing defaults automatically.

- [ ] **Step 5: Implement deterministic trust-aware resolution**

`resolveConfig` must:

- Expand every trusted baseline reviewer in source order.
- Reject duplicate trusted reviewer IDs.
- Apply only additive repository instruction layers.
- Allow repository timeout only when it is lower than the trusted timeout.
- Promote `prefer_enforced` to `require_enforced` only when repository policy sets `require_enforced: true`; never permit a downgrade.
- Resolve repository reviewers through predeclared trusted profiles; repository policy cannot name an adapter or model directly.
- Namespace added IDs as `repo:<id>` and reject collisions.
- Emit instruction provenance as ordered `{ source: "trusted" | "repository", content }[]`.
- Preserve repository-level `context` as `ResolvedConfig.repository_context` so it becomes an explicit lower-priority prompt layer.
- Preserve global execution values exactly from trusted user configuration; repository policy cannot alter scheduler concurrency, heartbeat cadence, or shutdown behavior.

Implement `tests/helpers/fixtures.ts` in this task with these exported builders and deep-merge semantics for nested override objects:

```ts
export function request(overrides?: Partial<ReviewRequest>): ReviewRequest;
export function trustedConfig(overrides?: DeepPartial<TrustedConfig>): TrustedConfig;
export function repositoryPolicy(
  overrides?: DeepPartial<RepositoryPolicy>,
): RepositoryPolicy;
export function resolvedReviewer(
  overrides?: Partial<ResolvedReviewer>,
): ResolvedReviewer;
export function passResult(summary?: string): ReviewerResult;
export function failResult(id?: string): ReviewerResult;
```

Define `DeepPartial<T>` in this helper module. Default trusted configuration includes one command adapter/profile/baseline reviewer with `isolation: "prefer_enforced"`; tests override only the fields they exercise. Later tasks append builders to this same module only after their owned types exist.

- [ ] **Step 6: Run config verification**

Run:

```powershell
npx vitest run tests/config/resolve.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit trusted configuration resolution**

```powershell
git add src/config tests/config tests/helpers/fixtures.ts
git commit -m "Resolve trusted reviewer configuration"
```

---

### Task 4: Resolve bounded live-worktree context without writes

**Files:**
- Create: `src/context/git.ts`
- Create: `src/context/resolve.ts`
- Create: `tests/context/resolve.test.ts`
- Create: `tests/fixtures/git-repo.ts`

**Interfaces:**
- Consumes: `ReviewRequest`.
- Produces: `GitRunner`, `createGitRunner()`, `ResolvedContext`, and `resolveContext({ request, git })`.

`ResolvedContext` is exactly:

```ts
export interface RefResolution {
  requested: string;
  resolved: string | null;
  error?: string;
}

export interface NonGitContext {
  is_repository: false;
}

export interface GitContext {
  is_repository: true;
  root: string;
  branch: string | null;
  head: string | null;
  base?: RefResolution;
  requested_head?: RefResolution;
  merge_base: string | null;
  status_entries: string[];
  changed_files: string[];
  diff_stat: string;
  truncated: {
    status_entries: boolean;
    changed_files: boolean;
    diff_stat: boolean;
  };
}

export interface ResolvedContext {
  consistency_mode: "live_worktree";
  workspace: string;
  instructions: string;
  caller_context?: JsonValue;
  scope_hints?: ReviewRequest["scope_hints"];
  git: NonGitContext | GitContext;
}
```

- [ ] **Step 1: Write failing Git and non-Git context tests**

Create a temporary Git fixture helper that initializes a repo, configures local identity, creates commits, and modifies/stages files without touching the real workspace.

Test:

```ts
it("resolves branch, head, base, status, and diff metadata", async () => {
  const repo = await createGitFixture();
  await repo.write("src/value.ts", "export const value = 2;\n");

  const context = await resolveContext({
    request: request({
      workspace: repo.path,
      scope_hints: { base: "HEAD~1", head: "HEAD", paths: ["src"] },
    }),
    git: createGitRunner(),
  });

  expect(context.consistency_mode).toBe("live_worktree");
  expect(context.git.is_repository).toBe(true);
  if (!context.git.is_repository) throw new Error("expected a Git repository");
  expect(context.git.branch).toBeTruthy();
  expect(context.git.head).toMatch(/^[0-9a-f]{40}$/);
  expect(context.git.changed_files).toContain("src/value.ts");
});

it("returns an explicit non-git manifest instead of failing", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "review-mesh-non-git-"));
  const context = await resolveContext({ request: request({ workspace }), git: createGitRunner() });
  expect(context.git).toEqual({ is_repository: false });
});
```

Also test that an unresolved explicit base returns `{ requested: "missing-ref", resolved: null, error: "..." }` and is not silently replaced.

- [ ] **Step 2: Run the focused test and confirm RED**

Run `npx vitest run tests/context/resolve.test.ts`.

Expected: FAIL because context modules do not exist.

- [ ] **Step 3: Implement a bounded read-only Git runner**

Define:

```ts
export interface GitRunner {
  run(args: readonly string[], options: { cwd: string; signal?: AbortSignal }): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }>;
}
```

Use `execa("git", args, { cwd, reject: false, timeout: 15_000, cancelSignal: signal })`. Never invoke a shell and never accept a prejoined command string.

All output must be bounded before entering events or prompts:

- Status entries: at most 2,000.
- Changed paths: at most 10,000.
- Diff-stat text: at most 64 KiB.
- Error text: at most 8 KiB.

Record truncation booleans in the manifest.

- [ ] **Step 4: Implement deterministic context discovery**

`resolveContext` must:

- Canonicalize `workspace` with `realpath` and verify it is a directory.
- Run `git rev-parse --is-inside-work-tree`, `--show-toplevel`, `HEAD`, and `--abbrev-ref HEAD` independently.
- Resolve supplied base/head with `git rev-parse --verify <ref>^{commit}`.
- Compute merge base only when both commits resolve.
- Collect porcelain-v2 status, staged/unstaged changed paths, and diff stat using pathspecs after `--` when supplied.
- Preserve raw `instructions` as `instructions`, request `context` as `caller_context`, and `scope_hints` untouched beside discovered data.
- Never run checkout, fetch, reset, clean, add, commit, worktree, or any write-capable Git operation.

Extend `tests/helpers/fixtures.ts` with:

```ts
export function resolvedContext(
  overrides?: Partial<ResolvedContext>,
): ResolvedContext;
```

Its default is a canonical-looking non-Git live-worktree context and it must deep-merge `git` only when explicitly supplied.

- [ ] **Step 5: Verify no workspace writes**

In the test, snapshot the recursive path list and file hashes before `resolveContext`, call it, then assert the snapshot is unchanged afterward.

Run:

```powershell
npx vitest run tests/context/resolve.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit context resolution**

```powershell
git add src/context tests/context tests/fixtures/git-repo.ts
git commit -m "Resolve live worktree review context"
```

---

### Task 5: Establish adapter contracts, prompt layering, and error taxonomy

**Files:**
- Create: `src/adapters/types.ts`
- Create: `src/adapters/errors.ts`
- Create: `src/adapters/registry.ts`
- Create: `src/protocol/prompt.ts`
- Create: `tests/protocol/prompt.test.ts`
- Create: `tests/helpers/async-queue.ts`
- Create: `tests/helpers/fake-adapter.ts`

**Interfaces:**
- Consumes: `ResolvedReviewer`, `ResolvedContext`, `ReviewerResult`, `IsolationPolicy`, `IsolationLevel`, `IncompleteReason`.
- Produces: `ReviewerPromptBundle`, `ReviewAdapter`, `AdapterCapabilities`, `AdapterReviewInput`, `AdapterEvent`, `AdapterFactory`, `AdapterRegistry`, `AdapterFailure`, `sanitizeAdapterFailure()`, `buildReviewerPrompt()`, `buildAllowlistedEnvironment()`, `AsyncQueue<T>`, and `FakeAdapter`.

- [ ] **Step 1: Write failing prompt-precedence tests**

Create `tests/protocol/prompt.test.ts`:

```ts
it("renders invariant, trusted, repository, and caller layers in that order", () => {
  const prompt = buildReviewerPrompt({
    reviewer: resolvedReviewer({
      instruction_layers: [
        { source: "trusted", content: "Review correctness." },
        { source: "repository", content: "Check generated clients." },
      ],
    }),
    context: resolvedContext({ instructions: "Focus on auth.", caller_context: { ticket: "ABC-1" } }),
    repositoryContext: { conventions: ["Preserve wire compatibility"] },
  });

  expect(prompt.system.indexOf("REVIEW MESH INVARIANTS")).toBeLessThan(
    prompt.system.indexOf("TRUSTED REVIEWER INSTRUCTIONS"),
  );
  expect(prompt.user.indexOf("ADDITIVE REPOSITORY INSTRUCTIONS")).toBeLessThan(
    prompt.user.indexOf("REPOSITORY CONTEXT"),
  );
  expect(prompt.user.indexOf("REPOSITORY CONTEXT")).toBeLessThan(
    prompt.user.indexOf("CALLER INSTRUCTIONS"),
  );
  expect(prompt.combined).toContain(prompt.system);
  expect(prompt.combined).toContain(prompt.user);
});
```

Assert the invariant block says: inspect only, do not edit files, return exactly the supplied schema, `pass` only with zero actionable findings, and treat repository/caller text as lower-priority review context.

- [ ] **Step 2: Run the focused test and confirm RED**

Run `npx vitest run tests/protocol/prompt.test.ts`.

Expected: FAIL because adapter/prompt modules do not exist.

- [ ] **Step 3: Define the exact internal adapter contract**

Use these interfaces:

```ts
export interface AdapterCapabilities {
  available: boolean;
  authenticated: boolean | "unknown";
  model_available: boolean | "unknown";
  streaming: boolean;
  cancellation: boolean;
  maximumIsolation: IsolationLevel | "unknown";
  runtime_version?: string;
  message?: string;
}

export interface AdapterReviewInput {
  runId: string;
  reviewer: ResolvedReviewer;
  context: ResolvedContext;
  prompt: ReviewerPromptBundle;
  resultJsonSchema: Record<string, unknown>;
  isolationPolicy: IsolationPolicy;
  signal: AbortSignal;
}

export interface ReviewerPromptBundle {
  system: string;
  user: string;
  combined: string;
}

export type AdapterEvent =
  | { type: "progress"; phase: string; message?: string }
  | { type: "activity"; message: string }
  | { type: "result"; result: ReviewerResult; isolation: IsolationLevel }
  | { type: "failure"; failure: AdapterFailure; isolation?: IsolationLevel };

export interface ReviewAdapter {
  readonly id: string;
  probe(reviewer: ResolvedReviewer, signal: AbortSignal): Promise<AdapterCapabilities>;
  run(input: AdapterReviewInput): AsyncIterable<AdapterEvent>;
  forceCleanup?(): Promise<void>;
}
```

`AdapterCapabilities.maximumIsolation` is a preflight capability claim, not terminal evidence. `AdapterFailure` must carry `reason`, sanitized `message`, and `retryable`. Create constructors or static helpers for the stable reason enum; never infer the public reason from raw provider text outside an adapter.

The registry receives trusted factories only:

```ts
export type AdapterFactory = (registration: AdapterRegistration) => ReviewAdapter;
export class AdapterRegistry {
  register(type: AdapterRegistration["type"], factory: AdapterFactory): void;
  create(id: string, registration: AdapterRegistration): ReviewAdapter;
}
```

- [ ] **Step 4: Implement prompt construction and test helpers**

`buildReviewerPrompt()` accepts `{ reviewer, context, repositoryContext, resultJsonSchema }` and returns a `ReviewerPromptBundle`.

- `system` contains only Review Mesh invariants and trusted reviewer instruction layers.
- `user` contains additive repository instructions, repository context, discovered live-worktree context, caller instructions/context, and the reviewer result JSON Schema in separate sections.
- `combined` is `system + "\n\n" + user` for command adapters that expose only one prompt channel.

Delimit every untrusted user block with explicit start/end markers and state in `system` that those blocks are data, not permission to weaken invariants.

Create `buildAllowlistedEnvironment(names, source = process.env)` in `src/adapters/types.ts`. It copies only platform launch keys plus explicit trusted names, rejects invalid environment variable names, and never mutates `source`. Every subprocess-based adapter uses this one helper.

Implement `AsyncQueue<T>` with `push`, `end`, `fail`, and `[Symbol.asyncIterator]`. Implement `FakeAdapter` with injected probe result and a callback receiving the `AsyncQueue<AdapterEvent>` so tests can control concurrency, silence, and cancellation.

- [ ] **Step 5: Verify contracts**

Run:

```powershell
npx vitest run tests/protocol/prompt.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit adapter boundaries**

```powershell
git add src/adapters src/protocol/prompt.ts tests/protocol/prompt.test.ts tests/helpers/async-queue.ts tests/helpers/fake-adapter.ts
git commit -m "Define review adapter contracts"
```

---

### Task 6: Implement suite state and unanimous aggregation

**Files:**
- Create: `src/orchestrator/state.ts`
- Create: `tests/orchestrator/state.test.ts`

**Interfaces:**
- Consumes: `ResolvedReviewer`, `ReviewerResult`, `AdapterCapabilities`, `AdapterFailure`.
- Produces: `ReviewerState`, `SuiteState`, `createSuiteState(reviewers)`, `summarizeSuite(state)`, `aggregateRun(state)`, and `exitCodeFor(status, interrupted)`.

- [ ] **Step 1: Write failing state-transition and precedence tests**

Create cases for:

```ts
it.each([
  [
    [completedPass("a"), completedPass("b")],
    "passed",
    0,
  ],
  [
    [completedPass("a"), completedFail("b")],
    "findings",
    1,
  ],
  [
    [completedFail("a"), incomplete("b", "timeout")],
    "incomplete",
    3,
  ],
])("applies unanimous precedence", (reviewers, status, exitCode) => {
  const state = suiteState(reviewers);
  expect(aggregateRun(state).status).toBe(status);
  expect(exitCodeFor(status, false)).toBe(exitCode);
});
```

Also assert illegal transitions throw: `completed -> running`, duplicate result, and a reviewer missing from the resolved roster.

- [ ] **Step 2: Run the focused test and confirm RED**

Run `npx vitest run tests/orchestrator/state.test.ts`.

Expected: FAIL because the state module does not exist.

- [ ] **Step 3: Implement explicit reviewer lifecycle state**

Use stable statuses `queued`, `probing`, `starting`, `reviewing`, `validating`, `completed`, and `incomplete`. Store timestamps, last activity, actual isolation, capabilities, result/failure, and elapsed time.

All state changes go through methods that verify legal transitions. The aggregator must preserve resolved roster order in terminal output regardless of completion order.

`summarizeSuite` returns exact `{ total, queued, running, completed, incomplete }` counts; `running` includes probing through validating.

Extend `tests/helpers/fixtures.ts` with exact state/result helpers used by this and later tasks:

```ts
export function completedPass(id: string): ReviewerTerminalRecord;
export function completedFail(id: string): ReviewerTerminalRecord;
export function incomplete(
  id: string,
  reason: IncompleteReason,
): ReviewerTerminalRecord;
export function suiteState(
  reviewers: ReviewerTerminalRecord[],
): SuiteState;
```

- [ ] **Step 4: Verify state logic**

Run:

```powershell
npx vitest run tests/orchestrator/state.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit unanimous state aggregation**

```powershell
git add src/orchestrator/state.ts tests/orchestrator/state.test.ts
git commit -m "Aggregate unanimous review outcomes"
```

---

### Task 7: Orchestrate probes, parallel jobs, heartbeats, deadlines, and cancellation

**Files:**
- Create: `src/orchestrator/run-review.ts`
- Create: `tests/orchestrator/run-review.test.ts`

**Interfaces:**
- Consumes: `EventWriter`, `ResolvedConfig`, `ResolvedContext`, `AdapterRegistry`, adapter contracts, and state helpers.
- Produces: `runReviewRound(input): Promise<RunCompletion>`.

- [ ] **Step 1: Write failing deterministic orchestration tests**

Use fake timers and `FakeAdapter` to cover these separate tests:

1. Starts all reviewers up to `max_concurrency`, then starts queued reviewers in roster order.
2. Does not short-circuit after one finding.
3. Runs available reviewers when another probe reports unavailable.
4. Emits heartbeats during a silent reviewer without emitting percentages.
5. Converts deadline expiry to `incomplete: timeout` and aborts the adapter signal.
6. Keeps completed findings when another reviewer is incomplete.
7. On caller abort, stops queueing, aborts active jobs, marks remaining jobs cancelled, and returns exit code `4`.
8. Emits exactly one terminal event per reviewer and `run.completed` last.

Representative test:

```ts
it("waits for the full suite after actionable findings", async () => {
  const first = fakeAdapterReturning(failResult("first"), 5);
  const second = fakeAdapterReturning(passResult(), 50);
  const events: PublicEvent[] = [];

  const completion = await runReviewRound(
    roundInput({ adapters: { first, second }, onEvent: (event) => events.push(event) }),
  );

  expect(first.runCalls).toBe(1);
  expect(second.runCalls).toBe(1);
  expect(completion.status).toBe("findings");
  expect(events.at(-1)?.event).toBe("run.completed");
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run `npx vitest run tests/orchestrator/run-review.test.ts`.

Expected: FAIL because the orchestrator does not exist.

- [ ] **Step 3: Implement preflight and deterministic scheduling**

`runReviewRound` input contains `{ runId, requestId, config, context, registry, writer, signal, clock }`. The `clock` interface is `{ now(): Date; setTimeout; clearTimeout; setInterval; clearInterval }`; production uses global timers and tests use Vitest fake timers.

Define:

```ts
export interface RunCompletion {
  status: RunStatus;
  exitCode: 0 | 1 | 3 | 4;
  reviewers: ReviewerTerminalRecord[];
  totalElapsedMs: number;
}
```

Extend `tests/helpers/fixtures.ts` with:

```ts
export function fakeAdapterReturning(
  result: ReviewerResult,
  delayMs?: number,
): FakeAdapter;
export function roundInput(
  overrides?: DeepPartial<RunReviewRoundInput> & {
    adapters?: Record<string, ReviewAdapter>;
    onEvent?: (event: PublicEvent) => void;
  },
): RunReviewRoundInput;
```

`roundInput` must create an in-memory writer and register supplied adapters by the resolved reviewers' `adapterId` values; it must not bypass the real scheduler or state machine.

Algorithm:

1. Emit `run.started`.
2. Emit `context.resolved` and `suite.resolved` in resolved roster order.
3. Create each reviewer adapter exactly once, then probe all reviewer jobs concurrently with `Promise.allSettled`.
4. Mark definitive unavailable probes incomplete, but retain available jobs.
5. Feed available jobs into a small internal semaphore/worker pool; do not depend on completion-order mapping.
6. For each job, create a linked `AbortController` and deadline timer.
7. Build the prompt with `config.repository_context`, iterate adapter events, and update activity/state before emitting normalized events.
8. Require exactly one result or failure. A stream ending with neither becomes `protocol_violation`; a second terminal event also becomes `protocol_violation`.
9. Validate adapter results again with `reviewerResultSchema` before state completion.
10. If the resolved policy is `require_enforced` and a terminal event reports anything except `enforced_read_only`, replace it with `incomplete: adapter_unavailable`; the neutral orchestrator is the final policy backstop.
11. Await all jobs, aggregate, emit one self-contained `run.completed`, close the writer, and return status/exit code.

- [ ] **Step 4: Implement orchestrator-owned heartbeats**

Start one interval per active reviewer using the injected clock/timers. Every heartbeat includes phase, elapsed time, last activity, suite counts, and actual isolation once known. Clear the interval in `finally` before terminal emission.

- [ ] **Step 5: Implement cancellation cleanup**

On the parent signal:

- Do not start additional queued jobs.
- Abort every active linked controller.
- Wait up to `shutdown_grace_period_ms` for job promises.
- After the shutdown grace period, invoke `forceCleanup()` on every still-running adapter that implements it; command and SDK-specific cleanup is implemented in their adapter tasks.
- Mark all nonterminal jobs `cancelled`.
- Emit a terminal `run.completed` when the writer remains usable.

- [ ] **Step 6: Run orchestration verification**

Run:

```powershell
npx vitest run tests/orchestrator/run-review.test.ts
npm run typecheck
```

Expected: PASS with no leaked fake timers or pending promises.

- [ ] **Step 7: Commit orchestration**

```powershell
git add src/orchestrator/run-review.ts tests/orchestrator/run-review.test.ts
git commit -m "Orchestrate parallel reviewer lifecycles"
```

---

### Task 8: Implement the generic command adapter

**Files:**
- Create: `src/adapters/command.ts`
- Create: `tests/adapters/command.test.ts`
- Create: `tests/fixtures/command-adapter.mjs`

**Interfaces:**
- Consumes: `ReviewAdapter`, `AdapterRegistration`, `AdapterReviewInput`, `AdapterEvent`, and `reviewerResultSchema`.
- Produces: `createCommandAdapter(registration, dependencies)`.

- [ ] **Step 1: Create a controllable external-adapter fixture**

`tests/fixtures/command-adapter.mjs` reads one JSON object from stdin and selects behavior from `process.env.REVIEW_MESH_FIXTURE_MODE`:

- `pass`: emit progress then a clean result.
- `fail`: emit a result with one medium finding.
- `malformed`: emit non-JSON text.
- `double-terminal`: emit two results.
- `silent`: remain alive until aborted.
- `crash`: write sanitized stderr and exit `7`.
- `extra-after-terminal`: emit a result and then another event.

Each stdout line is one protocol object:

```json
{"type":"progress","phase":"reviewing","message":"fixture active"}
```

or:

```json
{"type":"result","result":{"schema_version":"1","verdict":"pass","summary":"clean","actionable_findings":[],"informational_notes":[]}}
```

- [ ] **Step 2: Write failing command-adapter contract tests**

Test pass/fail translation, exact stdin payload, minimal environment allowlist, malformed stdout, multiple terminals, output after terminal, nonzero exit, deadline abort, and no orphaned fixture process.

Assert the stdin payload contains `protocol: "review-mesh-command-v1"`, run/reviewer IDs, prompt, context, result JSON Schema, and `isolation_policy`.

- [ ] **Step 3: Run the focused test and confirm RED**

Run `npx vitest run tests/adapters/command.test.ts`.

Expected: FAIL because the command adapter does not exist.

- [ ] **Step 4: Implement subprocess launch and strict JSONL parsing**

Use `execa(registration.command, registration.args ?? [], { cwd: input.context.workspace, env, stdin: "pipe", stdout: "pipe", stderr: "pipe", reject: false, cancelSignal: input.signal })` without a shell.

Build `env` from these keys only:

- Values returned by the shared `buildAllowlistedEnvironment` helper: `PATH`, `Path`, `PATHEXT`, `SYSTEMROOT`, `WINDIR`, `COMSPEC`, `TEMP`, `TMP`, `HOME`, `USERPROFILE` when present.
- Trusted `env_allowlist` names.
- `REVIEW_MESH_PROTOCOL_VERSION`, `REVIEW_MESH_RUN_ID`, `REVIEW_MESH_REVIEWER_ID`, `REVIEW_MESH_WORKSPACE`, and `REVIEW_MESH_ISOLATION_POLICY`.

Never forward all of `process.env`.

Write one JSON request and close stdin. Parse stdout incrementally by newline with an 8 MiB total limit and 1 MiB per-line limit. Sanitize and cap stderr at 64 KiB.

Map protocol errors to `protocol_violation`, nonzero process exit without a terminal failure to `process_crashed`, and cancellation to `cancelled`.

The command protocol's optional first event may be `{ "type": "capabilities", "isolation": <IsolationLevel> }`. If it is absent, actual isolation defaults to `prompt_only`. If the reviewer policy is `require_enforced` and the command does not report `enforced_read_only`, emit `adapter_unavailable` before accepting a result.

- [ ] **Step 5: Implement Windows process-tree cleanup**

Execa's force-kill fallback is not sufficient on Windows. Store the active child on the adapter instance and implement `forceCleanup()`:

- First cancel the child normally.
- After the orchestrator grace period, if `child.pid` is still alive on Windows, run `taskkill.exe /PID <pid> /T /F` through `execa` with literal args and no shell.
- On POSIX, send `SIGKILL` only after the grace period.
- Verify the exact PID belongs to the adapter process captured at spawn; never construct a command string.

- [ ] **Step 6: Run adapter verification**

Run:

```powershell
npx vitest run tests/adapters/command.test.ts
npm run typecheck
```

Expected: PASS, including the silent-process cancellation test.

- [ ] **Step 7: Commit the extension boundary**

```powershell
git add src/adapters/command.ts tests/adapters/command.test.ts tests/fixtures/command-adapter.mjs
git commit -m "Add generic command review adapter"
```

---

### Task 9: Compose the application and machine-only CLI

**Files:**
- Create: `src/app.ts`
- Create: `src/cli.ts`
- Create: `tests/cli/review.test.ts`

**Interfaces:**
- Consumes: loaders, resolver, context discovery, registry, writer, and `runReviewRound`.
- Produces: `runReviewApplication(options): Promise<number>` and executable `review-mesh review`.

- [ ] **Step 1: Write failing CLI process tests**

Spawn the TypeScript entrypoint with `node --import tsx src/cli.ts review` and an isolated trusted config containing two command-fixture reviewers.

Test:

- Exit `0` with two clean reviewers.
- Exit `1` when one reviewer reports findings.
- Exit `2` for malformed JSON, unsupported command, empty stdin, or invalid config.
- Exit `3` when one fixture crashes.
- Every non-empty stdout line parses as `publicEventSchema`.
- Stderr may contain diagnostics but stdout never contains banners or stack traces.
- `run.completed` is the final stdout line and is sufficient to reconstruct all reviewer results.

- [ ] **Step 2: Run the focused test and confirm RED**

Run `npx vitest run tests/cli/review.test.ts`.

Expected: FAIL because the application and CLI entrypoints do not exist.

- [ ] **Step 3: Implement dependency-injected application composition**

Define:

```ts
export interface ReviewApplicationOptions {
  requestText: string;
  configFile?: string;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  signal: AbortSignal;
  adapterRegistry?: AdapterRegistry;
  runIdFactory?: () => string;
}

export async function runReviewApplication(
  options: ReviewApplicationOptions,
): Promise<number>;
```

It parses the request, loads/merges config, resolves context, creates the writer and registry, then calls `runReviewRound`. Before the run starts, invalid request/config errors are written as one concise JSON object to stderr and return `2`; they do not emit a fake `run.completed` because no valid run exists.

Use `randomUUID()` for run IDs formatted as `run_<uuid>`.

`configFile` is a dependency-injection seam for tests and embedding only; `src/cli.ts` never accepts it from argv.

- [ ] **Step 4: Implement the process entrypoint**

`src/cli.ts` must:

- Accept exactly one argument: `review`. Any flag or additional argument is invalid usage.
- Read stdin to an 8 MiB maximum; reject extra bytes rather than truncating.
- Install `SIGINT` and `SIGTERM` handlers that abort one controller exactly once.
- Set `process.exitCode` from `runReviewApplication`; never call `process.exit()` during cleanup.
- Catch uncaught application errors, write a sanitized diagnostic to stderr, and set exit `3` only after a valid run began; otherwise `2`.
- Never print help or version text to stdout in the MVP. Invalid usage goes to stderr.

Register the command adapter factory. For any configured adapter type without a registered factory, `AdapterRegistry.create()` returns an explicit unavailable adapter whose probe reports `adapter_unavailable`; it must not throw or crash the process. Tasks 11–13 replace those unavailable factories with the live first-party factories.

- [ ] **Step 5: Verify CLI behavior and compiled bin**

Run:

```powershell
npx vitest run tests/cli/review.test.ts
npm run build
node dist/cli.js review < tests/fixtures/valid-request.json
```

Create and commit `tests/fixtures/valid-request.json` in this task with `{ "schema_version": "1", "workspace": ".", "instructions": "Review the current workspace." }`. For process tests and the manual invocation, isolate the environment used by `env-paths`: set both `APPDATA` and `LOCALAPPDATA` on Windows, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, and `XDG_STATE_HOME` on Linux, or an isolated `HOME` on macOS. Place the command-fixture configuration at the resulting `envPaths("review-mesh", { suffix: "" }).config` path. Expected exit is `0`, and every stdout line is JSON.

- [ ] **Step 6: Commit the public CLI**

```powershell
git add src/app.ts src/cli.ts tests/cli/review.test.ts tests/fixtures/valid-request.json
git commit -m "Expose the Review Mesh CLI"
```

---

### Task 10: Add best-effort sanitized run persistence

**Files:**
- Create: `src/diagnostics/run-recorder.ts`
- Create: `tests/diagnostics/run-recorder.test.ts`
- Modify: `src/app.ts`
- Modify: `src/protocol/event-writer.ts`

**Interfaces:**
- Consumes: validated `PublicEvent`, resolved app paths, and diagnostics config.
- Produces: `RunRecorder`, `createRunRecorder(options)`, and an optional event-writer mirror sink.

- [ ] **Step 1: Write failing persistence and non-fatal-error tests**

Test that the recorder:

- Writes normalized JSONL to `<runsDirectory>/<runId>.jsonl`.
- Creates only directories under the supplied application-data root.
- Redacts values for keys matching `/token|secret|password|authorization|api[_-]?key/i` recursively.
- Caps individual string fields at 64 KiB and records `"[truncated]"`.
- Removes oldest run files after `max_runs` is exceeded.
- Swallows an injected disk error, reports one warning to stderr, and does not reject foreground event emission.

- [ ] **Step 2: Run the focused test and confirm RED**

Run `npx vitest run tests/diagnostics/run-recorder.test.ts`.

Expected: FAIL because the recorder does not exist.

- [ ] **Step 3: Implement a best-effort mirror**

The event writer remains authoritative for stdout. Add an optional `onEvent(event): Promise<void>` mirror called after the stdout write succeeds. Catch mirror failures, disable that mirror after the first failure, and call an injected `onWarning` without rejecting `emit`.

The recorder writes only public normalized events and a sanitized non-secret resolution header; it never writes raw SDK events or raw stderr.

- [ ] **Step 4: Wire persistence through application config**

When `diagnostics.persist_runs` is false, do not create the runs directory. When true, use `getAppPaths().runsDirectory`; tests inject a temporary directory.

- [ ] **Step 5: Verify diagnostics**

Run:

```powershell
npx vitest run tests/diagnostics/run-recorder.test.ts tests/protocol/event-writer.test.ts tests/cli/review.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit diagnostics**

```powershell
git add src/diagnostics src/app.ts src/protocol/event-writer.ts tests/diagnostics tests/protocol/event-writer.test.ts tests/cli/review.test.ts
git commit -m "Persist sanitized review run records"
```

---

### Task 11: Integrate the Codex SDK adapter

**Files:**
- Create: `src/adapters/codex.ts`
- Create: `tests/adapters/codex.test.ts`
- Modify: `src/adapters/registry.ts`

**Interfaces:**
- Consumes: `@openai/codex-sdk` `Codex`, `ThreadEvent`, `ThreadOptions`, `reviewerResultJsonSchema`, and adapter contracts.
- Produces: `createCodexAdapter(registration, dependencies)`.

- [ ] **Step 1: Reverify the pinned SDK surface**

Run:

```powershell
npm view @openai/codex-sdk@0.151.0 version engines --json
rg -n "runStreamed|outputSchema|sandboxMode|workingDirectory|approvalPolicy|configOverrides" node_modules/@openai/codex-sdk/dist/index.d.ts
```

Expected: version `0.151.0`, Node `>=18`, and all named APIs present. If the lockfile no longer installs this version, stop and update the plan rather than guessing.

- [ ] **Step 2: Write failing adapter tests against an injected SDK facade**

Do not mock ESM globals. Define a small local facade:

```ts
interface CodexSdkFacade {
  start(input: {
    threadOptions: ThreadOptions;
    systemPrompt: string;
    userPrompt: string;
    outputSchema: Record<string, unknown>;
    signal: AbortSignal;
  }): Promise<AsyncIterable<ThreadEvent>>;
}
```

Test that the adapter:

- Probes availability without making a model call.
- Starts a fresh thread with `workingDirectory`, configured `model`, `sandboxMode: "read-only"`, `approvalPolicy: "never"`, `networkAccessEnabled: false`, and `skipGitRepoCheck: true` for non-Git workspaces.
- Passes `outputSchema` to `runStreamed`.
- Translates command/tool/item events into concise progress without forwarding command output or reasoning.
- Parses the last completed `agent_message` as `ReviewerResult` after `turn.completed`.
- Maps `turn.failed` and stream `error` to typed failures.
- Aborts through the SDK `signal`.
- Reports `runtime_read_only`.
- Against a fixture containing hostile `AGENTS.md` and `.codex/config.toml`, confirms `project_doc_max_bytes: 0`, isolated `CODEX_HOME`, and disabled feature overrides prevent project instructions or project-registered tools from appearing in the SDK facade input/events.

- [ ] **Step 3: Run the focused test and confirm RED**

Run `npx vitest run tests/adapters/codex.test.ts`.

Expected: FAIL because the adapter does not exist.

- [ ] **Step 4: Implement the real Codex facade**

Before construction, create an ephemeral directory under Review Mesh application data, for example `<data>/runtime/codex/<runId>/<reviewerId>`, and set it as `CODEX_HOME` in the allowlisted environment. Remove it during adapter cleanup. Trusted configuration must therefore provide explicit noninteractive Codex authentication such as `CODEX_API_KEY`; do not copy the user's normal Codex home or cached login into the isolated runtime.

Construct `Codex` with `codexPathOverride` when configured and the isolated allowlisted `env`. Supply config overrides that disable project-controlled extensions and persistence for the review turn:

```ts
const codex = new Codex({
  codexPathOverride: registration.executable,
  env: buildAllowlistedEnvironment(registration.env_allowlist),
  config: {
    developer_instructions: prompt.system,
    project_doc_max_bytes: 0,
    features: {
      hooks: false,
      apps: false,
      multi_agent: false,
      memories: false,
    },
    history: { persistence: "none" },
  },
});
```

Use `project_doc_max_bytes: 0` as the pinned mechanism for suppressing `AGENTS.md`; do not set `model_instructions_file`. Do not load repository skills, hooks, MCP servers, apps, or `AGENTS.md` as a second instruction channel.

Add an integration-contract fixture with an `AGENTS.md` that requests a known sentinel phrase and a `.codex/config.toml` that enables a fake MCP server/hook. Run the pinned SDK against a stubbed model transport or recorded event harness and assert neither sentinel instructions nor extra tools enter the turn. If this isolation regression test fails on the pinned runtime, `probe()` must return unavailable and the adapter cannot ship as a passing reviewer until a supported project-config isolation control is added.

Call:

```ts
const thread = codex.startThread({
  model: reviewer.model,
  workingDirectory: context.workspace,
  sandboxMode: "read-only",
  approvalPolicy: "never",
  networkAccessEnabled: false,
  webSearchMode: "disabled",
  skipGitRepoCheck: context.git.is_repository !== true,
});
const { events } = await thread.runStreamed(prompt.user, {
  outputSchema: resultJsonSchema,
  signal,
});
```

Only `item.completed` with `item.type === "agent_message"` is eligible as terminal text. Ignore reasoning text. A file-change item, even failed, produces an adapter failure because a review-only run attempted mutation.

Codex always reports achieved isolation `runtime_read_only`. If `isolationPolicy === "require_enforced"`, fail preflight with `adapter_unavailable` because the SDK read-only sandbox is runtime enforcement, not an independently verified outer filesystem boundary.

- [ ] **Step 5: Verify the adapter and registry**

Run:

```powershell
npx vitest run tests/adapters/codex.test.ts
npm run typecheck
npm run build
```

Expected: PASS.

- [ ] **Step 6: Commit Codex support**

```powershell
git add src/adapters/codex.ts src/adapters/registry.ts tests/adapters/codex.test.ts
git commit -m "Add Codex review adapter"
```

---

### Task 12: Integrate the Claude Agent SDK adapter

**Files:**
- Create: `src/adapters/claude.ts`
- Create: `tests/adapters/claude.test.ts`
- Modify: `src/adapters/registry.ts`

**Interfaces:**
- Consumes: `@anthropic-ai/claude-agent-sdk` `query`, `Options`, `SDKMessage`, and adapter contracts.
- Produces: `createClaudeAdapter(registration, dependencies)`.

- [ ] **Step 1: Reverify the pinned SDK surface**

Run:

```powershell
npm view @anthropic-ai/claude-agent-sdk@0.3.251 version engines --json
rg -n "export declare function query|outputFormat|settingSources|strictMcpConfig|sandbox|permissionMode|SDKResultSuccess" node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts
```

Expected: the pinned APIs exist.

- [ ] **Step 2: Write failing tests against an injected query facade**

Define:

```ts
type ClaudeQueryFacade = (input: {
  prompt: string;
  options: ClaudeOptions;
}) => AsyncIterable<SDKMessage>;
```

Test:

- `cwd` and configured model are passed.
- `settingSources: []`, `strictMcpConfig: true`, `mcpServers: {}`, `plugins: []`, `skills: []`, and a trusted `systemPrompt` prevent secondary project instruction channels.
- `tools` are restricted to `Read`, `Glob`, `Grep`, and `Bash`; `Edit`, `Write`, `NotebookEdit`, `WebFetch`, `WebSearch`, and `Task` are disallowed.
- `permissionMode: "dontAsk"` and `canUseTool` allow read/search tools, allow Bash only when the configured sandbox is active, and deny every unknown or write-capable tool.
- `outputFormat` uses the shared JSON Schema.
- `SDKResultSuccess.structured_output` is validated as the result; missing structured output is `invalid_result`.
- result error subtypes map to timeout/unknown appropriately.
- the supplied `AbortController` is aborted on cancellation.
- `prefer_enforced` produces one sandboxed attempt and, only after an SDK execution result reports sandbox setup unavailable or unsupported, one prompt-only retry of the same logical reviewer job.
- `require_enforced` never retries unsandboxed and becomes incomplete when sandbox setup is unavailable.

- [ ] **Step 3: Run the focused test and confirm RED**

Run `npx vitest run tests/adapters/claude.test.ts`.

Expected: FAIL because the adapter does not exist.

- [ ] **Step 4: Implement sandbox-first Claude options**

First attempt every reviewer with this exact sandboxed configuration:

```ts
const options: Options = {
  cwd: context.workspace,
  model: reviewer.model,
  abortController,
  settingSources: [],
  strictMcpConfig: true,
  mcpServers: {},
  plugins: [],
  skills: [],
  tools: ["Read", "Glob", "Grep", "Bash"],
  disallowedTools: [
    "Edit",
    "Write",
    "NotebookEdit",
    "WebFetch",
    "WebSearch",
    "Task",
  ],
  permissionMode: "dontAsk",
  systemPrompt: prompt.system,
  outputFormat: { type: "json_schema", schema: resultJsonSchema },
  persistSession: false,
  env: buildAllowlistedEnvironment(registration.env_allowlist),
  sandbox: {
    enabled: true,
    failIfUnavailable: true,
    autoAllowBashIfSandboxed: true,
    allowUnsandboxedCommands: false,
    filesystem: { denyWrite: [context.workspace] },
    network: { allowedDomains: [], strictAllowlist: true },
  },
};
```

Pass `prompt.user` as the `query({ prompt })` value. The prompt-only fallback reuses the same `prompt.system` and `prompt.user` values.

Classify sandbox setup failure only from an SDK `result` with `subtype: "error_during_execution"` whose `errors` array includes both the case-insensitive token `sandbox` and at least one of `unavailable`, `unsupported`, `not supported`, `missing dependencies`, or `cannot start`. Encapsulate that exact rule in `isClaudeSandboxUnavailable(message)` and unit-test every accepted token plus near-miss API/auth errors. Do not treat arbitrary API, auth, or model errors as sandbox failures.

For `prefer_enforced`, close the first query and start one new query with the same prompt/options except `sandbox: { enabled: false }`, `tools: ["Read", "Glob", "Grep", "Bash"]`, and a `canUseTool` callback that denies every write-capable tool but allows Bash. Report this retry as achieved `prompt_only`. It is still the same Review Mesh logical reviewer job and must not emit a second `reviewer.started` event.

For `require_enforced`, return `adapter_unavailable` on the sandbox setup failure and never run the prompt-only retry. A successful sandboxed attempt reports achieved `enforced_read_only`.

The trusted `env_allowlist` must include whatever credential variable the selected Claude backend requires. Do not spread `process.env` wholesale.

- [ ] **Step 5: Translate native messages without leaking content**

Map status/tool-progress/task-progress messages to short activity summaries. Do not forward assistant chain-of-thought, raw tool inputs, file contents, or stderr. Treat `SDKResultMessage` as the terminal signal, and accept exactly one result.

- [ ] **Step 6: Verify Claude support**

Run:

```powershell
npx vitest run tests/adapters/claude.test.ts
npm run typecheck
npm run build
```

Expected: PASS.

- [ ] **Step 7: Commit Claude support**

```powershell
git add src/adapters/claude.ts src/adapters/registry.ts tests/adapters/claude.test.ts
git commit -m "Add Claude review adapter"
```

---

### Task 13: Integrate the GitHub Copilot SDK adapter

**Files:**
- Create: `src/adapters/copilot.ts`
- Create: `tests/adapters/copilot.test.ts`
- Modify: `src/adapters/registry.ts`

**Interfaces:**
- Consumes: `@github/copilot-sdk` `CopilotClient`, `CopilotSession`, `SessionConfig`, `PermissionRequest`, and adapter contracts.
- Produces: `createCopilotAdapter(registration, dependencies)`.

- [ ] **Step 1: Reverify the pinned SDK surface**

Run:

```powershell
npm view @github/copilot-sdk@1.0.11 version engines --json
rg -n "createSession|sendAndWait|availableTools|excludedTools|enableConfigDiscovery|enableOnDemandInstructionDiscovery|enableFileHooks|enableSkills|onPermissionRequest|listModels|getAuthStatus" node_modules/@github/copilot-sdk/dist/*.d.ts node_modules/@github/copilot-sdk/README.md
```

Expected: all named APIs exist. On PowerShell, if the glob is not expanded for `rg`, point `rg` at the `dist` directory instead.

- [ ] **Step 2: Write failing tests against injected client/session facades**

Define minimal facades containing `start`, `getStatus`, `getAuthStatus`, `listModels`, `createSession`, `stop`, `forceStop`, session `on`, `sendAndWait`, `abort`, and `close`.

Test:

- Probe starts the client, checks auth, and verifies configured model membership.
- Session config sets working directory/model, `streaming: true`, trusted appended system message, `enableConfigDiscovery: false`, `enableOnDemandInstructionDiscovery: false`, `enableFileHooks: false`, `enableSkills: false`, `enableSessionStore: false`, `remoteSession: "off"`, no MCP servers/plugins/instruction directories, and no host Git context injection.
- Permission handler rejects `write`, `memory`, `hook`, `mcp`, `custom-tool`, and `url`; it permits `read`; it rejects shell unless trusted profile runtime option `allow_shell_prompt_only: true` is set.
- Message/tool/session events become concise progress/activity events.
- `sendAndWait` final content is parsed as JSON and validated with `reviewerResultSchema`.
- Missing final message, permission denial that prevents completion, session error, and invalid JSON become typed failures.
- Cancellation calls `session.abort`, `session.close`, then client `stop`; timeout fallback calls `forceStop`.
- Actual isolation is `runtime_read_only` when shell/write are denied, or `prompt_only` when `allow_shell_prompt_only` is enabled.
- `require_enforced` fails preflight because this adapter does not establish an independently verified outer filesystem boundary.

- [ ] **Step 3: Run the focused test and confirm RED**

Run `npx vitest run tests/adapters/copilot.test.ts`.

Expected: FAIL because the adapter does not exist.

- [ ] **Step 4: Implement client lifecycle and preflight**

Construct one client per logical reviewer job so cancellation and cleanup are isolated. Use `mode: "empty"`, a Review Mesh application-data `baseDirectory`, `logLevel: "error"`, allowlisted environment, and `useLoggedInUser` from trusted configuration.

Probe sequence:

```ts
await client.start();
const [status, auth, models] = await Promise.all([
  client.getStatus(),
  client.getAuthStatus(),
  client.listModels(),
]);
```

Return model unavailable when the configured ID is absent. Sanitize all error text.

- [ ] **Step 5: Implement review sessions**

Use a session configuration shaped like:

```ts
const session = await client.createSession({
  model: reviewer.model,
  workingDirectory: context.workspace,
  streaming: true,
  systemMessage: { mode: "append", content: prompt.system },
  enableConfigDiscovery: false,
  enableOnDemandInstructionDiscovery: false,
  enableFileHooks: false,
  enableSkills: false,
  enableSessionStore: false,
  enableHostGitOperations: false,
  availableTools: allowShellPromptOnly
    ? ["read_file", "view_directory", "grep", "glob", "powershell", "bash"]
    : ["read_file", "view_directory", "grep", "glob"],
  excludedTools: ["edit_file", "create_file", "apply_patch"],
  mcpServers: {},
  pluginDirectories: [],
  instructionDirectories: [],
  remoteSession: "off",
  onPermissionRequest,
  onEvent,
});
```

Read `allow_shell_prompt_only` only from the trusted profile's `runtime` object and default it to `false`. With the default, expose exactly `read_file`, `view_directory`, `grep`, and `glob`, deny every permission kind other than `read`, and report `runtime_read_only`. With the option enabled, add `powershell` and `bash`, allow shell requests, continue rejecting direct write requests, and report `prompt_only`.

If `isolationPolicy === "require_enforced"`, fail preflight with `adapter_unavailable`; do not start a session. This adapter never reports `enforced_read_only` in the MVP.

Call `session.sendAndWait({ prompt: prompt.user, agentMode: "interactive" }, reviewer.timeout_ms)`. Do not use `autopilot`; read-only behavior comes from the explicit tool filter and permission handler.

- [ ] **Step 6: Verify Copilot support**

Run:

```powershell
npx vitest run tests/adapters/copilot.test.ts
npm run typecheck
npm run build
```

Expected: PASS.

- [ ] **Step 7: Commit Copilot support**

```powershell
git add src/adapters/copilot.ts src/adapters/registry.ts tests/adapters/copilot.test.ts
git commit -m "Add Copilot review adapter"
```

---

### Task 14: Document configuration and add opt-in live smoke tests

**Files:**
- Create: `README.md`
- Create: `tests/live/live-adapters.test.ts`
- Modify: `package.json`
- Modify: `tests/cli/review.test.ts`

**Interfaces:**
- Consumes: the complete public CLI and all adapter registrations.
- Produces: user-level setup documentation and `npm run test:live`.

- [ ] **Step 1: Write the README as an agent-facing contract**

Document:

- Installation and Node floor.
- One canonical stdin invocation.
- Full request example.
- Event vocabulary and exit-code table.
- Trusted config path on Windows/macOS/Linux.
- A complete `config.toml` with command, Copilot, Claude, and Codex registrations plus explicit reviewer roster.
- `.review-mesh.toml` additive examples and forbidden override examples.
- Isolation meanings and the live-worktree consistency caveat.
- Credential references by environment-variable name without embedding secrets.
- The command-adapter stdin/stdout protocol.
- Clear statement that Review Mesh does not edit code and that `prompt_only` is best-effort, not a filesystem guarantee.

Do not add human TUI instructions, reviewer-selection flags, or background-job commands.

- [ ] **Step 2: Add opt-in live smoke tests**

Create a temporary repository containing a known bug and a sentinel file hash. Gate each live test behind both `REVIEW_MESH_LIVE=1` and a per-adapter reviewer JSON environment variable:

- `REVIEW_MESH_LIVE_CODEX_REVIEWER`
- `REVIEW_MESH_LIVE_CLAUDE_REVIEWER`
- `REVIEW_MESH_LIVE_COPILOT_REVIEWER`

Each test runs one adapter, validates a terminal schema, asserts the sentinel hash and Git status are unchanged, and uses a 10-minute test timeout. Skipped tests are the default.

Add:

```json
"test:live": "vitest run tests/live --testTimeout=600000"
```

- [ ] **Step 3: Add a compiled CLI smoke test**

Extend `tests/cli/review.test.ts` to run `npm run build`, invoke `node dist/cli.js review` with command-fixture configuration, and assert exit `0`, valid JSONL, and final `passed` status.

- [ ] **Step 4: Run all offline release verification**

Run:

```powershell
npm run verify
git diff --check
git status --short
```

Expected:

- Formatting, typecheck, all offline tests, and build PASS.
- Live tests are skipped unless explicitly enabled.
- `git diff --check` reports no whitespace errors.
- Only README/test/package changes for this task remain unstaged.

- [ ] **Step 5: Optionally run available live adapters**

Only when the corresponding credentials and runtimes are already configured:

```powershell
$env:REVIEW_MESH_LIVE='1'
npm run test:live
```

Expected: configured adapter tests PASS; unavailable adapters remain explicitly skipped, not failed or silently simulated.

- [ ] **Step 6: Commit documentation and smoke coverage**

```powershell
git add README.md tests/live tests/cli/review.test.ts package.json package-lock.json
git commit -m "Document and verify Review Mesh"
```

---

### Task 15: Perform final acceptance verification

**Files:**
- Modify only files required to fix failures found by this task.

**Interfaces:**
- Consumes: the completed repository.
- Produces: verified MVP evidence against every acceptance criterion in the design spec.

- [ ] **Step 1: Start from a clean dependency install**

Run:

```powershell
npm ci
```

Expected: exact lockfile install succeeds on Node `>=22.12.0`.

- [ ] **Step 2: Run the complete offline gate**

Run:

```powershell
npm run verify
```

Expected: format check, production/test typecheck, all offline tests, and build PASS.

- [ ] **Step 3: Exercise all three process outcomes through the compiled CLI**

Using temporary trusted configs backed by the command fixture, run three requests:

1. All reviewers pass → exit `0`, final `status: "passed"`.
2. One reviewer finds an issue → exit `1`, final `status: "findings"`, all reviewers present.
3. One reviewer crashes while another reports a finding → exit `3`, final `status: "incomplete"`, completed finding retained.

For each run, parse every stdout line through `publicEventSchema` with a short `node --input-type=module` verification script. Assert sequence numbers are contiguous and `run.completed` is final.

- [ ] **Step 4: Exercise cancellation through the compiled CLI**

Start a command-fixture run with one silent reviewer, wait until `reviewer.started`, send Ctrl+C/SIGINT from the test harness, and assert:

- Exit code `4`.
- Final status `incomplete` when stdout remains available.
- Silent child PID no longer exists.
- No further stdout follows `run.completed`.

- [ ] **Step 5: Verify workspace immutability and live-worktree disclosure**

Before and after each compiled CLI run, compare recursive file hashes and Git status for the reviewed fixture. Assert unchanged files and terminal `consistency_mode: "live_worktree"`.

- [ ] **Step 6: Inspect the final diff and repository state**

Run:

```powershell
git diff --check
git status --short --branch
git log --oneline --decorate -15
```

Expected: no whitespace errors, no uncommitted files, and one focused commit per task.

- [ ] **Step 7: Record any environment-limited live evidence without weakening the gate**

If a real provider cannot be smoke-tested because credentials, subscription access, or a sandbox dependency is unavailable, report the exact skipped adapter and reason in the handoff. Do not replace the missing live evidence with a mocked success claim; offline contract tests must still pass.
