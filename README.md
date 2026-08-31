# Review Mesh

Review Mesh is an agent-first, CLI-first review gate. It runs every reviewer in a trusted multi-runtime suite, streams versioned JSON Lines, and passes only when every reviewer completes with no actionable findings.

Review Mesh inspects code only. It does not edit the workspace, apply fixes, fetch branches, select reviewers for the caller, or manage repair loops.

## Requirements and installation

- Node.js 22.12 or newer
- Git for repository context discovery
- Credentials or logged-in state required by each configured runtime

Install from a checkout:

```powershell
npm ci
npm run build
npm link
```

The executable is `review-mesh`; the only MVP operation is `review`.

## Invocation

Send exactly one JSON request on stdin. Stdout contains protocol JSONL only; diagnostics are written to stderr.

```powershell
$request = @{
  schema_version = "1"
  request_id = "change-1042"
  workspace = "C:\Projects\example"
  instructions = "Review all current changes against origin/master. Focus on authentication and compatibility."
  scope_hints = @{
    base = "origin/master"
    head = "HEAD"
    paths = @("src/auth")
    staged = $false
  }
  context = @{
    task = "Add refresh-token rotation"
    constraints = @("Preserve existing clients")
  }
} | ConvertTo-Json -Depth 10

$request | review-mesh review
```

Required request fields are `schema_version`, `workspace`, and `instructions`. The optional `context` value may contain arbitrary JSON. Unknown top-level fields are rejected. Invocation data cannot register, remove, reorder, or weaken reviewers.

## Output protocol

Every non-empty stdout line is a schema-version `1` JSON object. Events use one run ID and strictly increasing sequence numbers. `run.completed` is always the last event of a successfully established run.

| Event                 | Meaning                                                        |
| --------------------- | -------------------------------------------------------------- |
| `run.started`         | A live-worktree review round began.                            |
| `context.resolved`    | Canonical workspace and best-effort Git context were resolved. |
| `suite.resolved`      | The mandatory reviewer roster was resolved.                    |
| `reviewer.started`    | One reviewer job started.                                      |
| `reviewer.progress`   | A factual phase or activity update.                            |
| `reviewer.heartbeat`  | Timed liveness and suite-state update.                         |
| `reviewer.completed`  | One valid reviewer result.                                     |
| `reviewer.incomplete` | One reviewer failed to produce a valid terminal result.        |
| `run.completed`       | Final classification and all reviewer terminal records.        |

Final classifications use this precedence: `incomplete` over `findings` over `passed`.

| Exit | Meaning                                                      |
| ---: | ------------------------------------------------------------ |
|  `0` | Every reviewer passed with zero actionable findings.         |
|  `1` | All reviewers completed, and at least one reported findings. |
|  `2` | Request, command usage, or configuration was invalid.        |
|  `3` | A reviewer/runtime failure made the round incomplete.        |
|  `4` | The caller interrupted the round.                            |

## Trusted configuration

The default `config.toml` location is supplied by the operating system through `env-paths`:

- Windows: `%APPDATA%\review-mesh\Config\config.toml`
- macOS: `~/Library/Preferences/review-mesh/config.toml`
- Linux: `$XDG_CONFIG_HOME/review-mesh/config.toml`, normally `~/.config/review-mesh/config.toml`

This file is trusted. It defines executable registrations, credential environment names, profiles, and the mandatory baseline roster. Keep secret values in the environment or the runtime's native credential store; configuration contains names such as `ANTHROPIC_API_KEY`, never the secret itself.

```toml
schema_version = "1"

[execution]
max_concurrency = 4
heartbeat_interval_ms = 15000
shutdown_grace_period_ms = 5000

[diagnostics]
persist_runs = true
max_runs = 50

[adapters.local_command]
type = "command"
command = "python"
args = ["C:/review-agents/security-review.py"]
env_allowlist = ["SECURITY_REVIEW_TOKEN"]
protocol = "review-mesh-command-v1"

[adapters.copilot]
type = "copilot"
env_allowlist = ["GH_TOKEN"]
use_logged_in_user = true

[adapters.claude]
type = "claude"
env_allowlist = ["ANTHROPIC_API_KEY"]
# executable = "C:/tools/claude.exe"

[adapters.codex]
type = "codex"
env_allowlist = ["CODEX_API_KEY"]
# executable = "C:/tools/codex.exe"

[reviewer_profiles.command_security]
adapter = "local_command"
model = "configured-by-command"
purpose = "Find exploitable security defects"
instructions = "Inspect trust boundaries and report only actionable defects."
isolation = "prefer_enforced"
timeout_ms = 900000

[reviewer_profiles.copilot_correctness]
adapter = "copilot"
model = "gpt-5"
purpose = "Find correctness and compatibility defects"
instructions = "Review behavior, edge cases, tests, and compatibility."
isolation = "prefer_enforced"
timeout_ms = 900000

[reviewer_profiles.claude_architecture]
adapter = "claude"
model = "claude-sonnet-4-5"
purpose = "Find architecture and maintainability defects"
instructions = "Inspect architecture, lifecycle ownership, and regressions."
isolation = "prefer_enforced"
timeout_ms = 900000

[reviewer_profiles.codex_correctness]
adapter = "codex"
model = "gpt-5-codex"
purpose = "Find implementation defects"
instructions = "Inspect the full change and return evidence-backed findings."
isolation = "prefer_enforced"
timeout_ms = 900000

[[reviewers]]
id = "security-command"
profile = "command_security"

[[reviewers]]
id = "correctness-copilot"
profile = "copilot_correctness"

[[reviewers]]
id = "architecture-claude"
profile = "claude_architecture"

[[reviewers]]
id = "correctness-codex"
profile = "codex_correctness"
```

