# Review Mesh v8 Complete Review Design

## Purpose

Review Mesh v8 makes review quality and completeness the primary contract. The
CLI must return every validated reviewer result to its caller without replacing
it with a summary, silently shortening it, or requiring a second command to
recover the actual review. Compact lifecycle events remain available for
operators, but they are no longer the default review payload.

This release also closes the remaining v7.1 defects: persisted writer/reader
incompatibility, inconsistent finding counts, weak adjudication enforcement,
unrepresentative doctor checks, non-retried empty provider envelopes, fragile
provider topology/quorum, and missing applicability declarations. Streaming is
added to the OpenAI-compatible path to reduce exposure to gateway origin
timeouts such as HTTP 524.

## Binding invariants

1. The complete sanitized reviewer result is the unit of truth. Review Mesh may
   redact credential-shaped values, but it must not summarize, shorten, omit,
   or silently truncate review content.
2. Any configured size limit fails explicitly with a typed error before a
   result is accepted. The tool must never substitute a shortened review.
3. The same validated result object is used for orchestration, public full
   output, persisted artifacts, reports, findings, and the dashboard.
4. The immutable run artifact is authoritative and must be strictly readable by
   the same binary that writes it. A production run-record round-trip test is a
   release gate.
5. Raw reviewer results are never discarded by deduplication or adjudication.
   Consolidated and gate-effective views are derived views with explicit names.
6. Provider or model failure handling must not alter successful review content.
7. A finding cannot gate solely because an adjudicator repeated it. Required
   proof fields are validated mechanically.

## Result contract

### Reviewer result v3

The request/result protocol advances to reviewer result schema version `3`.
Versions 1 and 2 remain readable for persisted-artifact compatibility.

Each v3 result contains:

- `schema_version: "3"`
- `verdict: "pass" | "fail"`
- `review_markdown`: the reviewer's complete final review, suitable for direct
  presentation to a human or coding agent
- `summary`: a short index only; it never replaces `review_markdown`
- `actionable_findings`: structured findings
- `informational_notes`: structured non-gating notes

Each actionable finding contains the existing identity, severity, title,
description, evidence, remediation, confidence, classification, assumptions,
and duplicate metadata plus:

- `category`: `correctness`, `security`, `reliability`, `concurrency`,
  `lifecycle`, `cleanup`, `compatibility`, `deployment`, `performance`, or
  `other`
- `verification`: direct evidence references and explicit limitations
- `change_impact`: for change-scoped reviews, a base/head comparison describing
  how the authorized change introduced or exposed the finding

The complete serialized result has a 16 MiB safety limit. Individual review
text is not shortened to meet that limit. Oversize output becomes a typed
`result_too_large` incomplete outcome and the already received fragments remain
in the diagnostic spool for that run.

### Sanitization

Credential-shaped values continue to be redacted. Sanitization is applied once
to the accepted reviewer result, without per-string length truncation. That
single sanitized object is then hashed and passed unchanged to all consumers.
The public event and artifact expose the same SHA-256 digest so callers can
verify completeness.

## Full CLI delivery

`review-mesh review` defaults to `--output-mode full-jsonl` in v8.
`compact-jsonl` remains an explicit compatibility/operations mode.

Full mode emits:

1. The ordinary compact lifecycle and heartbeat events.
2. For each completed reviewer, a `reviewer.result` event containing the exact
   sanitized reviewer result, its byte count, and its digest. The event writer
   honors stream backpressure and does not bound the result to the compact
   1,000-character summary field.
3. A terminal `run.completed` event containing a result manifest for every
   completed reviewer, the authoritative artifact path, canonical finding
   counts, gate/coverage outcomes, and a `results_complete: true` assertion.

The caller receives the complete reviews during the original invocation. It
does not need to invoke `report` or read a temporary file. `report` and
`findings` remain durable retrieval and presentation commands.

If the caller chooses `compact-jsonl`, `reviewer.completed` stays compact and
the terminal manifest still identifies the immutable artifact containing every
full result.

