# Review Mesh Design

**Date:** 2026-08-29
**Status:** Approved for implementation planning

## 1. Summary

Review Mesh is an agent-first, CLI-first code-review gate. An invoking agent sends one review request, Review Mesh runs every reviewer in a trusted configured suite, streams factual progress as versioned JSON Lines, and returns every reviewer result.

The product is a neutral orchestration layer over established coding-agent runtimes. It does not implement model inference, repository tool loops, provider transports, or provider-specific retry systems. The initial adapters target the GitHub Copilot SDK, Claude Agent SDK, Codex SDK or CLI, and a language-neutral external command protocol.

A review round passes only when every configured reviewer completes and reports zero actionable findings. Review Mesh never edits the reviewed code. When a round reports findings, the invoking agent changes the code and starts a completely new round, which reruns the entire suite.

## 2. Goals

- Give another agent one simple command that performs a complete, mandatory review round.
- Run an explicit roster of independent reviewers across multiple agent runtimes and models.
- Stream regular, machine-readable lifecycle and progress events throughout the round.
- Return structured, evidence-backed findings separately for every reviewer.
- Require unanimous clean results: every reviewer must complete and report no actionable findings.
- Distinguish actionable review failures from infrastructure or protocol failures.
- Keep the reviewed workspace read-only where the selected runtime supports enforcement, and disclose weaker isolation honestly.
- Make additional agent runtimes integrable without adding inference behavior to the core.

## 3. Non-goals for the MVP

The MVP will not:

- Modify code, apply fixes, create commits, or manage repair iterations.
- Let an invocation select, disable, replace, or reorder mandatory reviewers.
- Fetch pull requests, check out branches, create worktrees, or otherwise prepare a repository.
- Snapshot, lock, or invalidate a changing worktree.
- Consolidate, rank, deduplicate, or reconcile findings from different reviewers.
- Pass one reviewer's output to another reviewer.
- Build a raw-inference gateway, model router, tool loop, or provider retry framework.
- Run as a background service, interactive session, or filesystem watcher.
- Invent progress percentages.

## 4. Product contract

One invocation is one complete, stateless review round:

```powershell
$reviewRequest | review-mesh review
```

Review Mesh reads one versioned JSON request from stdin, emits only versioned JSONL on stdout, waits for every configured reviewer to reach a terminal state, emits one terminal `run.completed` event, and exits.

If the code changes after a round, the invoking agent must invoke Review Mesh again. Every new invocation reruns every resolved reviewer from scratch.

### 4.1 Round classifications

- `passed`: every reviewer returned a valid `pass` result with zero actionable findings.
- `findings`: every reviewer returned a valid result, and at least one returned actionable findings.
- `incomplete`: at least one reviewer did not return a valid terminal result.

Precedence is:

```text
incomplete > findings > passed
```

Completed findings remain available when another reviewer is incomplete.

### 4.2 Exit codes

- `0`: `passed`
- `1`: `findings`
- `2`: invalid request or configuration
- `3`: reviewer or runtime failure made the round incomplete
- `4`: caller interrupted the round

Other codes are reserved for future documented protocol revisions.

## 5. Architecture

Review Mesh uses a neutral TypeScript and Node.js orchestrator with thin runtime adapters.

```text
Invoking agent
      |
      | versioned request on stdin
      v
Review Mesh CLI
      |
      +-- request validator
      +-- layered configuration resolver
      +-- workspace/context resolver
      +-- reviewer scheduler
      |     +-- Copilot adapter --> Copilot SDK
      |     +-- Claude adapter  --> Claude Agent SDK
      |     +-- Codex adapter   --> Codex SDK/CLI
      |     +-- command adapter --> arbitrary review-agent executable
      |
      +-- result validator and unanimous aggregator
      +-- serialized JSONL event writer
      v
Per-reviewer results plus terminal round result
```

The core owns:

- Request and configuration resolution.
- Read-only workspace and Git discovery.
- Mandatory reviewer-roster expansion.
- Preflight, parallel scheduling, lifecycle tracking, and cancellation.
- Normalized JSONL events and timed heartbeats.
- Structured-result validation.
- Unanimous aggregation and process exit codes.

Adapters own:

- Runtime startup and shutdown.
- Authentication and native session management.
- Provider-native repository inspection and tool loops.
- Provider-native streaming and normal retry behavior.
- Translation of native events into the internal adapter contract.
- Producing one terminal result in the common reviewer schema.

