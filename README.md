# Review Mesh

Review Mesh is an agent-first code-review gate. One command runs every reviewer in a trusted suite, streams machine-readable JSONL progress, and succeeds only when every reviewer completes with zero actionable findings.

```text
request on stdin -> review-mesh review -> all configured reviewers -> JSONL result
```

It is designed for automation, coding agents, CI, and local review loops:

- One stateless review round per invocation.
- Mandatory reviewer roster; callers cannot skip or replace reviewers.
- Parallel independent reviews across different models or runtimes.
- Strict structured findings with evidence and optional file/line locations.
- `incomplete > findings > passed` outcome precedence.
- No source edits by Review Mesh.
- A portable build consisting of one movable JavaScript file.

## Quick start

Requirements:

- Node.js 22.12 or newer.
- Git, when Git context is desired.
- A trusted `config.toml` and any provider credentials it references.

Build the single-file CLI:

```powershell
npm ci
npm run build
```

The only runtime artifact is:

```text
dist/review-mesh.mjs
```

Copy it anywhere and invoke it with Node:

```powershell
Copy-Item .\dist\review-mesh.mjs C:\Tools\review-mesh.mjs
node C:\Tools\review-mesh.mjs review
```

On macOS or Linux, the generated file has a shebang and executable bit:

```bash
cp dist/review-mesh.mjs ~/bin/review-mesh
review-mesh review
```

Portable means the application is one file and does not need this repository or `node_modules`. Configuration, credentials, Node, Git, and any separately configured command/runtime executables remain external.

## Run a review

Review Mesh reads exactly one JSON request from stdin. Stdout is JSONL protocol output only; diagnostics use stderr.

PowerShell:

```powershell
$request = @{
  schema_version = "1"
  request_id = "auth-change-1042"
  workspace = "C:\Projects\example"
  instructions = "Review the current workspace. Focus on authentication, compatibility, and error handling."
  scope_hints = @{
    base = "origin/main"
    head = "HEAD"
    paths = @("src/auth", "tests/auth")
    staged = $false
  }
  context = @{
    task = "Add refresh-token rotation"
    constraints = @("Preserve existing clients")
  }
} | ConvertTo-Json -Depth 10 -Compress

$request | node C:\Tools\review-mesh.mjs review
$LASTEXITCODE
```

Bash:

```bash
cat <<'JSON' | node ./review-mesh.mjs review
{
  "schema_version": "1",
  "request_id": "auth-change-1042",
  "workspace": "/work/example",
  "instructions": "Review the current workspace for actionable defects.",
  "scope_hints": {
    "base": "origin/main",
    "head": "HEAD",
    "paths": ["src/auth"]
  },
  "context": {
    "task": "Add refresh-token rotation"
  }
}
JSON
```

Required request fields:

| Field            | Meaning                                          |
| ---------------- | ------------------------------------------------ |
| `schema_version` | Must be the string `"1"`.                        |
| `workspace`      | Existing local directory prepared by the caller. |
| `instructions`   | Review focus sent to every mandatory reviewer.   |

`request_id`, `scope_hints`, and arbitrary JSON `context` are optional. Scope hints enrich the common starting manifest; reviewers inspect the current workspace state available when their adapter starts. They do not make Review Mesh fetch refs, check out code, or snapshot a Git patch. In particular, deleted/base-only file contents are not supplied automatically. The embedded `openai_compatible` adapter creates one bounded private in-memory read-only file snapshot per reviewer so all of that reviewer's tool calls see the same validated bytes.

## Five-model OpenAI-compatible setup

The built-in `openai_compatible` adapter works with an OpenAI Chat Completions-compatible gateway. It is fully embedded in `review-mesh.mjs`, so no external reviewer script is needed.

Set credentials in environment variables, not TOML.

PowerShell, current session:

```powershell
$env:REVIEW_MESH_OPENAI_BASE_URL = "https://gateway.example/v1"
$env:REVIEW_MESH_OPENAI_API_KEY = "your-key"
```

Persist for future Windows sessions:

```powershell
[Environment]::SetEnvironmentVariable(
  "REVIEW_MESH_OPENAI_BASE_URL",
  "https://gateway.example/v1",
  "User"
)
[Environment]::SetEnvironmentVariable(
  "REVIEW_MESH_OPENAI_API_KEY",
  "your-key",
  "User"
)
```

