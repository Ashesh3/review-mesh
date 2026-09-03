# Review Mesh

Review Mesh is an agent-first code-review gate. One command runs every logical
agent in a trusted suite, streams machine-readable JSONL progress, and succeeds
with independent gate and coverage outcomes. Operational failures advance to
eligible fallback providers; a logical lens is incomplete only after recovery
options are exhausted.

Transient failures use bounded same-model retry, while protocol, provider,
timeout, and schema failures can immediately fail over. Public output is compact
JSONL with one aggregate suite heartbeat; detailed context and results remain in
the sanitized persisted artifact.

```text
current directory or request JSON -> review-mesh review -> trusted project/default roster -> live JSONL -> run.completed
```

It is designed for automation, coding agents, CI, and local review loops:

- One stateless review round per invocation.
- Trusted global/default or project-specific agent rosters; callers cannot override them through review input.
- Parallel logical agents with ordered per-agent model fallback across runtimes.
- Strict structured findings with evidence and optional file/line locations.
- Independent `gate_outcome` and `coverage_outcome` dimensions.
- Configurable diverse pass quorum, provider concurrency, and circuit breaking.
- Changed-surface applicability and required-input checks before provider work.
- Deterministic finding consolidation with confidence, classification, assumptions, and provenance.
- No source edits by Review Mesh.
- Portable single-file builds: a Node.js script and standalone Windows/Linux executables.

## Quick start

Requirements:

- Node.js 22.12 or newer.
- Git, when Git context is desired.
- A trusted `config.toml` and any provider credentials it references.

The CLI is self-describing. An AI agent can start with these commands and does
not need this README to discover the contract:

```text
review-mesh --help
review-mesh describe . --json
review-mesh schema request --json
review-mesh doctor . --adapter gateway --model claude-opus-5 --structured-output
review-mesh review . --output-mode compact-jsonl --no-ansi --heartbeat aggregate --details-file review-details.jsonl
review-mesh config --help
```

`review-mesh describe . --json` is the recommended first call. It resolves the
configuration for the current workspace and reports the selected project or
default roster, ordered agents, adapter types, exact models, optional effort,
isolation policies, timeouts, concurrency, heartbeat interval, config revision,
and whether referenced credential environment variables are present. It never
prints credential values, instruction bodies, project context, or runtime
options.

The selection object includes `project_name` and `project_name_source`, plus
`matched_project_name` when a configured project entry matched. This makes the
automatic identity decision inspectable before a review starts.

For an AI caller, identity and scope are separate:

- `project_name` selects no path. Copy it from `describe`; Review Mesh verifies
  it against the workspace's Git-derived identity before using project settings.
- `workspace` is the local worktree or clone to inspect.
- `review_scope.mode = "changes"` is the default and reviews committed changes
  above the merge base plus staged, unstaged, and untracked work.
- `review_scope.branch`, `base`, and `head` are optional assertions/overrides.
  If supplied, branch/head must match the checked-out worktree.
- `review_scope.mode = "full"` is required for an intentional whole-codebase
  review. It is never inferred from an ordinary branch/worktree request.

### Download a standalone executable

Release `v6.1.0` provides operational multi-provider fallback, project-name
configuration, per-reviewer gateway session affinity, the agent-first CLI,
public event protocol v5, compact reporting, and
self-contained Bun executables that do not require Node.js or Bun:

- Windows x64: `review-mesh-windows-x64.exe`
- Linux x64 (glibc): `review-mesh-linux-x64`

Windows PowerShell:

```powershell
Invoke-WebRequest https://github.com/Ashesh3/review-mesh/releases/download/v6.1.0/review-mesh-windows-x64.exe -OutFile review-mesh.exe
.\review-mesh.exe review
```

Linux:

```bash
curl -LO https://github.com/Ashesh3/review-mesh/releases/download/v6.1.0/review-mesh-linux-x64
chmod +x ./review-mesh-linux-x64
./review-mesh-linux-x64 review
```

Each executable contains Review Mesh and its JavaScript dependencies. Git, trusted configuration, credentials, and separately configured command/provider runtimes remain external.