The core must not use one provider as the universal orchestration engine. Copilot, Claude, Codex, and external command agents remain genuinely independent runtimes.

## 6. End-to-end execution flow

1. Read exactly one JSON request from stdin.
2. Validate the strict request envelope while preserving raw instructions and open-ended context.
3. Load trusted user configuration and optional repository policy.
4. Resolve the mandatory baseline roster plus additive repository reviewers and instructions.
5. Resolve best-effort workspace and Git context without modifying the workspace.
6. Probe all distinct adapters or runtimes concurrently.
7. Emit the resolved context and suite.
8. Start every available reviewer independently, subject to the concurrency limit.
9. Serialize normalized reviewer activity and orchestrator heartbeats to stdout.
10. Wait for every reviewer; never short-circuit after a finding or failure.
11. Validate every terminal reviewer result.
12. Emit each complete reviewer result without consolidation or deduplication.
13. Aggregate the unanimous round classification.
14. Emit `run.completed` as the last stdout line and exit with the corresponding code.

If preflight proves that a reviewer is unavailable, the round is already destined to be `incomplete`, but Review Mesh still runs all available reviewers to return as much useful evidence as possible.

## 7. Public request protocol

The top-level request is strict. The caller's context is intentionally open-ended.

```json
{
  "schema_version": "1",
  "request_id": "optional-caller-correlation-id",
  "workspace": "F:\\Projects\\example",
  "instructions": "Review all current changes against origin/master. Focus especially on authentication and compatibility.",
  "scope_hints": {
    "base": "origin/master",
    "head": "HEAD",
    "branch": "feature/auth",
    "paths": ["src/auth"],
    "staged": false
  },
  "context": {
    "task": "Add OAuth refresh-token rotation",
    "constraints": ["Preserve existing clients"],
    "pull_request": 123,
    "any_future_or_custom_field": "allowed here"
  }
}
```

### 7.1 Request rules

- `schema_version`, `workspace`, and `instructions` are required.
- `request_id` is optional and is echoed in every event when supplied.
- `workspace` identifies a caller-prepared local directory. Review Mesh never checks out or fetches code for the caller.
- `instructions` are preserved verbatim and sent to every reviewer beneath trusted system and reviewer instructions.
- `scope_hints` supplies optional structured Git or path hints; it is not a closed review-target enum.
- `context` accepts arbitrary JSON and is forwarded as caller-supplied context.
- Unknown fields outside documented extension containers are rejected for schema-version safety.
- The request cannot select, skip, disable, replace, reorder, or weaken reviewers.
- Invocation data is untrusted. It cannot register commands, credentials, adapters, or increased privileges.

## 8. Workspace and context resolution

Review Mesh performs thin deterministic discovery so every reviewer receives the same starting manifest. It may use read-only operations such as canonical path resolution, `git status`, reference resolution, `git merge-base`, and diff metadata inspection.

The context manifest contains what can be determined safely:

- Canonical workspace path.
- Whether the workspace is a Git repository.
- Current branch and HEAD when available.
- Caller-supplied and resolved base/head references.
- Working-tree and staged-state summaries.
- Changed-file and diff-stat metadata.
- Caller focus paths.
- Raw caller instructions and arbitrary caller context.

Failure to resolve an optional hint is represented explicitly; Review Mesh does not silently substitute a different review scope. Reviewers may inspect the live repository further through their native runtimes.

### 8.1 Live-worktree consistency

Review Mesh intentionally does not snapshot, fingerprint-gate, lock, or invalidate a changing workspace. Reviewers may observe different states if files change while a round runs.

The context and terminal events report:

```json
{
  "consistency_mode": "live_worktree"
}
```

Initial Git provenance is informational, not a guarantee that every reviewer saw an identical immutable tree.

## 9. Layered configuration and trust

### 9.1 User-level trusted configuration

User configuration lives in the platform-appropriate application-data directory. A conceptual layout is:

```text
review-mesh/
+-- config.toml
+-- reviewers/
|   +-- correctness.md
|   +-- security.md
|   +-- architecture.md
+-- runs/
```

The trusted configuration defines:

- Adapter and runtime registrations.
- Mandatory baseline reviewer roster.
- Models and runtime options.
- Reviewer instruction files.
- Concurrency, heartbeat, timeout, and cancellation defaults.
- Isolation preferences.
- Diagnostic and retention policy.