Bash:

```bash
export REVIEW_MESH_OPENAI_BASE_URL="https://gateway.example/v1"
export REVIEW_MESH_OPENAI_API_KEY="your-key"
```

Create the trusted configuration shown below, replacing model IDs as needed:

```toml
schema_version = "1"

[execution]
max_concurrency = 2
heartbeat_interval_ms = 15000
shutdown_grace_period_ms = 5000

[diagnostics]
persist_runs = true
max_runs = 50

[adapters.gateway]
type = "openai_compatible"
base_url_env = "REVIEW_MESH_OPENAI_BASE_URL"
api_key_env = "REVIEW_MESH_OPENAI_API_KEY"

[reviewer_profiles.opus]
adapter = "gateway"
model = "claude-opus-5"
purpose = "Architecture, security, and lifecycle review"
instructions = "Inspect architecture, lifecycle ownership, trust boundaries, security, and regressions. Report only actionable evidence-backed defects."
isolation = "prefer_enforced"
timeout_ms = 1800000

[reviewer_profiles.gemini]
adapter = "gateway"
model = "gemini-3.7-flash"
purpose = "Correctness, reliability, and edge-case review"
instructions = "Inspect the full scope for actionable correctness, integration, and test-coverage defects. Cite precise file and line evidence."
isolation = "prefer_enforced"
timeout_ms = 900000

[reviewer_profiles.mai]
adapter = "gateway"
model = "mai-code-1.1-flash"
purpose = "Implementation quality and regression review"
instructions = "Inspect implementation bugs, state handling, schemas, error paths, and missing regressions. Report only actionable findings."
isolation = "prefer_enforced"
timeout_ms = 900000

[reviewer_profiles.sol]
adapter = "gateway"
model = "gpt-5.6-sol-fast"
purpose = "Implementation, protocol, and compatibility review"
instructions = "Inspect concurrency, cancellation, protocol invariants, error handling, compatibility, and tests. Report only actionable findings."
isolation = "prefer_enforced"
timeout_ms = 900000

[reviewer_profiles.kimi]
adapter = "gateway"
model = "kimi-k3"
purpose = "Independent systems and robustness review"
instructions = "Inspect systems design, robustness, maintainability, portability, and boundary validation. Report only actionable findings."
isolation = "prefer_enforced"
timeout_ms = 900000

[[reviewers]]
id = "opus-5"
profile = "opus"

[[reviewers]]
id = "gemini-3-7-flash"
profile = "gemini"

[[reviewers]]
id = "mai-code-1-1-flash"
profile = "mai"

[[reviewers]]
id = "sol-5-6-fast"
profile = "sol"

[[reviewers]]
id = "kimi-k3"
profile = "kimi"
```

The gateway adapter exposes exactly three bounded reviewer tools:

- `list_files`
- `read_file`
- `search_text`

It excludes `.git`, `.git-recovered`, `.worktrees`, `node_modules`, `dist`, `coverage`, and `.review-mesh-runs`; rejects path traversal and symlink escapes; caps file, search, output, turn, and request sizes; and reports `runtime_read_only`.

Reviewer models cannot execute shell commands, programs, scripts, Git, builds, tests, web tools, or code, and cannot write files. Review Mesh core separately runs a bounded allowlist of read-only Git discovery commands with optional locks, hooks, fsmonitor, external diff, text conversion, pagers, and interactive prompting disabled to construct the shared context manifest.

## Configuration location

The trusted config file is resolved using the host operating system:

| Platform | Default path                                            |
| -------- | ------------------------------------------------------- |
| Windows  | `%APPDATA%\review-mesh\Config\config.toml`              |
| macOS    | `~/Library/Preferences/review-mesh/config.toml`         |
| Linux    | `${XDG_CONFIG_HOME:-~/.config}/review-mesh/config.toml` |

The trusted config controls:

- Adapter/runtime registrations.
- Credential environment-variable names.
- Reviewer profiles and exact models.
- Mandatory baseline roster and order.
- Concurrency, heartbeat, shutdown grace, diagnostics, and retention.

Never place secret values in `config.toml`. Only reference environment-variable names.