Release binaries are built with Bun 1.4.0. Verify downloads against `SHA256SUMS.txt` from the release assets.

### Build the portable Node.js file

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

The simplest invocation reviews the current directory with a built-in,
evidence-focused instruction:

```powershell
review-mesh review
```

You can also name a workspace without constructing JSON:

```powershell
review-mesh review C:\Projects\example
```

When stdin is a terminal or redirected stdin is empty/whitespace, Review Mesh
synthesizes the request. To customize instructions, scope hints, context, or a
request ID, send exactly one JSON request on stdin instead. Do not combine a
positional workspace with piped JSON. Review stdout remains JSONL protocol
output only; diagnostics use stderr.

PowerShell:

```powershell
$request = @{
  schema_version = "2"
  request_id = "auth-change-1042"
  project_name = "example"
  workspace = "C:\Projects\example"
  instructions = "Review the current workspace. Focus on authentication, compatibility, and error handling."
  review_scope = @{
    mode = "changes"
    base = "origin/main"
    head = "HEAD"
    branch = "feature/refresh-token-rotation"
    paths = @("src/auth", "tests/auth")
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
  "schema_version": "2",
  "request_id": "auth-change-1042",
  "project_name": "example",
  "workspace": "/work/example",
  "instructions": "Review the current workspace for actionable defects.",
  "review_scope": {
    "mode": "changes",
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
| `schema_version` | Must be the string `"2"`.                        |
| `project_name`   | Exact project identity copied from `describe`.   |
| `workspace`      | Existing local directory prepared by the caller. |
| `instructions`   | Review focus sent to every mandatory reviewer.   |
| `review_scope`   | Explicit `changes` or `full` scope object.       |

`request_id` and arbitrary JSON `context` are optional. In `changes` mode,
`base`, `head`, `branch`, and `paths` are optional. Review Mesh infers the base
from the remote/default `main` or `master` branch and uses checked-out `HEAD`
when omitted. It computes the merge base, collects the committed diff from that
point to `HEAD`, and adds staged, unstaged, and untracked paths. `paths` narrows
the scope; it never broadens it. Review Mesh does not fetch refs or check out a
branch. If an explicit branch/head does not match the current worktree, the run
is rejected before reviewers start. Agents should generate v2 requests from the
embedded schema.

Review agents receive a trusted invariant telling them to treat the supplied
diff and `changed_files` as the authoritative primary scope, inspect unchanged
files only to understand the effects of those changes, and omit unrelated
pre-existing issues. Only `review_scope = { mode = "full" }` authorizes a full
codebase audit.

## Five-model OpenAI-compatible setup

The built-in `openai_compatible` adapter works with an OpenAI Chat Completions-compatible gateway. It is fully embedded in `review-mesh.mjs`, so no external reviewer script is needed. Each concrete reviewer execution sends one opaque random `X-Client-Session-Id` across all of its inspection, tool-result, finalization, and repair requests. Gateways such as copilot-api can use that stable per-reviewer affinity key to keep a conversation on one account while distributing independent reviewers across eligible accounts.

Repository inspection is checkpointed before structured result production. If
finalization or its bounded repair fails transiently, the adapter retries from
the retained immutable conversation instead of repeating repository tools and
inspection. Permanent failures stop immediately, and every finalization cycle
remains bounded by the reviewer deadline.

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

Create the global configuration shown below, replacing model IDs and project names as needed:

```toml
schema_version = "5"

[execution]
max_concurrency = 2
heartbeat_interval_ms = 15000
shutdown_grace_period_ms = 5000
distribute_primaries = true
default_provider_concurrency = 2
circuit_breaker_threshold = 2
retry_attempts = 2
retry_backoff_ms = 1000

[execution.provider_limits]
anthropic = 2
github-copilot = 3

[diagnostics]
persist_runs = true
max_runs = 50

[adapters.gateway]
type = "openai_compatible"
base_url_env = "REVIEW_MESH_OPENAI_BASE_URL"
api_key_env = "REVIEW_MESH_OPENAI_API_KEY"