The pinned Codex runtime currently fails Review Mesh's project-configuration isolation characterization, so its production adapter deliberately reports unavailable rather than claiming a clean review. The offline contract remains covered for a future runtime that satisfies the boundary.

## Repository policy

A workspace may contain `.review-mesh.toml`. It is untrusted, additive policy: it can append instructions, lower timeouts, require stronger isolation, or add reviewers based on profiles already registered in trusted configuration.

```toml
schema_version = "1"
context = { service = "payments", conventions = ["No floating-point money"] }

[[reviewer_overrides]]
id = "security-command"
append_instructions = "Check payment amount validation and audit logging."
timeout_ms = 600000
require_enforced = true

[[reviewers]]
id = "payments-compatibility"
profile = "copilot_correctness"
instructions = "Focus on backwards compatibility for stored payment records."
timeout_ms = 600000
```

Repository policy cannot register an executable or adapter, provide credentials, change a baseline model/profile, increase privileges or timeout, remove reviewers, or weaken isolation. Such configuration is rejected instead of partially applied.

## Isolation and consistency

- `enforced_read_only`: an independently enforced filesystem boundary was established.
- `runtime_read_only`: the runtime exposes only read-oriented tools and denies write permission, but no independent outer filesystem boundary was verified.
- `prompt_only`: behavior relies on prompt/tool policy and is best-effort, not a filesystem guarantee.

Each result reports the isolation actually achieved. `require_enforced` fails closed when the adapter cannot establish `enforced_read_only`.

Review Mesh reports `consistency_mode: "live_worktree"`. It does not snapshot, lock, fingerprint-gate, or invalidate a workspace that changes during a round; concurrent reviewers can observe different live states. The core itself uses bounded read-only discovery and never intentionally writes under the reviewed workspace.

Copilot's trusted `runtime.allow_shell_prompt_only = true` option adds shell inspection and therefore reports `prompt_only`. It is off by default. Claude may use a narrowly classified prompt-only fallback if its sandbox is specifically unavailable. Codex does not claim availability until its isolation characterization passes.

## Command adapter protocol

Only trusted configuration may register the command, literal arguments, environment-variable allowlist, and protocol version. Review Mesh sends one JSON object on child stdin containing the reviewer definition and review input. Protocol metadata such as run, reviewer, workspace, and isolation identifiers is passed through a minimal environment; the parent environment is not forwarded wholesale.

Child stdout is JSONL. It may emit non-terminal events:

```json
{"type":"progress","phase":"reviewing","message":"Inspecting changed files"}
{"type":"activity","message":"Completed dependency analysis"}
{"type":"capabilities","isolation":"enforced_read_only"}
```

It must then emit exactly one terminal event:

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

Malformed JSON, unexpected stdout text, oversized output, a missing or duplicate terminal, output after terminal, or an invalid result makes that reviewer incomplete. On deadline or interruption, Review Mesh aborts the job, waits the configured grace period, and escalates managed process cleanup.

## Verification

```powershell
npm run verify
```

Provider smoke tests are opt-in and never replace the offline gate. Define `REVIEW_MESH_LIVE=1` and the corresponding reviewer JSON environment variable, then run `npm run test:live`:

- `REVIEW_MESH_LIVE_CODEX_REVIEWER`
- `REVIEW_MESH_LIVE_CLAUDE_REVIEWER`
- `REVIEW_MESH_LIVE_COPILOT_REVIEWER`

Each value is a JSON object whose `adapter` field contains the trusted adapter registration, alongside `model`, `purpose`, `instructions`, `isolation`, `timeout_ms`, and optional `runtime`. For example:

```powershell
$env:REVIEW_MESH_LIVE_COPILOT_REVIEWER = @{
  adapter = @{ type = "copilot"; use_logged_in_user = $true }
  model = "gpt-5"
  purpose = "Live correctness smoke"
  instructions = "Review the controlled fixture without editing it."
  isolation = "prefer_enforced"
  timeout_ms = 600000
} | ConvertTo-Json -Compress -Depth 5
```

Unconfigured live adapters are explicitly skipped.