## Result production and output-limit recovery

The OpenAI-compatible adapter keeps the post-inspection checkpoint, but removes
the v7 instruction to make the result compact or shorten descriptions.

When a final response ends with `finish_reason = "length"`:

1. Preserve the exact partial content.
2. Ask the same model to continue from the exact stopping point without
   repeating, rewriting, condensing, or dropping prior content.
3. Append continuation fragments in order.
4. Repeat within the original reviewer deadline and configured continuation
   count until the provider finishes normally.
5. Parse and validate only the assembled content.

Fragments are held by a Review Mesh-owned result spool, not written into the
reviewed workspace. The spool is bounded by the 16 MiB result limit and is
deleted after the sanitized result is durably recorded. If the process fails,
the active-run cleanup policy removes stale spools. An in-memory implementation
is permitted only when it preserves the same bytes and enforces the same total
limit; disk storage must not be used merely to disguise truncation.

## OpenAI-compatible transport recovery

### Empty or malformed HTTP-200 envelopes

`choices: []` and equivalent provider-envelope failures remain
`provider_response_invalid`, fallback-eligible, and non-circuit-qualifying.
They are also transiently retryable. The adapter retries the identical chat
request once in place before failing the reviewer, preserving the inspection
conversation and avoiding a full repository reinspection.

### Streaming

OpenAI-compatible registrations gain `streaming = "auto" | "required" |
"disabled"`, defaulting to `auto` for new schema-v6 configurations.

- `auto` requests SSE streaming and accepts a valid non-streaming JSON response.
  A clearly unsupported streaming response falls back once to non-streaming.
- `required` fails readiness when the endpoint cannot stream.
- `disabled` preserves the existing JSON response path.

The SSE parser is bounded, cancellable, reconstructs content and tool-call
deltas exactly, captures finish reasons and usage when available, and rejects
malformed streams with the existing safe diagnostics. Receiving response bytes
incrementally reduces fixed proxy-origin timeout exposure, but Review Mesh does
not claim to eliminate upstream 524 failures that occur before the first byte.

## Doctor parity

`doctor --structured-output` uses the real reviewer execution path against a
Review Mesh-owned synthetic workspace and prompt. It uses the selected
reviewer's model, effort, tools, structured-result schema, streaming mode,
same-model retry, output continuation, and deadline rules.

Doctor output reports each stage separately:

- authentication/model readiness
- streaming negotiation
- read-tool execution
- complete result production
- schema validation

Each failed stage includes the same typed sanitized diagnostics available in a
real run: failure code, HTTP status, validation path, request/correlation IDs,
attempt count, and retry outcome. A tool-stage error must not be mislabeled as a
structured-output error. Doctor remains a point-in-time health test, but a
doctor pass and live review now exercise the same mechanism.

## Canonical findings and counts

Finding normalization and consolidation move to one shared module used by live
aggregation and persisted reporting.

The algorithm preserves all raw findings and builds deterministic groups using:

1. explicit `root_issue_id`
2. explicit `duplicate_of` and `duplicate_finding_ids`
3. exact normalized title association when it maps unambiguously to one
   explicit root, or exact normalized title for findings without explicit roots
4. exact normalized title and description as a final legacy fallback

Distinct explicit roots are never merged only because they share a generic
title. Consolidated items retain every source, description, evidence item, and
suggested direction.

`run.completed.unique_findings` equals the number returned by
`findings --deduplicate`. Separate fields report `raw_findings`,
`gate_findings`, and `advisory_findings`; gate thresholds no longer change the
meaning of `unique_findings`.

## Adjudication quality enforcement

Adjudication uses a dedicated result schema rather than an ordinary reviewer
result. Every candidate finding receives a decision keyed by candidate/source
finding ID: `confirmed`, `rejected`, or `adjusted`.

All confirmed or adjusted decisions require cited evidence. Additionally:

- reliability, concurrency, lifecycle, and cleanup findings require an ordered
  execution proof with at least two cited steps and an explicit failure point