[agents.opus-5]
adapter = "gateway"
model = "claude-opus-5"
effort = "max"
purpose = "Architecture, security, and lifecycle review"
instructions = "Inspect architecture, lifecycle ownership, trust boundaries, security, and regressions. Report only actionable evidence-backed defects."
isolation = "prefer_enforced"
timeout_ms = 1800000

[agents.gemini-3-7-flash]
adapter = "gateway"
model = "gemini-3.7-flash"
effort = "high"
purpose = "Correctness, reliability, and edge-case review"
instructions = "Inspect the full scope for actionable correctness, integration, and test-coverage defects. Cite precise file and line evidence."
isolation = "prefer_enforced"
timeout_ms = 900000

[agents.mai-code-1-1-flash]
adapter = "gateway"
model = "mai-code-1.1-flash"
effort = "medium"
purpose = "Implementation quality and regression review"
instructions = "Inspect implementation bugs, state handling, schemas, error paths, and missing regressions. Report only actionable findings."
isolation = "prefer_enforced"
timeout_ms = 900000

[agents.sol-5-6-fast]
adapter = "gateway"
model = "gpt-5.6-sol-fast"
effort = "high"
purpose = "Implementation, protocol, and compatibility review"
instructions = "Inspect concurrency, cancellation, protocol invariants, error handling, compatibility, and tests. Report only actionable findings."
isolation = "prefer_enforced"
timeout_ms = 900000

[agents.kimi-k3]
adapter = "gateway"
model = "kimi-k3"
effort = "high"
purpose = "Independent systems and robustness review"
instructions = "Inspect systems design, robustness, maintainability, portability, and boundary validation. Report only actionable findings."
isolation = "prefer_enforced"
timeout_ms = 900000

[defaults]
agents = ["opus-5", "gemini-3-7-flash", "mai-code-1-1-flash", "sol-5-6-fast", "kimi-k3"]

[projects.payments]
agents = ["opus-5", "sol-5-6-fast"]
instructions = "Focus on monetary correctness, audit logging, and stored-record compatibility."
context = { service = "payments", conventions = ["No floating-point money"] }

[projects.frontend]
agents = ["gemini-3-7-flash", "mai-code-1-1-flash", "kimi-k3"]
instructions = "Focus on browser compatibility, accessibility, and state-management regressions."
```

## Run one agent through multiple models

An agent can keep one purpose and instruction set while configuring several
ordered model fallbacks. Use `model_runs` instead of the scalar `model` and
`effort` fields:

```toml
schema_version = "5"

[adapters.gateway]
type = "openai_compatible"
base_url_env = "REVIEW_MESH_OPENAI_BASE_URL"
api_key_env = "REVIEW_MESH_OPENAI_API_KEY"

[adapters.github]
type = "copilot"
use_logged_in_user = true

[agents.architecture]
adapter = "gateway"
model_runs = [
  { id = "opus", model = "claude-opus-5", effort = "max", provider_group = "anthropic" },
  { id = "grok", adapter = "github", model = "grok-code-fast-1", effort = "high", provider_group = "github-copilot" },
]
pass_quorum = 2
minimum_provider_groups = 2
adjudication = "required"
gate_minimum_severity = "medium"
gate_minimum_confidence = "medium"
purpose = "Architecture and security review"
instructions = "Review architecture, trust boundaries, lifecycle ownership, and regressions."
isolation = "prefer_enforced"
timeout_ms = 1800000

[agents.architecture.applicability]
any_changed_paths = ["src/**", "tests/**", "package.json"]

# A metadata-dependent lens can additionally declare:
# required_context = ["/pull_request/number", "/work_items"]

