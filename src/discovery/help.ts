import packageMetadata from "../../package.json" with { type: "json" };

export const reviewMeshVersion = packageMetadata.version;

export type HelpTopic =
  | "overview"
  | "review"
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
reviewer suite selected for a workspace, streams factual JSONL progress, waits
for every reviewer, and exits only after a terminal run.completed event.

USAGE
  review-mesh review [WORKSPACE]
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
     reports the exact agents, models, purposes, effort, isolation policy,
     timeouts, concurrency, heartbeat interval, and configuration path.
  2. Run: review-mesh schema request --json
     This returns the generated JSON Schema for an explicit review request.
  3. Run: review-mesh review [WORKSPACE]
     With empty stdin, Review Mesh reviews the current directory using a safe
     default instruction. With JSON on stdin, it uses the supplied request.
  4. Read stdout one JSON object per line until run.completed. Do not stop after
     a finding: the remaining mandatory reviewers still run. Heartbeats mean the
     process is alive even when a reviewer has no new activity to report.

DISCOVERY COMMANDS
  describe   Resolve the suite selected for a workspace without starting it.
  schema     List or print generated Zod-derived structural schemas.
  help       Print this manual or a focused topic page.
  config     Inspect or manage trusted global configuration.

REVIEW I/O CONTRACT
  stdin      Empty, or exactly one UTF-8 JSON request (maximum 8 MiB).
  stdout     JSONL public events only after a review begins.
  stderr     Diagnostics before a run begins or if infrastructure fails.

HELP TOPICS
  review, config, config-file, adapters, command-adapter, describe, schema,
  events, exit-codes

Run 'review-mesh help TOPIC' or 'review-mesh TOPIC --help' for details.
`;

const pages: Record<Exclude<HelpTopic, "overview">, string> = {
  review: `REVIEW-MESH REVIEW

USAGE
  review-mesh review [WORKSPACE]
  <request.json review-mesh review