Secrets are referenced through environment-variable names, SDK-native login state, operating-system credential facilities, or external credential helpers. Plain secret values must not appear in reviewer definitions, repository policy, normalized events, or persisted sanitized run records.

### 9.2 Repository policy

An optional `.review-mesh.toml` is treated as untrusted declarative input. It may:

- Add project-specific reviewers using adapters or commands already registered in trusted user configuration.
- Append project-specific review instructions.
- Add repository context and conventions.
- Tighten execution timeouts or isolation requirements.

It may not:

- Remove, disable, replace, reorder, or rename baseline reviewers.
- Change a baseline reviewer's adapter, model, or trusted instructions.
- Weaken isolation or increase privileges.
- Register an executable, adapter, credential, secret, or arbitrary environment variable.
- Override trusted system instructions.

Instruction precedence is:

```text
Review Mesh invariant instructions
  > trusted baseline reviewer instructions
  > additive repository instructions
  > caller instructions and context
```

Lower-priority text may add focus but cannot negate higher-priority requirements. Conflicting duplicate IDs or forbidden overrides make configuration invalid and produce exit code `2`.

## 10. Reviewer roster

Every reviewer is a concrete configuration entry rather than a runtime selected by the invoker.

```toml
[[reviewers]]
id = "security-claude"
purpose = "Find exploitable security and trust-boundary defects"
adapter = "claude"
model = "configured-model-name"
instructions_file = "reviewers/security.md"
isolation = "prefer_enforced"
timeout = "30m"
```

A resolved reviewer contains:

- Stable unique ID.
- Purpose.
- Adapter and model.
- Trusted and additive instructions with provenance.
- Runtime options and execution deadline.
- Requested isolation policy.

Every resolved entry is attempted exactly once as a logical reviewer job per invocation. An entry that cannot start still reaches an explicit `incomplete` terminal state. Deliberate redundancy is valid: multiple reviewers may cover the same role with different models, instructions, or runtimes. Provider-native retries inside that one logical job do not create additional Review Mesh reviewer runs.

Repository-added reviewers receive namespaced IDs in the resolved roster so they cannot collide with or impersonate trusted baseline entries.

## 11. Adapter contract

The conceptual TypeScript boundary is:

```ts
interface ReviewAdapter {
  probe(config: ReviewerConfig): Promise<AdapterCapabilities>;

  run(input: AdapterReviewInput): AsyncIterable<AdapterEvent>;
}
```

`probe` reports discoverable readiness and capabilities, including:

- Runtime availability and compatible version.
- Authentication readiness.
- Model availability when the runtime exposes it.
- Streaming and cancellation support.
- Isolation level that can actually be established.

`run` receives:

- The resolved context manifest.
- Live workspace path.
- Review Mesh invariants.
- Trusted reviewer instructions.
- Additive repository instructions.
- Raw invocation instructions and context.
- Model and runtime settings.
- The required terminal-result schema.
- Cancellation signal and execution deadline.

It yields internal normalized events for progress, activity, terminal result, or typed operational failure.

The initial first-party adapters are:

- GitHub Copilot SDK.
- Claude Agent SDK.
- Codex SDK or non-interactive Codex CLI.
- Generic external command adapter.