[defaults]
agents = ["architecture"]
```

The parent `adapter` is required and is inherited by a run that omits its own
`adapter`. A per-run adapter override lets one logical agent span providers.
Each run has an explicit stable ID, exact model, optional effort, optional
per-attempt timeout, and a public `provider_group` used for diversity/concurrency
policy. Run IDs
use letters, numbers, underscores, and hyphens and must be unique within the
agent.

Review Mesh expands that example into the concrete reviewer IDs
`architecture::opus` and `architecture::grok`. With
`execution.distribute_primaries = true` (the v5 default), successive
multi-model logical lenses rotate their starting run deterministically while
retaining the configured order cyclically. Configured `a, b, c` chains begin as
`a, b, c`, then `b, c, a`, then `c, a, b`; scalar lenses do not consume a
rotation slot. Set the option to `false` to keep every chain in declaration
order. Migrated v1-v4 configurations are pinned to `false`, so upgrading does
not silently change their primary model.

The effective roster reports execution-order `model_index` and original
`configured_model_index`; the persisted private run resolution keeps the same
ordering detail. Compact public JSONL exposes the distribution policy and lens
counts without repeating model identities. Existing single-model agents retain
their original unqualified reviewer IDs and remain fully supported.

The runs form an ordered recovery chain. Review Mesh starts every logical agent
in parallel (subject to `execution.max_concurrency`) using only that agent's
effective primary model. A later model becomes eligible while the pass quorum is
unsatisfied or after an operational failure. A finding
stops that agent immediately and reports all later models as `skipped` with
`short_circuited_after_finding` unless adjudication is configured. Operational
incompleteness advances to the next eligible provider. Other agents continue independently through their own
chains. This preserves broad parallel review while avoiding unnecessary model
calls once an agent has already found something actionable.

Every model that actually runs receives the same purpose, trusted instructions,
isolation policy, runtime options, project guidance, and per-run timeout.
Review Mesh preserves raw findings and builds a deterministic consolidated set
with provenance, duplicate ids, reconciled severity, confidence, classification,
and external assumptions. Each fallback
is a complete provider request, so agents that repeatedly pass can still consume
additional tokens, quota, and cost. Concurrent logical agents can also observe
different live-worktree states if another process modifies the workspace.

The gateway adapter exposes exactly three bounded reviewer tools:

- `list_files`
- `read_file`
- `search_text`

It excludes `.git`, `.git-recovered`, `.worktrees`, `node_modules`, `dist`, `coverage`, and `.review-mesh-runs`; rejects path traversal and symlink escapes; caps file, search, output, turn, and request sizes; and reports `runtime_read_only`.

Reviewer models cannot execute shell commands, programs, scripts, Git, builds, tests, web tools, or code, and cannot write files. Review Mesh core separately runs a bounded allowlist of read-only Git discovery commands with optional locks, hooks, fsmonitor, external diff, text conversion, pagers, and interactive prompting disabled to construct the shared context manifest.

`effort` is optional on a single-model agent or on each `model_runs` entry.
Review Mesh forwards it as the native reasoning-effort setting for the Copilot,
Claude, Codex, and OpenAI-compatible adapters. Command adapters receive
`REVIEW_MESH_MODEL` and, when configured, `REVIEW_MESH_REASONING_EFFORT`
plus `REVIEW_MESH_PROJECT_NAME` and `REVIEW_MESH_REVIEW_SCOPE`. Supported values are `none`,
`minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`, and `persistent`;
each provider/model may support only a subset.

## GitHub Copilot login and models

Review Mesh can sign in with GitHub Copilot, discover the exact model catalog available to that account, and use any selectable model in independently configured agents.

```powershell
review-mesh config copilot login
review-mesh config copilot status
review-mesh config copilot models
```

Use `--device-code` for a device-code login or `--web-flow` to force the local browser flow. GitHub Enterprise Cloud with data residency can be selected with `--host`:

```powershell
review-mesh config copilot login --device-code
review-mesh config copilot login --host https://example.ghe.com
review-mesh config copilot models --json
```

The login credential is managed by the GitHub Copilot runtime under Review Mesh application data; it is never written to `config.toml`. The runtime may also authenticate through supported environment variables or GitHub CLI credentials. `review-mesh config copilot models` reports account-specific model IDs and their supported effort levels.

Configure one or more Copilot agents with scalar model and effort choices, or
use `model_runs` as shown above to reuse one agent's instructions across several
Copilot or mixed-provider models:

```toml
[adapters.github]
type = "copilot"
use_logged_in_user = true