WORKSPACE defaults to the current directory. If stdin is a terminal or is empty,
Review Mesh synthesizes this request immediately:
  {"schema_version":"1","workspace":"<current directory>",
   "instructions":"Review for evidence-backed correctness, security,
   reliability, compatibility, and test-coverage defects."}

If stdin is not empty, it must be exactly one request object. Required fields:
  schema_version  The string "1".
  workspace       An existing local directory.
  instructions    Review focus sent to every mandatory reviewer.

Optional fields:
  request_id      Caller correlation id copied into every event.
  scope_hints     {base, head, branch, paths, staged} Git discovery hints.
  context         Arbitrary JSON supplied as lower-priority caller context.

Before running, use 'review-mesh describe WORKSPACE --json' to see the exact
trusted suite. During a run, consume stdout as JSONL until run.completed.
The caller cannot disable, replace, reorder, or select mandatory reviewers.
A positional WORKSPACE and a piped non-empty JSON request are mutually exclusive.

Exit codes: 0 passed, 1 findings, 2 invalid request/config/usage,
3 incomplete reviewer/runtime, 4 interrupted.
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
  review-mesh config apply --json    Atomically apply a full v2 config with CAS
  review-mesh config copilot login [--device-code|--web-flow] [--host URL]
  review-mesh config copilot status [--json]
  review-mesh config copilot models [--json]

Configuration is global and trusted. Project entries are keyed by absolute path;
the most-specific containing path wins, otherwise defaults are used. Workspace
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
project paths and references, uses the exported SHA-256 revision as a
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
(default: current directory), applies the most-specific project assignment, and
prints the exact effective reviewer suite without probing providers or starting
a review.

The JSON form includes configuration status/path, workspace, execution,
diagnostics, and reviewers with id, purpose, adapter,
adapter_type, model, optional effort, isolation_policy, timeout_ms,
and instruction_sources. It never prints instructions, credentials, project
context, environment values, or runtime option values.

This is the recommended first command for an AI caller.
`,
  schema: `REVIEW-MESH SCHEMA

USAGE
  review-mesh schema list
  review-mesh schema [request|events|result|config|config-apply|diagnostic|
                      command-adapter-event] [--json]

Prints JSON Schema generated from the runtime Zod schemas:
  request  JSON object accepted on review stdin
  events   JSONL event object emitted by a valid review run
  result   Terminal result required from each reviewer
  config   Trusted global configuration (v1 legacy or v2 current)
  config-apply  Revision-guarded full-config update request
  diagnostic    Stable public diagnostic fields
  command-adapter-event  External reviewer JSONL event union

With --json (recommended for agents), stdout is a single JSON document containing
the schema name and schema. Without --json, a short label precedes pretty JSON.

These schemas describe strict JSON structure. Runtime semantic checks still
apply where JSON Schema cannot express Review Mesh policy: result verdict/finding
consistency, evidence line-pair rules, exactly one instruction source, project
path normalization, assignment/reference validity, and provider-specific effort.
Use 'review-mesh config validate' after constructing config and treat runtime
validation as final authority.
`,
  events: `REVIEW-MESH EVENTS

Every non-empty review stdout line is one schema-version 2 JSON object. Events
share run_id, have strictly increasing seq values, and include timestamps.

Sequence and meaning:
  run.started          A valid live-worktree run began.
  context.resolved     Canonical workspace and best-effort Git context.
  suite.resolved       Exact roster plus concurrency and heartbeat settings.
  reviewer.progress    Capability probe, queue state, or adapter activity.
  reviewer.started     One reviewer started, with model/effort/timeout.
  reviewer.heartbeat   Liveness during probes, queueing, and active review.
  reviewer.completed   Valid terminal result for one reviewer.
  reviewer.incomplete  Reviewer/runtime did not return a valid result.
  run.completed        Final status, exit code, and every terminal record.

Always continue reading until run.completed or process termination. A finding is
not terminal for the suite. Review Mesh reports factual phases and elapsed time,
never invented percentages. Use 'review-mesh schema events --json' for the exact
machine contract.
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

Every agent chooses one adapter id, exact model, optional effort, purpose,
trusted instructions, isolation policy, and timeout. Use 'review-mesh schema
config --json' for the authoritative shapes, 'review-mesh config copilot models
--json' for account-specific Copilot models, and 'review-mesh describe . --json'
for the exact effective roster. Provider readiness is probed when review starts.
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

Schema version 2 contains:
  execution    max concurrency, heartbeat interval, shutdown grace
  diagnostics  sanitized run persistence and retention
  adapters     trusted runtime registrations and environment-variable names
  agents       model, effort, purpose, instructions, isolation, timeout
  defaults     ordered fallback agent roster
  projects     absolute-path roster/guidance/context overrides

The most-specific project ancestor wins. A project with agents overrides the
default roster; a project without agents layers guidance/context onto defaults.
Instruction files must remain beneath the config directory. Never store literal
credentials in this file.

For autonomous changes, use export/apply with revision compare-and-swap:
  review-mesh config export --json
  review-mesh config apply --json

Export contains instruction and runtime fields and should be treated as
sensitive. Apply accepts a complete v2 document, not a patch. Use 'review-mesh
schema config --json' and 'review-mesh config --help' for exact details.
`,
  "exit-codes": `REVIEW-MESH EXIT CODES

  0  passed       Every mandatory reviewer completed with no findings.
  1  findings     Every reviewer completed; at least one found a defect.
  2  no run       Invalid usage, request, configuration, or project assignment.
  3  incomplete   A reviewer/runtime failed to produce a valid terminal result.
  4  interrupted  The caller interrupted configuration or a review round.

Outcome precedence is incomplete > findings > passed. Completed findings remain
available in run.completed even when another reviewer is incomplete.
`,
};

export function normalizeHelpTopic(
  value: string | undefined,
): HelpTopic | undefined {
  if (value === undefined) return "overview";
  const normalized = value.toLowerCase();
  if (normalized === "help") return "overview";
  if (normalized === "event" || normalized === "jsonl") return "events";
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
