import packageMetadata from "../../package.json" with { type: "json" };

export const reviewMeshVersion = packageMetadata.version;

export type HelpTopic =
  | "overview"
  | "review"
  | "status"
  | "report"
  | "findings"
  | "retry"
  | "doctor"
  | "config"
  | "describe"
  | "schema"
  | "events"
  | "adapters"
  | "command-adapter"
  | "config-file"
  | "exit-codes";

const overview = `Review Mesh ${reviewMeshVersion}

Agent-first multi-runtime code review gate. Review Mesh runs the complete trusted
agent suite selected for a workspace, streams factual JSONL progress, waits for
each agent's executed model chain, and exits only after run.completed.

USAGE
  review-mesh review [WORKSPACE]
  review-mesh status RUN_ID [REVIEWER_ID] [--json]
  review-mesh report RUN_ID [--format markdown|json]
  review-mesh findings RUN_ID [--deduplicate] [--json]
  review-mesh retry RUN_ID --only-incomplete
  review-mesh doctor [WORKSPACE] [--structured-output]
  review-mesh describe [WORKSPACE] [--json]
  review-mesh schema list
  review-mesh schema NAME [--json]
  review-mesh config [help|path|show|validate|list|effective|export|apply|copilot ...]
  review-mesh help [TOPIC]
  review-mesh --help | -h
  review-mesh --version | version

AGENT QUICK START
  1. Run: review-mesh describe . --json
     This resolves the configuration that applies to the current workspace and
     reports project_name plus the exact agents, models, purposes, effort,
     isolation policy, timeouts, concurrency, heartbeat interval, and config.
  2. Run: review-mesh schema request --json
     This returns the generated JSON Schema for an explicit review request.
  3. Run: review-mesh review [WORKSPACE]
     With empty stdin, Review Mesh reviews only the current Git change set above
     the inferred default branch, including local staged/unstaged/untracked work.
     With JSON on stdin, send the explicit v2 request described below.
  4. Read stdout one JSON object per line until run.completed. Logical lenses
     run in parallel. A transient failure may retry; an operational failure
     advances to an eligible fallback. Clean runs stop at quorum, while findings
     can be independently adjudicated.

DISCOVERY COMMANDS
  describe   Resolve the suite selected for a workspace without starting it.
  status     Query a compact persisted run or individual reviewer snapshot.
  schema     List or print generated Zod-derived structural schemas.
  help       Print this manual or a focused topic page.
  config     Inspect or manage trusted global configuration.

REVIEW I/O CONTRACT
  stdin      Empty, or exactly one UTF-8 JSON request (maximum 8 MiB).
  stdout     JSONL public events only after a review begins.
  stderr     Diagnostics before a run begins or if infrastructure fails.

HELP TOPICS
  review, status, report, findings, retry, doctor, config, config-file,
  adapters, command-adapter, describe, schema, events, exit-codes

Run 'review-mesh help TOPIC' or 'review-mesh TOPIC --help' for details.
`;