[agents.copilot-architecture]
adapter = "github"
model = "claude-opus-5"
effort = "max"
purpose = "Architecture and security review"
instructions = "Review architecture, security boundaries, lifecycle ownership, and regressions."
isolation = "prefer_enforced"
timeout_ms = 1800000

[agents.copilot-correctness]
adapter = "github"
model = "gpt-5.6-sol"
effort = "high"
purpose = "Correctness and reliability review"
instructions = "Review correctness, error paths, concurrency, compatibility, and tests."
isolation = "prefer_enforced"
timeout_ms = 900000

[defaults]
agents = ["copilot-architecture", "copilot-correctness"]
```

The interactive `review-mesh config` menu performs the same login check and
model discovery while adding or editing a scalar or multi-model agent, then
validates every selected effort against that model's advertised capabilities.

`use_logged_in_user` defaults to `true` for Copilot adapters. Set it to `false` only when the adapter should use explicit allowlisted token environment variables without stored OAuth or GitHub CLI credential fallback.

The portable Node.js file keeps the Copilot SDK and native Copilot CLI runtime external, so install `@github/copilot-sdk` and `@github/copilot` beside it or in the current project. Standalone executables embed the SDK but keep the native Copilot CLI runtime external. Install `@github/copilot` beside the executable or in the current project, or set `COPILOT_CLI_PATH` to a compatible native Copilot executable. For review adapters that use the override, include `COPILOT_CLI_PATH` in that adapter's `env_allowlist`.

## Configuration location

One global config file is resolved using the host operating system:

| Platform | Default path                                            |
| -------- | ------------------------------------------------------- |
| Windows  | `%APPDATA%\review-mesh\Config\config.toml`              |
| macOS    | `~/Library/Preferences/review-mesh/config.toml`         |
| Linux    | `${XDG_CONFIG_HOME:-~/.config}/review-mesh/config.toml` |

The global config controls:

- Adapter/runtime registrations.
- Credential environment-variable names.
- Globally declared scalar or multi-model agents and exact models.
- Optional per-agent or per-model-run reasoning effort and adapter overrides.
- The optional default agent roster.
- Per-project agent rosters, guidance, and context keyed by project name.
- Concurrency, heartbeat, shutdown grace, diagnostics, and retention.

Project keys are names, not paths—for example, `[projects.payments]`. Review Mesh first prefers the `origin` remote repository name, then another remote repository name, then the Git common-directory or worktree-root name. A non-Git workspace uses its directory name. Matching is case-insensitive, so clones and linked worktrees in different folders share one project entry. If no project name matches, `[defaults].agents` is used; without defaults, the review is rejected.

Workspace `.review-mesh.toml` files are not loaded. All agent and project configuration stays in this single global file.

Never place secret values in `config.toml`. Only reference environment-variable names.

### Configuration manager

Run the rclone-style interactive configuration menu:

```powershell
review-mesh config
```

The menu can list, add, edit, and remove global scalar or multi-model agents;
create and select adapters, including per-run overrides; set the ordered default
roster; add, edit, or remove project-name assignments and context; and edit
execution/diagnostic settings. Each successful change is validated and saved
immediately using an atomic replacement. Existing version 1, scalar-agent
version 2, or path-keyed version 3 configuration is read and migrated to version
4 when it is saved
through the menu; this canonical rewrite does not preserve TOML comments, so
keep a backup when migrating a hand-edited file.

During v3 migration, an existing project path is resolved with the same Git
repository-name rules used at runtime. A stale or missing path falls back to its
last folder component. Migration rejects two old paths that collapse to the same
case-insensitive project name instead of silently overwriting either entry.

Useful non-interactive commands:

```text
review-mesh config --help
review-mesh config path
review-mesh config show
review-mesh config validate
review-mesh config list
review-mesh config list --json
review-mesh config effective . --json
review-mesh config export --json
review-mesh config apply --json
review-mesh config copilot login
review-mesh config copilot status --json
review-mesh config copilot models --json
```

`config effective` (also available as `config resolve`) prints the safe,
effective roster for one workspace without contacting providers. `config
export --json` returns the complete trusted configuration and a SHA-256
revision; because it includes instruction and runtime fields, treat that output
as sensitive. To update configuration non-interactively, edit the exported
`config` object and pipe this strict request to `config apply --json`:

```json
{
  "schema_version": "1",
  "expected_revision": "<revision from config export>",
  "config": { "schema_version": "5" }
}
```

The `config` value above is abbreviated; send the complete desired v5 document.
Apply is whole-document, limited to 5 MiB of JSON input (the config file remains
limited to 4 MiB), validated before publication, and
uses revision compare-and-swap plus atomic replacement. A stale revision fails
with `config_conflict` instead of overwriting another Review Mesh writer. Do not
modify the config simultaneously with an external editor, which does not honor
Review Mesh's update lock.

Generated structural JSON Schemas are available directly from the executable:

```text
review-mesh schema request --json
review-mesh schema events --json
review-mesh schema result --json
review-mesh schema config --json
review-mesh schema config-apply --json
review-mesh schema diagnostic --json
review-mesh schema command-adapter-event --json
```

Runtime semantic validation remains authoritative for cross-field and
cross-reference policy that generated JSON Schema cannot fully express, such as
verdict/finding consistency, evidence line pairs, instruction-source choice,
project-name uniqueness, assignment references, and provider-specific effort.

## Other adapters

Review Mesh also implements these trusted adapter types:

| Type                | Purpose                                                                                | Portable-file note                                                                                                                                                                          |
| ------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openai_compatible` | Embedded OpenAI-compatible agent loop with bounded read-only tools.                    | Fully self-contained.                                                                                                                                                                       |
| `command`           | Integrates a separately installed review agent using the command JSONL protocol.       | External executable remains required.                                                                                                                                                       |
| `copilot`           | GitHub Copilot SDK reviewer with account login, model discovery, and per-agent effort. | Portable Node file requires external SDK/runtime packages; standalone executables embed the SDK but still require a compatible native Copilot runtime. Default profile is read/search only. |
| `claude`            | Claude Agent SDK reviewer.                                                             | Requires its native runtime and compatible endpoint/authentication. Reviewer tools are `Read`, `Glob`, and `Grep` only.                                                                     |
| `codex`             | Codex SDK reviewer.                                                                    | Currently fails closed in production because the pinned runtime does not satisfy Review Mesh's project-configuration isolation characterization.                                            |