## Other adapters

Review Mesh also implements these trusted adapter types:

| Type                | Purpose                                                                          | Portable-file note                                                                                                                               |
| ------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `openai_compatible` | Embedded OpenAI-compatible agent loop with bounded read-only tools.              | Fully self-contained.                                                                                                                            |
| `command`           | Integrates a separately installed review agent using the command JSONL protocol. | External executable remains required.                                                                                                            |
| `copilot`           | GitHub Copilot SDK reviewer.                                                     | Requires its separately installed runtime/package environment. Default profile is read/search only.                                              |
| `claude`            | Claude Agent SDK reviewer.                                                       | Requires its native runtime and compatible endpoint/authentication. Reviewer tools are `Read`, `Glob`, and `Grep` only.                          |
| `codex`             | Codex SDK reviewer.                                                              | Currently fails closed in production because the pinned runtime does not satisfy Review Mesh's project-configuration isolation characterization. |

For a truly one-file deployment, use `openai_compatible`. Provider-native adapters can remain configured in a source installation, but their native runtime assets cannot be encoded into a cross-platform JavaScript file.

## Repository policy

A reviewed workspace may contain `.review-mesh.toml`. It is untrusted and additive only.

```toml
schema_version = "1"
context = { service = "payments", conventions = ["No floating-point money"] }

[[reviewer_overrides]]
id = "opus-5"
append_instructions = "Check payment amount validation and audit logging."
timeout_ms = 600000

[[reviewers]]
id = "payments-compatibility"
profile = "sol"
instructions = "Focus on backwards compatibility for stored payment records."
timeout_ms = 600000
```

Repository policy may:

- Add instructions to baseline reviewers.
- Lower timeouts.
- Promote isolation to `require_enforced`.
- Add reviewers using profiles already defined by trusted configuration.
- Add repository context.

It cannot register executables/adapters, supply credentials, remove or reorder baseline reviewers, replace their model/profile, increase timeout or privilege, or weaken isolation. Invalid policy rejects the invocation with exit code `2`.

## JSONL events

Every non-empty stdout line is one strict schema-version `1` JSON object. All events in a run share one `run_id`; `seq` starts at `1` and increases monotonically; `run.completed` is final once a valid run begins and stdout remains available.

| Event                 | Meaning                                                   |
| --------------------- | --------------------------------------------------------- |
| `run.started`         | The live-worktree review began.                           |
| `context.resolved`    | Workspace and best-effort Git metadata were resolved.     |
| `suite.resolved`      | The mandatory roster was resolved.                        |
| `reviewer.started`    | One reviewer job began.                                   |
| `reviewer.progress`   | Factual phase/activity progress.                          |
| `reviewer.heartbeat`  | Liveness, elapsed time, and suite summary.                |
| `reviewer.completed`  | One strict reviewer result.                               |
| `reviewer.incomplete` | One reviewer failed to return a valid terminal result.    |
| `run.completed`       | Final classification plus every reviewer terminal record. |

Example final event:

```json
{
  "schema_version": "1",
  "event": "run.completed",
  "run_id": "run_...",
  "seq": 23,
  "timestamp": "2026-08-31T11:45:35.446Z",
  "data": {
    "status": "findings",
    "exit_code": 1,
    "consistency_mode": "live_worktree",
    "total_elapsed_ms": 26895,
    "suite": {
      "total": 1,
      "queued": 0,
      "running": 0,
      "completed": 1,
      "incomplete": 0
    },
    "reviewers": [
      {
        "reviewer_id": "correctness",
        "status": "completed",
        "adapter": "gateway",
        "model": "example-model",
        "isolation": "runtime_read_only",
        "elapsed_ms": 26880,
        "result": {
          "schema_version": "1",
          "verdict": "fail",
          "summary": "One actionable defect was found.",
          "actionable_findings": [
            {
              "id": "zero-count",
              "severity": "high",
              "title": "Zero count is not rejected",
              "description": "The implementation violates the documented contract.",
              "evidence": [
                {
                  "path": "calculator.js",
                  "start_line": 1,
                  "end_line": 3,
                  "detail": "The function divides without validating count."
                }
              ],
              "suggested_direction": "Reject zero before division and add tests."
            }
          ],
          "informational_notes": []
        }
      }
    ]
  }
}
```

