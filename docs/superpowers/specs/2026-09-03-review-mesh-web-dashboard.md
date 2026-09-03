# Review Mesh Web Dashboard Design

## Goal

`review-mesh serve` starts a local, read-only web dashboard that makes Review
Mesh observable to a human without changing review execution. The dashboard
shows retained active and recent reviews, their factual lifecycle stages,
logical lenses and concrete reviewer/model runs, structured findings, configured
agents, configured projects, and safe system configuration.

The web application and server must remain part of the portable JavaScript
bundle and the single Bun standalone executable. It has no runtime web assets,
package installation, database, authentication, or write API.

## Product shape

The UI is a dense review-operations console with four views:

- **Reviews**: active run timelines and recent history.
- **Agents**: all configured logical agents and their ordered model chains.
- **Projects**: project assignments and safe metadata.
- **System**: execution, diagnostics, adapters, credential-variable presence,
  server information, and data locations.

Selecting a run opens its full timeline, findings, and event history. Selecting
a concrete reviewer opens an inspector with activity, result, and runtime
metadata. Review Mesh currently persists sanitized phase/activity summaries and
structured terminal results, not provider chat transcripts. The UI states that
constraint explicitly and never manufactures a conversation.

## Server contract

The command is:

```text
review-mesh serve [--host HOST] [--port PORT] [--no-open]
```

Defaults are `127.0.0.1`, an operating-system-assigned port, and opening the
browser when stdout is an interactive terminal. Non-loopback binding is
rejected: the dashboard exposes local workspace paths, configuration metadata,
and review findings and is intentionally local-only in this release.

The server supports only `GET` and `HEAD`:

- `GET /` returns the embedded application.
- `GET /api/snapshot` returns sanitized configuration and run summaries.
- `GET /api/runs/:runId` returns one sanitized run detail.
- `GET /api/runs/:runId/reviewers/:reviewerId` returns one reviewer detail.
- `GET /api/stream` returns Server-Sent Event invalidations.

API responses use `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`,
a restrictive Content Security Policy, no CORS headers, and no reflected HTML.
Unknown paths return JSON 404 responses. Mutation methods return 405.

SSE carries only invalidation/revision messages. The browser refetches the JSON
resource and falls back to two-second polling. File-system changes are detected
by a bounded directory/config fingerprint; no review process is coupled to the
server.

## Data model and safety

Run discovery is confined to the configured application runs directory. Both
published `<run>.jsonl` files and active recorder files are recognized. Run IDs
must remain safe single filename components. Files are opened without following
links, bounded in size, and parsed independently so one unreadable record cannot
break the dashboard.

The run parser:

- seeds concrete reviewer rows from the private sanitized `resolution` record;
- derives request/project/workspace and safe Git context from persisted records;
- consumes public events in sequence and uses `run.completed` as terminal
  authority;
- ignores only an incomplete final line for an active file;
- groups reviewers by logical lens and orders them by effective model index;
- constructs sparse phase intervals from event timestamps, never percentages;
- exposes structured reviewer results, attempts, skips/failures, and findings;
- redacts sensitive-looking keys and strings again at the HTTP boundary.

The configuration catalog is built from the validated managed configuration,
not `config export`. It includes safe agent/model/policy/project/execution data.
It excludes instruction bodies, instruction paths, runtime objects, project
context values, adapter commands/arguments, endpoint values, and credential
values. Environment variable names and their present/missing state are safe to
show.

Active reviews always create a sanitized transient record that a separate
`serve` process can observe. When persisted-run diagnostics are disabled, that
record is removed instead of being published as retained history when the run
closes.

## Timeline semantics

Run stages are factual milestones:

1. Resolve context
2. Resolve suite
3. Execute lenses
4. Consolidate
5. Complete

Reviewer states are `deferred`, `queued`, `probing`, `starting`, `reviewing`,
`validating`, `completed`, `incomplete`, and `skipped`. Completed results retain
pass versus findings. Adjudication is shown as a focused reviewer mode, not a
generic fallback. Gate and coverage are independent: an active run says “No
findings yet” or “Findings observed” and “In progress”; only a terminal run may
say passed/complete.

## Verification

Coverage includes:

- argument validation, loopback binding, lifecycle, and abort shutdown;
- snapshot sanitization and configuration-missing behavior;
- active/final record discovery, partial active tails, malformed-record
  isolation, and path traversal rejection;
- run and reviewer API output, HEAD/404/405 behavior, headers, and SSE;
- portable build and exact standalone executable serving embedded UI and APIs;
- full existing typecheck/test/build regression suite.