For a truly one-file deployment, use `openai_compatible`. Provider-native adapters can remain configured in a source installation, but their native runtime assets cannot be encoded into a cross-platform JavaScript file.

## JSONL events

Every non-empty stdout line is one strict schema-version `5` JSON object. Review
requests and reviewer-result objects use schema version `2`. All events in a
run share one `run_id`; `seq` starts at `1` and increases monotonically;
`run.completed` is final once a valid run begins and stdout remains available.
`suite.resolved` stays compact: it reports logical-lens and model-run totals,
per-lens quorum/adjudication summaries, and execution settings such as primary
distribution and provider limits. It does not repeat the complete concrete
reviewer roster on stdout. The safe effective configuration and private run
resolution retain exact reviewer identities, cyclic order, models, provider
groups, execution-order `model_index`, original `configured_model_index`, and
predecessors. Aggregate heartbeats distinguish deferred, queued, running,
completed, incomplete, and skipped model runs without inventing percentages.

| Event                 | Meaning                                                       |
| --------------------- | ------------------------------------------------------------- |
| `run.started`         | The live-worktree review began.                               |
| `context.resolved`    | Workspace and best-effort Git metadata were resolved.         |
| `suite.resolved`      | Lens summaries, counts, and execution settings were resolved. |
| `reviewer.started`    | One reviewer began, with its model, effort, and timeout.      |
| `reviewer.progress`   | Factual probing, queued, reviewing, or validating activity.   |
| `suite.heartbeat`     | Aggregate liveness, deadlines, stale time, and dual counters. |
| `reviewer.completed`  | One strict reviewer result.                                   |
| `reviewer.incomplete` | One reviewer failed to return a valid terminal result.        |
| `reviewer.skipped`    | A later model was bypassed after prior findings/failure.      |
| `run.completed`       | Compact gate/coverage summary and report artifact path.       |