- change-scoped findings require a cited base/head comparison
- unverified assumptions must be listed; a decision with a missing required
  proof cannot be `confirmed_defect`

The orchestrator validates these fields. Invalid proof downgrades the candidate
to non-gating `needs_verification` while retaining both the candidate and the
adjudicator's complete review in the raw report. A different provider group is
still required for adjudication.

## Configuration schema v6

Configuration advances to schema version `6`.

### Provider topology

New schema-v6 configurations default to distributed primaries. A multi-lens,
multi-provider suite that resolves every primary to one provider group is a
validation error unless `execution.allow_provider_concentration = true` is
explicitly set. Per-provider concurrency remains enforced.

### Quorum resilience

A multi-provider lens with zero provider-outage tolerance is a validation error
unless `allow_zero_outage_tolerance = true` is explicitly set on that lens.
Default five-model lenses use a three-pass, three-provider-group quorum. Review
Mesh never silently weakens an explicitly allowed strict quorum.

### Applicability and required input

Every schema-v6 lens explicitly declares:

- `applicability.mode = "always"`, or
- `applicability.mode = "changed_paths"` with bounded path globs

Every lens also declares `required_context`, which may be an empty array. This
prevents accidental omission from looking like an intentional always-applicable
policy. `not_applicable` and `not_evaluated_missing_input` remain deterministic
policy outcomes; Review Mesh does not infer behavior from a lens name.

Managed migration fills explicit `always`/empty policies for legacy lenses and
surfaces them for review. It does not invent deployment globs or PR metadata
requirements. Before release, the active machine configuration will be updated
only where the intended lens mapping can be identified exactly; no unknown
roster will be overwritten speculatively.

## Persistence and report compatibility

All private records are constructed through one run-bound writer that injects
and validates `run_id`. Call sites cannot omit it. The `context` record bug is
therefore fixed at the producer boundary rather than only relaxed in the
reader.

Release tests execute a real synthetic review through recorder close, then read
the resulting immutable file with strict `status`, `report`, and `findings`.
The artifact must reproduce every public result digest and canonical count.
Best-effort mode remains for future-version salvage, not as a workaround for
same-version output.

## Security and resource handling

- Review spools live outside the reviewed workspace and are never exposed to
  reviewer file tools.
- Paths are fixed by Review Mesh, opened without following links, and cleaned
  with the existing bounded shutdown/stale-run policy.
- Credentials are redacted before public or persistent output.
- No review content is silently truncated. Size, disk, stdout, or persistence
  failures are explicit incomplete outcomes.
- Public full output uses backpressure; a closed caller stream aborts cleanly
  without claiming `results_complete`.

## Release acceptance criteria

1. A reviewer result larger than the old 8 KiB text limit is returned byte-for-
   byte after credential redaction in full stdout and the immutable artifact.
2. Multiple `finish_reason=length` fragments assemble into one valid complete
   result without any compact/shorten instruction or repeated inspection.
3. Same-version strict `status`, `report`, and `findings` read a real produced
   run; every private record contains the correct `run_id`.
4. `run.completed.unique_findings` exactly matches
   `findings --deduplicate`, while raw and gate counts remain separately visible.
5. A contradictory control-flow adjudication without ordered/base proof cannot
   gate and remains visible as `needs_verification`.
6. Empty `choices` responses retry once in place, never affect provider
   circuits, and retain diagnostics if exhausted.
7. Doctor runs the same end-to-end model/effort/tool/finalization mechanism and
   returns stage-specific diagnostics.
8. Streaming reconstruction, cancellation, malformed-stream handling, and
   non-stream fallback are covered by deterministic tests.
9. Concentrated primaries and zero-outage quorum fail schema-v6 validation
   unless explicitly acknowledged.
10. Explicit applicability and required-context policies prevent deployment and
    change-readiness lenses from running when their declared prerequisites are
    absent.
11. Full suite, portable build, Windows/Linux standalone acceptance, release
    asset checksums, strict artifact round-trip, and an independent zero-finding
    code review pass before publication.