Current non-normative implementation references are the [GitHub Copilot SDK documentation](https://docs.github.com/en/copilot/how-tos/copilot-sdk), [Copilot streaming-event documentation](https://docs.github.com/en/copilot/how-tos/copilot-sdk/features/streaming-events), [Claude Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview), [Claude Agent SDK permissions](https://code.claude.com/docs/en/agent-sdk/permissions), and [Codex SDK documentation](https://learn.chatgpt.com/docs/codex-sdk). Exact SDK APIs are adapter details and must be reverified during implementation; they are not part of Review Mesh's public contract.

An adapter may be in-process or implemented as a managed subprocess. That is private implementation detail and cannot alter the public protocol.

## 12. Generic command-adapter protocol

The command adapter integrates an existing code-review agent, not a raw inference endpoint.

Only trusted user configuration may register its executable, arguments, working-directory policy, or allowed environment-variable names. Repository policy and invocation input cannot select an arbitrary executable.

The child process receives one versioned JSON object on stdin containing its reviewer definition and review input. It emits protocol JSONL on stdout and must terminate with exactly one terminal result or operational-error event.

Review Mesh supplies non-secret protocol metadata through a minimal environment allowlist, such as:

- Protocol version.
- Run ID.
- Reviewer ID.
- Workspace path.
- Requested isolation level.

Credentials are supplied only through explicitly trusted configuration or the child runtime's native credential mechanism. Review Mesh must not forward its complete environment wholesale.

Protocol violations include malformed JSONL, unexpected stdout text, multiple terminal results, output after a terminal event, a missing terminal event, or a result that fails schema validation. A violation makes that reviewer incomplete.

## 13. Reviewer result schema

A completed reviewer returns a strict versioned result:

```json
{
  "schema_version": "1",
  "verdict": "fail",
  "summary": "Two actionable correctness defects were found.",
  "actionable_findings": [
    {
      "id": "local-stable-id",
      "severity": "high",
      "title": "Refresh token can be reused after rotation",
      "description": "The previous token remains valid after a successful exchange.",
      "evidence": [
        {
          "path": "src/auth/refresh.ts",
          "start_line": 81,
          "end_line": 96,
          "detail": "The old token record is read but never revoked."
        }
      ],
      "suggested_direction": "Atomically revoke the consumed token during rotation."
    }
  ],
  "informational_notes": [
    {
      "title": "Test coverage is otherwise comprehensive",
      "description": "Expiry and malformed-token cases are covered."
    }
  ]
}
```

Rules:

- `verdict` is exactly `pass` or `fail`.
- `pass` requires an empty `actionable_findings` array.
- `fail` requires at least one actionable finding.
- Severity is `critical`, `high`, `medium`, or `low`.
- A finding includes file and line evidence when applicable.
- Repository-wide or architectural findings may use descriptive evidence without a line range.
- Informational notes never fail a reviewer.
- The reviewer-local finding ID only needs to be unique within that reviewer result.
- Review Mesh does not infer a verdict from prose or reinterpret, remove, merge, rank, or deduplicate valid findings.
- Missing, malformed, contradictory, or unparseable terminal output makes the reviewer operationally incomplete.

The published `reviewer.completed` event enriches the validated result with orchestrator-owned metadata such as reviewer ID, adapter, model, elapsed time, and achieved isolation. That metadata is not trusted from model output.

## 14. Read-only behavior and isolation disclosure

Every reviewer receives explicit review-only instructions that prohibit modifying the repository. Adapters also request native read-only tools, permissions, or sandboxing wherever their runtimes support them.

Actual isolation is reported as one of:

- `enforced_read_only`: an outer process or filesystem boundary prevents repository writes.
- `runtime_read_only`: the agent runtime enforces read-only permissions or tool policy.
- `prompt_only`: no reliable enforcement is available; compliance relies on instructions.

Prompt-only reviewers are allowed to run and can pass. Review Mesh must never describe them as hard-isolated.

The Review Mesh core does not intentionally write under the reviewed workspace. It may write configuration, bounded diagnostics, and run records only under its application-data directory. Adapter installation, provider caches, or external runtime behavior outside Review Mesh's direct control must be disclosed through the reported isolation level and documentation rather than represented as an absolute no-write guarantee.

## 15. Public JSONL event protocol

Stdout is reserved exclusively for complete JSON objects separated by newlines. No banner, spinner, color escape, debug log, stack trace, or human-oriented prose may appear there.

Every event uses the stable envelope:

```json
{
  "schema_version": "1",
  "event": "reviewer.heartbeat",
  "run_id": "run_01K...",
  "request_id": "optional-caller-correlation-id",
  "seq": 14,
  "timestamp": "2026-08-29T10:30:15.120Z",
  "reviewer_id": "security-claude",
  "data": {}
}
```

Envelope fields:

- `schema_version`: public protocol version.
- `event`: stable event name.
- `run_id`: Review Mesh-generated identifier.
- `request_id`: optional caller identifier, echoed unchanged.
- `seq`: unique, globally increasing integer within the run.
- `timestamp`: UTC RFC 3339 timestamp.
- `reviewer_id`: present for reviewer-scoped events.
- `data`: event-specific payload.

MVP event types are:

- `run.started`
- `context.resolved`
- `suite.resolved`
- `reviewer.started`
- `reviewer.progress`
- `reviewer.heartbeat`
- `reviewer.completed`
- `reviewer.incomplete`
- `run.completed`

Provider-native event types are not exposed as the public contract. Adapters translate useful activity into the normalized vocabulary. Native payloads and chain-of-thought are never copied wholesale into stdout.

### 15.1 Ordering

- One event writer serializes all stdout writes.
- `seq` is strictly increasing and never duplicated.
- Per-reviewer event order is preserved.
- Events from different reviewers may interleave.
- `run.completed` is always the final stdout event.
- Nothing is emitted to stdout after `run.completed`.

### 15.2 Progress and heartbeats

Progress is factual, not estimated. Provider activity may update the reviewer's current phase or latest activity, but Review Mesh never manufactures a percentage.

The orchestrator emits heartbeats on a configurable interval even when a runtime is silent:

```json
{
  "event": "reviewer.heartbeat",
  "data": {
    "phase": "reviewing",
    "elapsed_ms": 42000,
    "last_activity_at": "2026-08-29T10:29:57.000Z",
    "suite": {
      "total": 6,
      "queued": 0,
      "running": 4,
      "completed": 2,
      "incomplete": 0
    },
    "isolation": "runtime_read_only"
  }
}
```

The initial stable phases are `queued`, `probing`, `starting`, `reviewing`, `validating`, and `terminal`.

### 15.3 Terminal event

`run.completed` is self-contained. It includes:

- `status`: `passed`, `findings`, or `incomplete`.
- Consistency mode.
- Suite counts.
- Every completed reviewer's full validated result.
- Every incomplete reviewer's typed operational failure.
- Adapter, model, isolation, and timing metadata per reviewer.
- Total elapsed time.

An invoking agent can determine the complete outcome from the final line alone, while earlier events provide liveness and incremental observability.

## 16. Scheduling and lifecycle

### 16.1 Preflight

Review Mesh validates input, resolves configuration and context, and probes distinct runtimes concurrently. A preflight failure for one reviewer does not suppress useful work by other reviewers.

### 16.2 Parallel execution

All available reviewers run independently with a configurable concurrency limit:

```toml
[execution]
max_concurrency = 8
heartbeat_interval = "10s"
shutdown_grace_period = "5s"
```

If the roster exceeds the limit, reviewers wait in a deterministic queue ordered by the resolved configuration. Every resolved reviewer still reaches a terminal `completed` or `incomplete` state.

Reviewers never receive another reviewer's findings or messages in the MVP.

### 16.3 Deadlines and failures

Each reviewer has an execution deadline. Review Mesh does not add a provider retry engine. Native SDK retry behavior may operate normally inside an adapter; if the adapter still cannot produce a result before its deadline, the reviewer becomes incomplete.

Stable incomplete reasons are:

- `adapter_unavailable`
- `authentication_failed`
- `model_unavailable`
- `read_failure`
- `timeout`
- `process_crashed`
- `protocol_violation`
- `invalid_result`
- `cancelled`
- `unknown`

The public event carries a concise sanitized message and a `retryable` hint. It does not expose credentials, unrestricted native payloads, or sensitive stack traces.

### 16.4 Cancellation

On an interruption signal, Review Mesh:

1. Stops scheduling queued reviewers.
2. Requests cancellation from active adapters.
3. Waits for the configured shutdown grace period.
4. Terminates managed child adapter processes that do not exit.
5. Marks unfinished reviewers `cancelled`.
6. Emits `run.completed` with `status: "incomplete"` when stdout remains usable.
7. Exits with code `4`.

The normal cancellation path must not leave managed child processes orphaned.

## 17. Diagnostics and persistence

The foreground JSONL stream is authoritative. Callers do not need stderr or persisted files to determine an outcome.

Review Mesh may emit concise diagnostics to stderr and may persist a bounded sanitized run record under its application-data directory containing:

- Normalized events.
- Resolved non-secret configuration and instruction provenance.
- Reviewer timing and adapter diagnostics.
- Terminal results.

Persistence is best-effort. A persistence failure cannot turn an otherwise valid foreground review into an incomplete run.

Provider-native traces are opt-in, sanitized where practical, and covered by configurable count, age, and size retention limits. Documentation must warn that source code or provider content may still be sensitive.

## 18. Security boundaries

- The reviewed repository, repository policy, and invocation are untrusted inputs.
- Only trusted user configuration may register executables, adapter packages, credential sources, or privileged environment values.
- Paths from untrusted input are canonicalized before policy checks.
- Repository policy cannot weaken baseline instructions or isolation.
- Child processes receive an allowlisted environment rather than the full parent environment.
- Public events are schema-generated and sanitized; provider payloads are not blindly forwarded.
- Result metadata such as adapter, model, isolation, timing, and reviewer ID is added by the orchestrator, not trusted from model output.
- Read-only enforcement is capability-dependent and always reported accurately.

## 19. Testing strategy

### 19.1 Schema and policy unit tests

- Request validation and protocol-version handling.
- Preservation of raw instructions and arbitrary `context` JSON.
- Scope-hint resolution and explicit unresolved states.
- Layered configuration merge rules.
- Baseline reviewer protection and instruction precedence.
- Rejection of repository-defined executables, secrets, or privilege increases.
- Reviewer-result invariants.
- Round-status and exit-code precedence.

### 19.2 Deterministic orchestration tests

Use fake adapters with controlled event timing to verify:

- Every configured reviewer runs exactly once.
- Parallel dispatch and deterministic queueing under concurrency limits.
- No short-circuit after findings or operational failure.
- Globally strict `seq` ordering under concurrent emissions.
- Per-reviewer event order.
- Timed heartbeats during silent reviewers.
- Deadline behavior.
- Cancellation and child cleanup.
- Retention of completed findings when another reviewer is incomplete.
- `run.completed` is final and self-contained.

### 19.3 Adapter contract tests

- Recorded or fake native SDK event streams.
- Native-to-normalized event translation.
- Authentication, runtime, model, and capability probing.
- Structured-result enforcement and contradictory-verdict rejection.
- Accurate isolation reporting.
- Generic command malformed output, extra stdout, multiple terminal results, crash, timeout, and cleanup behavior.
- Secret-redaction fixtures.

### 19.4 Filesystem-boundary tests

- Core context resolution performs no writes under the workspace.
- Enforced and runtime read-only modes prevent intentional fixture modification where the platform supports them.
- Prompt-only mode is reported as prompt-only.
- Application-data persistence remains outside the reviewed workspace.

### 19.5 Opt-in live smoke tests

Against a minimal repository fixture, run Copilot, Claude, and Codex adapters only when their runtimes and credentials are available. Live tests are never required for the ordinary offline test suite.

The smoke tests verify successful startup, progress translation, terminal schema compliance, cancellation where supported, and lack of intentional workspace modification.

## 20. MVP acceptance criteria

The MVP is acceptable when all of the following are demonstrated:

- A single `review-mesh review` invocation consumes one JSON request from stdin.
- Every entry in the complete resolved reviewer roster is attempted as one logical job without caller-side reviewer selection; entries that cannot start become explicitly incomplete.
- Every available reviewer begins independently and all reviewers are awaited.
- Factual JSONL progress and heartbeats continue throughout long reviews.
- Concurrent output always remains valid, ordered JSONL.
- Every completed reviewer conforms to the shared result schema.
- A round cannot pass without a valid clean result from every reviewer.
- Findings and operational incompleteness produce distinct terminal statuses and exit codes.
- The final event contains every result and failure without synthesis or deduplication.
- The core does not write into the reviewed workspace.
- The achieved isolation level is disclosed for every reviewer, including `prompt_only`.
- A second invocation after a code change reruns the entire suite from scratch.

## 21. Deferred evolution

The architecture leaves room for later, separately designed features:

- Finding deduplication and semantic clustering.
- Cross-review synthesis or an adversarial consolidation phase.
- Background runs and `status`, `watch`, or `result` commands.
- PR metadata adapters and repository preparation integrations.
- Immutable snapshots or pinned-revision reviews.
- Persistent comparison across review rounds.
- Review-suite presets or policy-controlled quorum modes.
- A daemon or remote orchestration service.

None of these are required by, or should complicate, the first implementation.

## 22. Implementation boundary

The implementation plan should produce the smallest vertical slice that proves the public contract before integrating every live SDK:

1. CLI request/event schemas and serialized event writer.
2. Trusted configuration, additive repository policy, and context resolver.
3. Scheduler and fake adapters proving unanimous aggregation, heartbeats, cancellation, and exits.
4. Generic command adapter.
5. Copilot, Claude, and Codex first-party adapters behind the same contract.
6. Optional sanitized persistence and live smoke tests.

This sequencing proves Review Mesh's unique value—the review orchestration contract—without turning provider integration details into the architecture.