`reviewer.progress` is phase-level. High-frequency adapter activity updates the
reviewer's persisted latest activity and appears in heartbeats/status snapshots,
but is not emitted once per tool action. Use `review-mesh status RUN_ID --json`
for the compact roster or add a reviewer id for one reviewer. The generated
machine contract is available from `review-mesh schema run-status --json`.

Detailed and retry workflows:

```text
review-mesh report RUN_ID --format markdown
review-mesh findings RUN_ID --deduplicate --json
review-mesh retry RUN_ID --only-incomplete
```

Example final event:

```json
{
  "schema_version": "5",
  "event": "run.completed",
  "run_id": "run_...",
  "seq": 23,
  "timestamp": "2026-08-31T11:45:35.446Z",
  "data": {
    "gate_outcome": "findings",
    "coverage_outcome": "partial",
    "exit_code": 1,
    "consistency_mode": "live_worktree",
    "total_elapsed_ms": 26895,
    "logical_lenses": {
      "total": 8,
      "pending": 0,
      "findings": 4,
      "passed": 1,
      "incomplete": 3,
      "not_applicable": 0,
      "not_evaluated": 0
    },
    "model_runs": {
      "total": 40,
      "deferred": 0,
      "queued": 0,
      "running": 0,
      "completed": 9,
      "incomplete": 3,
      "skipped": 28
    },
    "unique_findings": 8,
    "advisory_findings": 4,
    "incomplete_lenses": ["event-reliability", "security-compliance"],
    "not_evaluated_lenses": ["change-readiness"],
    "report_path": ".../run_....jsonl"
  }
}
```

## Exit codes

| Code | Classification | Meaning                                                         |
| ---: | -------------- | --------------------------------------------------------------- |
|  `0` | `passed`       | Every executed run completed with zero actionable findings.     |
|  `1` | `findings`     | One or more runs found defects; later same-agent runs may skip. |
|  `2` | no run         | Invalid request, usage, global config, or project assignment.   |
|  `3` | `incomplete`   | At least one reviewer/runtime did not return a valid result.    |
|  `4` | interrupted    | Caller interrupted the round.                                   |

Completed findings are retained even when another reviewer is incomplete.
Exit code 3 remains conservative when coverage is partial; read the independent
`gate_outcome` to distinguish partial coverage with findings from partial
coverage without findings.

## Reviewer result shape

Each completed reviewer returns:

```json
{
  "schema_version": "2",
  "verdict": "fail",
  "summary": "One actionable defect was found.",
  "actionable_findings": [
    {
      "id": "zero-count",
      "severity": "high",
      "confidence": "high",
      "classification": "confirmed_defect",
      "external_assumptions": [],
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

Only trusted config can register a command. Review Mesh sends one JSON request
object on child stdin. Its `context` contains the validated `project_name`,
`workspace`, explicit `review_scope`, changed-file list, bounded diff/stat, and
Git refs. Child stdout must contain JSONL only.

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

| Script                      | Purpose                                                                                 |
| --------------------------- | --------------------------------------------------------------------------------------- |
| `npm run build`             | Type-check and generate the one-file CLI.                                               |
| `npm run build:portable`    | Generate only `dist/review-mesh.mjs`.                                                   |
| `npm run build:standalone`  | With Bun 1.4.0, generate Windows/Linux x64 executables and checksums in `dist/release`. |
| `npm run verify:standalone` | Build standalone artifacts and smoke-test the Windows executable on Windows.            |
| `npm test`                  | Run offline tests.                                                                      |
| `npm run test:live`         | Run explicitly configured provider smoke tests.                                         |
| `npm run format:check`      | Check formatting.                                                                       |
| `npm run verify`            | Formatting, typecheck, tests, and portable build.                                       |

The portable acceptance suite copies `review-mesh.mjs` outside the repository and runs it without `node_modules`, including a real embedded-adapter protocol round against a local test server.