## Exit codes

| Code | Classification | Meaning                                                         |
| ---: | -------------- | --------------------------------------------------------------- |
|  `0` | `passed`       | Every reviewer completed and reported zero actionable findings. |
|  `1` | `findings`     | Every reviewer completed; one or more reported findings.        |
|  `2` | no run         | Invalid request, usage, trusted config, or repository policy.   |
|  `3` | `incomplete`   | At least one reviewer/runtime did not return a valid result.    |
|  `4` | interrupted    | Caller interrupted the round.                                   |

Completed findings are retained even when another reviewer is incomplete.

## Reviewer result shape

Each completed reviewer returns:

```json
{
  "schema_version": "1",
  "verdict": "fail",
  "summary": "One actionable defect was found.",
  "actionable_findings": [
    {
      "id": "zero-count",
      "severity": "high",
      "title": "Zero count is not rejected",
      "description": "The implementation violates the documented contract.",
      "evidence": [
        {
          "path": "calculator.js",
          "start_line": 1,
          "end_line": 3,
          "detail": "The function divides without validating count."
        }
      ],
      "suggested_direction": "Reject zero before division and add tests."
    }
  ],
  "informational_notes": []
}
```

`pass` requires an empty `actionable_findings` array. `fail` requires at least one finding.

## Isolation and consistency

- `enforced_read_only`: an independent filesystem boundary was established.
- `runtime_read_only`: only read-oriented runtime tools were exposed, but no independent outer filesystem boundary was verified.
- `prompt_only`: behavior depends on prompt/runtime policy and is not a filesystem guarantee.

`require_enforced` fails closed unless the adapter can actually report `enforced_read_only`.

All rounds report `consistency_mode: "live_worktree"`. Review Mesh does not lock or invalidate a changing workspace, and concurrent reviewers can observe different states if another process modifies files during the round. The embedded `openai_compatible` adapter is the exception within an individual reviewer: it retains bounded, descriptor-validated text files in a private in-memory snapshot before serving any file/search tool result, then clears that snapshot when the reviewer ends. This is a reviewer-local safety and consistency measure, not a Git ref or whole-round snapshot.

Run-record persistence similarly uses exclusive active/final names, pinned directory identity checks, and post-publication file-identity verification. These checks fail closed on detected replacement, but `runtime_read_only` is not a hostile-filesystem security boundary: portable Node does not expose directory-relative mutation primitives on every supported platform. Keep the application-data directory private to the Review Mesh user and do not grant untrusted processes rename or write access to it.

## Command-adapter protocol

Only trusted config can register a command. Review Mesh sends one JSON request object on child stdin. Child stdout must contain JSONL only.

Non-terminal examples:

```json
{"type":"capabilities","isolation":"enforced_read_only"}
{"type":"progress","phase":"reviewing","message":"Inspecting files"}
{"type":"activity","message":"Completed dependency analysis"}
```

Exactly one terminal is required:

```json
{
  "type": "result",
  "result": {
    "schema_version": "1",
    "verdict": "pass",
    "summary": "No actionable findings.",
    "actionable_findings": [],
    "informational_notes": []
  }
}
```

or:

```json
{
  "type": "failure",
  "failure": {
    "reason": "process_crashed",
    "message": "The reviewer runtime failed.",
    "retryable": true
  }
}
```

Malformed/oversized output, multiple terminals, output after terminal, missing terminal, and invalid result schemas make the reviewer incomplete.

## Development and verification

```powershell
npm ci
npm run verify
```

Useful scripts:

| Script                   | Purpose                                           |
| ------------------------ | ------------------------------------------------- |
| `npm run build`          | Type-check and generate the one-file CLI.         |
| `npm run build:portable` | Generate only `dist/review-mesh.mjs`.             |
| `npm test`               | Run offline tests.                                |
| `npm run test:live`      | Run explicitly configured provider smoke tests.   |
| `npm run format:check`   | Check formatting.                                 |
| `npm run verify`         | Formatting, typecheck, tests, and portable build. |

The portable acceptance suite copies `review-mesh.mjs` outside the repository and runs it without `node_modules`, including a real embedded-adapter protocol round against a local test server.