const pages: Record<Exclude<HelpTopic, "overview">, string> = {
  review: `REVIEW-MESH REVIEW

USAGE
  review-mesh review [WORKSPACE]
  <request.json review-mesh review

WORKSPACE defaults to the current directory. If stdin is a terminal or is empty,
Review Mesh synthesizes this request immediately:
  {"schema_version":"2","project_name":"<resolved repository name>",
   "workspace":"<current directory>",
   "instructions":"Review the current change set for evidence-backed defects.",
   "review_scope":{"mode":"changes"}}

If stdin is not empty, it must be exactly one request object. Required fields:
  schema_version  The string "2".
  project_name    Copy configuration.selection.project_name from describe.
  workspace       An existing local directory.
  instructions    Review focus sent to every mandatory reviewer.
  review_scope    {mode:"changes", base?, head?, branch?, paths?}, or
                  {mode:"full", paths?} for an explicit whole-codebase review.

Optional fields:
  request_id      Caller correlation id copied into every event.
  context         Arbitrary JSON supplied as lower-priority caller context.

Before running, use 'review-mesh describe WORKSPACE --json' to see the exact
project_name and trusted suite. project_name is an assertion: it must match the
Git-derived workspace identity and cannot select another project's settings.
For mode=changes, omitted base means the remote/default main or master branch;
omitted head means the checked-out HEAD. An explicit branch/head must match the
checked-out worktree. Committed changes above the merge base plus staged,
unstaged, and untracked files form the review scope. paths only narrows it.
Use mode=full only when the caller explicitly asks for the entire codebase.
During a run, consume stdout as JSONL until run.completed. The caller cannot
disable, replace, reorder, or select mandatory reviewers. A positional WORKSPACE
and a piped non-empty JSON request are mutually exclusive.

Exit codes: 0 passed, 1 findings, 2 invalid request/config/usage,
3 incomplete reviewer/runtime, 4 interrupted.
`,
  status: `REVIEW-MESH STATUS

USAGE
  review-mesh status RUN_ID [REVIEWER_ID] [--json]

Reads the sanitized persisted record for one active or completed run. With only
RUN_ID it returns a compact snapshot for the whole reviewer roster. Add an exact
REVIEWER_ID to return only that reviewer. The result includes lifecycle state,
latest activity, elapsed time, terminal result or failure when available, and
the last observed event sequence.

This command is read-only and does not contact, cancel, or otherwise change the
running review. It is available when diagnostics.persist_runs is enabled. Use
the run_id from run.started; callers can poll this command instead of retaining
every progress or heartbeat event in their own context.
`,
  report: `REVIEW-MESH REPORT

USAGE
  review-mesh report RUN_ID [--format markdown|json]

Renders the persisted detailed review artifact. Markdown is the default; JSON
includes logical-lens and model-run coverage, raw findings, deterministic
deduplication, provenance, confidence, classification, and assumptions.
`,
  findings: `REVIEW-MESH FINDINGS

USAGE
  review-mesh findings RUN_ID [--deduplicate] [--json]

Reads findings from the persisted detailed artifact. --deduplicate returns the
consolidated set with source reviewer/finding ids and duplicate ids.
`,
  retry: `REVIEW-MESH RETRY

USAGE
  review-mesh retry RUN_ID --only-incomplete

Starts a new review linked to the persisted parent run and targets the logical
lenses that lacked a verdict. The normalized request is recovered from the
private run artifact; completed lens evidence remains available in the parent.
`,
  doctor: `REVIEW-MESH DOCTOR

USAGE
  review-mesh doctor [WORKSPACE] [--structured-output]

Preflights the resolved adapter/model roster before a long run. The structured
mode verifies authentication, model availability, response-envelope parsing,
and schema-constrained output where the adapter supports it.
`,
  config: `REVIEW-MESH CONFIG

USAGE
  review-mesh config                 Interactive configuration menu
  review-mesh config path            Print the trusted config path
  review-mesh config show            Print canonical validated TOML
  review-mesh config validate        Validate the trusted config
  review-mesh config list [--json]   List global agents and project mappings
  review-mesh config effective [WORKSPACE] --json
                                      Resolve the safe effective agent roster
  review-mesh config export --json   Export full config plus revision
  review-mesh config apply --json    Atomically apply a full v5 config with CAS
  review-mesh config copilot login [--device-code|--web-flow] [--host URL]
  review-mesh config copilot status [--json]
  review-mesh config copilot models [--json]

Configuration is global and trusted. Project entries are keyed by project name,
not by folder path. Review Mesh prefers the origin remote repository name, then
another remote, then the Git common/root directory name; non-Git workspaces use
the workspace directory name. Matching is case-insensitive, so clones and linked
worktrees share one assignment. Otherwise defaults are used. Workspace
.review-mesh.toml files are intentionally ignored. Store environment-variable
names in config, never credential values.

For the effective suite of one workspace, use:
  review-mesh describe WORKSPACE --json
  review-mesh config effective WORKSPACE --json

For agent-driven configuration changes:
  1. Run review-mesh config export --json.
  2. Edit the complete exported config object.
  3. Pipe {schema_version:"1", expected_revision, config} to
     review-mesh config apply --json.

Apply is a strict whole-document transaction, limited to 5 MiB. The serialized
TOML itself remains capped at 4 MiB; the extra request budget covers JSON
escaping and envelope fields. Apply validates
project names and references, uses the exported SHA-256 revision as a
compare-and-swap guard, and atomically replaces the file. A stale writer gets
config_conflict and must export again. This serialization covers Review Mesh
writers; do not run an external editor concurrently with config apply. Export
includes trusted instruction and runtime fields, so treat it as sensitive;
effective/describe redact them.

For the complete supported TOML shape, use:
  review-mesh schema config --json
`,
  describe: `REVIEW-MESH DESCRIBE

USAGE
  review-mesh describe [WORKSPACE] [--json]

Loads and validates the trusted global configuration, canonicalizes WORKSPACE
(default: current directory), resolves its project name and assignment, and
prints the exact effective reviewer suite without probing providers or starting
a review.

The JSON form includes configuration status/path, workspace, resolved
project_name, project_name_source, matched_project_name when configured,
execution, diagnostics, and reviewers with id, purpose, adapter,
adapter_type, model, optional effort, isolation_policy, timeout_ms,
and instruction_sources. It never prints instructions, credentials, project
context, environment values, or runtime option values.

This is the recommended first command for an AI caller.
`,
  schema: `REVIEW-MESH SCHEMA

USAGE
  review-mesh schema list
  review-mesh schema [request|events|result|config|config-apply|diagnostic|
                      run-status|command-adapter-event] [--json]

Prints JSON Schema generated from the runtime Zod schemas:
  request  Required v2 JSON object accepted on review stdin
  events   JSONL event object emitted by a valid review run
  run-status  Compact active or completed run/reviewer status snapshot
  result   Terminal result required from each reviewer
  config   Trusted global configuration (v1-v4 legacy or v5 current)
  config-apply  Revision-guarded full-config update request
  diagnostic    Stable public diagnostic fields
  command-adapter-event  External reviewer JSONL event union

With --json (recommended for agents), stdout is a single JSON document containing
the schema name and schema. Without --json, a short label precedes pretty JSON.

These schemas describe strict JSON structure. Runtime semantic checks still
apply where JSON Schema cannot express Review Mesh policy: result verdict/finding
consistency, evidence line-pair rules, project/workspace identity, checked-out
branch/head assertions, default-base discovery, exactly one instruction source,
project-name uniqueness, assignment/reference validity, and provider effort.
Use 'review-mesh config validate' after constructing config and treat runtime
validation as final authority.
`,
  events: `REVIEW-MESH EVENTS

Every non-empty review stdout line is one schema-version 5 JSON object. Events
share run_id, have strictly increasing seq values, and include timestamps.

Sequence and meaning:
  run.started          A valid live-worktree run began.
  context.resolved     Canonical workspace and best-effort Git context.
  suite.resolved       Exact roster plus concurrency and heartbeat settings.
  reviewer.progress    Capability probe, queue state, or adapter activity.
  reviewer.started     One reviewer started, with model/effort/timeout.
  suite.heartbeat      Aggregate liveness, deadlines, and stale activity.
  reviewer.completed   Valid terminal result for one reviewer.
  reviewer.incomplete  Reviewer/runtime did not return a valid result.
  reviewer.skipped     A later fallback was not needed after findings/failure.
  run.completed        Compact gate/coverage outcome and artifact reference.

Always continue reading until run.completed or process termination. Operational
failures advance to eligible fallbacks; clean passes stop at configured quorum.
Review Mesh reports factual phases and elapsed time, never invented percentages.
Use 'review-mesh schema events --json' for the exact machine contract.
High-frequency adapter activity is retained as latest status instead of being
emitted once per tool action; query it with
'review-mesh status RUN_ID [REVIEWER_ID] --json'. Retry count and backoff are
trusted configuration; each attempt has a bounded deadline and fallback uses the
remaining logical-lens budget.
`,
  adapters: `REVIEW-MESH ADAPTERS

Supported trusted adapter types:
  openai_compatible  Embedded read-only agent loop. Config references base URL
                     and API key environment-variable names, never their values.
  command            External reviewer using review-mesh-command-v1 JSONL.
  copilot            GitHub Copilot SDK reviewer with login/model discovery.
  claude             Claude Agent SDK reviewer with read/search tools only.
  codex              Codex SDK reviewer; fails closed if isolation cannot be
                     characterized safely.

Every agent chooses a required default adapter plus either one exact model and
optional effort, or ordered model_runs with explicit run ids, exact models,
optional effort, and optional per-run adapter overrides. Multi-model agents
expand to concrete reviewer ids such as architecture::opus and
architecture::grok. Existing scalar agents retain their original ids. Global
max_concurrency applies across logical agents. Each agent starts only its first
configured model; it advances to the next model only after a valid pass with no
actionable findings. Findings or an incomplete run stop that agent's remaining
models, which are reported as skipped. Use 'review-mesh schema config --json'
for the authoritative shapes, 'review-mesh config copilot models --json' for
account-specific Copilot models, and 'review-mesh describe . --json' for the
exact effective roster. Provider readiness is probed when each model becomes
eligible to run.
`,
  "command-adapter": `REVIEW-MESH COMMAND ADAPTER PROTOCOL

Only trusted config can register an external command. Review Mesh starts it
without a shell, sends one JSON request on stdin, and reads JSONL from stdout.

The child may first emit:
  {"type":"capabilities","isolation":"enforced_read_only"}

It may then emit factual non-terminal activity:
  {"type":"progress","phase":"reviewing","message":"Inspecting files"}
  {"type":"activity","message":"Completed dependency analysis"}

Exactly one terminal event is required. A result contains the object from
'review-mesh schema result --json'. A failure contains reason, safe message,
and retryable. Malformed/oversized output, multiple terminals, output after a
terminal, or a missing terminal makes that reviewer incomplete. Child stderr is
bounded and sanitized before any public failure. See the README's Command-
adapter protocol section for full request and limit details.
`,
  "config-file": `REVIEW-MESH CONFIG FILE

Review Mesh uses one trusted global config.toml. Run 'review-mesh config path'
for its exact platform path. Workspace .review-mesh.toml files are ignored.

Schema version 4 contains:
  execution    max concurrency, heartbeat interval, shutdown grace
  diagnostics  sanitized run persistence and retention
  adapters     trusted runtime registrations and environment-variable names
  agents       scalar model/effort or model_runs, purpose, instructions,
               isolation, timeout, and optional per-run adapter overrides
  defaults     ordered fallback agent roster
  projects     project-name roster/guidance/context overrides

The resolved project name selects at most one entry. A project with agents
overrides the default roster; a project without agents layers guidance/context
onto defaults. Names match case-insensitively. Git remote repository names are
preferred, making clones and linked worktrees portable across folder locations.
Instruction files must remain beneath the config directory. Never store literal
credentials in this file.

For autonomous changes, use export/apply with revision compare-and-swap:
  review-mesh config export --json
  review-mesh config apply --json

Export contains instruction and runtime fields and should be treated as
sensitive. Apply accepts a complete v2-v5 document, not a patch; legacy
documents are promoted to v5 when saved. Use 'review-mesh schema config --json' and
'review-mesh config --help' for exact details.
`,
  "exit-codes": `REVIEW-MESH EXIT CODES

  0  passed       Every executed reviewer completed with no findings.
  1  findings     Every reviewer completed; at least one found a defect.
  2  no run       Invalid usage, request, configuration, or project assignment.
  3  incomplete   A reviewer/runtime failed to produce a valid terminal result.
  4  interrupted  The caller interrupted configuration or a review round.

Gate outcome and coverage outcome are independent. Exit 3 remains conservative
for partial coverage, while the terminal event still exposes any findings.
`,
};

export function normalizeHelpTopic(
  value: string | undefined,
): HelpTopic | undefined {
  if (value === undefined) return "overview";
  const normalized = value.toLowerCase();
  if (normalized === "help") return "overview";
  if (normalized === "event" || normalized === "jsonl") return "events";
  if (normalized === "progress" || normalized === "run-status") return "status";
  if (normalized === "adapter") return "adapters";
  if (normalized === "command" || normalized === "protocol")
    return "command-adapter";
  if (normalized === "configuration" || normalized === "toml")
    return "config-file";
  if (normalized === "exit" || normalized === "exits") return "exit-codes";
  return normalized === "overview" || normalized in pages
    ? (normalized as HelpTopic)
    : undefined;
}

export function renderHelp(topic: HelpTopic = "overview"): string {
  return topic === "overview" ? overview : pages[topic];
}
