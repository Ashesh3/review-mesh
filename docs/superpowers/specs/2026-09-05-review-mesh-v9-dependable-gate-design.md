# Review Mesh v9 Dependable Unattended Gate Design

## Purpose

Review Mesh v9 makes bounded completion, evidence coverage, and unambiguous
outcomes part of the review contract. It preserves v8's lossless immutable
artifact and fail-closed orchestration, while preventing a small change from
running indefinitely, appearing stalled, or being reported as clean when a
reviewer could not inspect the relevant files.

This design is based on the v8 run
`run_83bfd246-f912-4254-bdb0-bc419e2dfa5f`. That run reviewed five changed
files with a 23,285-byte diff and finished after 4,863,264 milliseconds. It
completed 26 of 40 model runs, left five incomplete, skipped nine, passed six
of eight logical lenses, and produced 11 non-gating canonical findings with no gate
findings. Its final aggregate heartbeat preceded `run.completed` by 3,527,803
milliseconds. One clean result explicitly said that four relevant changed
files were unavailable. Another model exhausted structured-output
continuations after 1,006,339 milliseconds.

V9 therefore targets a dependable unattended PR gate rather than merely a
durable assisted-review archive.

## Scope

V9 changes five connected contracts:

1. deadline and liveness control;
2. changed-file inspection coverage;
3. structured result production and canonical findings;
4. public outcome and output semantics; and
5. configuration, prerequisite, and Git-history safety.

The release is intentionally a major-version protocol change. It does not
silently preserve misleading v8 labels or the absence of a suite deadline.

## Non-goals

- Review Mesh does not fetch Azure DevOps or GitHub PR metadata in v9.
- Review Mesh does not fetch Git history or mutate the reviewed checkout.
- Review Mesh does not weaken an explicitly configured quorum.
- Review Mesh does not execute builds, tests, or arbitrary reviewer commands.
- Review Mesh does not use nondeterministic LLM similarity to alter gate
  eligibility.
- Review Mesh does not discard raw findings, reviewer results, adjudication
  decisions, or validated evidence.
- Review Mesh does not invent progress percentages.

## Versioned contracts

V9 uses the following current versions:

- review request schema `3`;
- configuration schema `7`;
- reviewer result schema `4`;
- adjudication result schema `2`;
- public event schema `6`;
- immutable run-artifact format `2`;
- run report schema `2`;
- run status schema `3`; and
- dashboard snapshot and run payload schema `2`.

Request schema `3` extends v2 with typed optional `pull_request` metadata.
Generic callers may continue to send request v2. A selected change-readiness
lens treats a v2 request, or a v3 request without `pull_request`, as missing
required input before provider contact.

Readers accept request versions 2 and 3, headerless run-artifact format 1 and
headered format 2, configuration versions 1 through 7, reviewer results 1
through 4, adjudication results 1 and 2, and persisted public event versions 4
through 6.
This is the explicit historical compatibility floor; v9 does not imply support
for earlier event formats that v8 could not strictly read. Writers emit only
the current version for newly written data. Prior run artifacts are never
rewritten.

Public event v5 remains frozen. V9 does not rename `no_findings` inside a v5
event. The normalization layer maps it to the v9 gate dimension only while
retaining the reported legacy value for diagnostics.

CLI exit codes remain stable:

- `0`: complete coverage and no gate findings;
- `1`: complete coverage with one or more gate findings;
- `2`: invalid usage, request, configuration, or pre-run workspace state;
- `3`: incomplete or partial coverage, including a run deadline or required
  input failure; and
- `4`: caller cancellation or interruption.

The outer `config apply` request remains schema version `1`. Its embedded
`config` union accepts versions 1 through 7, validates the expected CAS
revision first, then migrates and atomically writes configuration version 7.

## Binding invariants

1. Every run has a finite, inspectable absolute deadline.
2. Queueing, probing, retries, backoff, continuation, adjudication, and
   fallback consume the same run and logical-lens budgets; none resets them.
3. Suite heartbeats continue until the terminal event or caller cancellation.
   An individual reviewer timeout cannot stop suite liveness.
4. A logical lens cannot pass cleanly unless its required changed-file
   coverage is complete.
5. Reviewer claims cannot override Review Mesh-observed file access failures.
6. Accepted reviewer content is never silently shortened. Output bounds are
   declared before generation; exhaustion is an explicit incomplete outcome.
7. Gate outcome and coverage outcome remain independent, but the primary
   headline is coverage-first.
8. Every non-gating canonical finding has explicit machine-readable exclusion
   reasons.
9. Raw findings remain immutable inputs. Consolidation creates roots and
   subfindings without erasing distinct failure modes.
10. Explicit provider quorum and topology choices remain exact. Warnings do
    not change policy or exit status.
11. The immutable artifact remains authoritative and strictly readable by the
    same binary that produced it.
12. Concise output reduces live noise by referencing the detailed artifact;
    explicit full output still delivers every accepted reviewer result.

## Deadline model

### Adaptive suite deadline

Configuration schema v7 adds:

```toml
[execution]
deadline_mode = "adaptive" # or "fixed"
run_deadline_ms = 1800000  # required only for fixed mode
no_progress_timeout_ms = 300000
```

`deadline_mode = "adaptive"` is the default for new and legacy configurations
when no v7 deadline policy is present. The chosen tier is deterministic from
the authoritative change context:

| Tier | Change-focused threshold | Run deadline |
| --- | --- | ---: |
| tiny | at most 3 files and at most 16 KiB of diff | 15 minutes |
| small | at most 10 files and at most 64 KiB of diff | 30 minutes |
| medium | at most 50 files and at most 512 KiB of diff | 60 minutes |
| large | anything larger, full review, or truncated scope | 90 minutes |

Both file and byte thresholds must match a tier. A truncated changed-file list
or diff always selects `large`; it never receives a smaller deadline because
the visible size is incomplete. Diff size is the UTF-8 byte length of the exact
captured, unredacted Git diff after successful bounded scope collection and
before it is sent through output sanitization. At an exact boundary the row is
inclusive; exceeding either the file or byte threshold advances to the next
tier. An explicit full review always selects `large`, including an empty or
path-filtered workspace.

Fixed deadlines are bounded from 60,000 milliseconds through 14,400,000
milliseconds. `describe`, `config effective`, `suite.resolved`, status, report,
and the dashboard expose the selected mode, tier, duration, absolute deadline,
and the inputs used to choose it.

Configuration loading and Git/context resolution occur before `run.started`.
They share a fixed 60-second preflight ceiling, while every individual Git
command retains its tighter command timeout. Preflight timeout or scope failure
is an exit-2 diagnostic and does not create a review run. After context
resolution, Review Mesh initializes the run artifact and emits `run.started`;
that timestamp begins the execution deadline. When the execution deadline
expires, Review Mesh stops admitting new work and aborts active provider work.
It then has the existing bounded `shutdown_grace_period_ms` to clean up,
persist terminal state, and emit `run.completed`. The grace period is not
reviewer execution time.

### Logical-lens and model budgets

Each logical lens gains an optional `lens_deadline_ms`. Its absolute deadline
is:

```text
min(run_execution_deadline_at, run_started_at + lens_deadline_ms)
```

If omitted, the run execution deadline is the lens deadline. Queue wait,
capability probe, provider semaphore wait, retry backoff, all model candidates,
focused adjudication, and fallback candidates consume this single lens budget.
V8's sum-of-model-timeouts deadline is removed.

Existing model `timeout_ms` remains a ceiling for one model candidate across
all of that candidate's retry attempts. `attempt_timeout_ms` remains a ceiling
for one attempt. An attempt receives the minimum of:

- remaining run time;
- remaining logical-lens time;
- remaining model-candidate time; and
- configured attempt time.

Continuation requests are part of the same attempt and never reset its clock.
A checkpoint retry is a new attempt but still consumes the remaining model,
lens, and run budgets.

### No-progress timeout

`no_progress_timeout_ms` defaults to five minutes and applies to an admitted
provider attempt only when the adapter declares observable progress support.
It accepts 1,000 through 3,600,000 milliseconds. The effective timer for an
attempt is the minimum of the configured value and the remaining attempt,
candidate, lens, and run budgets; if a budget expires first, normal abort
precedence names that budget rather than `no_progress_timeout`. All built-in
streaming and tool-using adapters must support observable progress. A command
adapter may advertise it only when its protocol emits stable, monotonically
new activity identities. A non-streaming request with no file tools or
incremental transport bytes is not subject to the no-progress timer and
remains bounded by the attempt deadline.
This limitation is surfaced in effective configuration and reviewer-started
data. Meaningful progress is one of:

- a completed Review Mesh-owned file-tool operation;
- newly received streaming response bytes;
- a newly completed structured result fragment or page;
- a provider response that advances from request admission to response body;
  or
- an adapter activity event that contains a new tool/result identity.

Repeated phase text, a heartbeat, or an identical activity message does not
reset this timer. On expiry the attempt ends with `no_progress_timeout`. The
failure is fallback-eligible. Circuit qualification remains adapter-specific
and is reported explicitly.

When multiple abort conditions become observable in the same scheduler turn,
terminal causality uses this precedence: caller cancellation, run deadline,
logical-lens deadline, model-candidate deadline, attempt deadline, then
no-progress timeout. The attempt records every simultaneously satisfied cause
for diagnostics, but exposes one primary terminal reason.

### Terminal reasons

Public event v6 uses this closed incomplete-reason enum:

- `adapter_unavailable`;
- `authentication_failed`;
- `model_unavailable`;
- `read_failure`;
- `queue_deadline_exceeded`;
- `probe_deadline_exceeded`;
- `attempt_deadline_exceeded`;
- `no_progress_timeout`;
- `lens_deadline_exceeded`;
- `run_deadline_exceeded`;
- `structured_page_limit_exceeded`;
- `result_page_too_large`;
- `output_truncated`;
- `provider_response_invalid`;
- `process_crashed`;
- `protocol_violation`;
- `invalid_result`;
- `result_too_large`;
- `persistence_failed`;
- `change_coverage_incomplete`;
- `cancelled`; and
- `unknown`.

Known v5 reasons normalize as follows: `timeout` retains its reported legacy
reason and maps to the most specific boundary available from attempt records,
or `attempt_deadline_exceeded` when none exists; `invalid_result` with failure
code `output_truncated` maps to `output_truncated`; other v5 reasons retain
their existing meaning under the corresponding v6 code. Unknown future values
fail strict reading.

Not-yet-started candidates skipped after a suite deadline use
`run_deadline_exceeded`; they are not described as policy exclusions.

## Liveness and heartbeat lifecycle

The suite heartbeat timer is owned by the run, not by any attempt. It starts
before lens admission and is cleared only after `run.completed` has been
written. Cancellation first aborts active work, then continues aggregate
heartbeats through bounded cancellation finalization, writes a cancelled
terminal artifact/event, and clears the timer. If the public stream has failed,
the artifact terminal record remains authoritative and the timer is cleared
after that record is durably finalized. Attempt timers are local variables and
may only abort their own attempt controller.

An active heartbeat entry contains:

- reviewer and logical-lens IDs;
- mode (`full_review` or `adjudication`);
- current attempt and maximum attempts;
- phase, including `probing`, `queued`, `reviewing`, `validating`,
  `continuing`, `retry_backoff`, and `finalizing`;
- attempt and lens elapsed time;
- run, lens, and attempt deadline remaining;
- last meaningful progress age; and
- the count of coalesced activity events since the preceding heartbeat.

The heartbeat has no prose transcript. Public `reviewer.progress` events are
emitted for phase transitions and material state changes; identical activity is
coalesced and reported by count. Such material progress events do not replace
or postpone the next scheduled suite heartbeat, so the liveness-gap guarantee
is measured between heartbeat records rather than between arbitrary events.

`heartbeat_interval_ms` remains configurable from 1,000 through 300,000
milliseconds and defaults to 30,000 in v7. In `concise-jsonl`, an unchanged
heartbeat emits only when the preceding public heartbeat is at least the
configured interval old; material state changes may emit immediately. Each
heartbeat is below 16 KiB, and the total serialized public heartbeat budget is
1 MiB per run. Reaching that byte budget switches to a minimal liveness record
containing sequence, timestamp, aggregate counts, and artifact reference; these
minimal records continue at the configured interval so liveness is never
silenced. The artifact retains the detailed bounded activity summary.

Default private activity persistence is bounded too. It retains phase changes,
the first and last event for each phase, file-access outcomes, provider request
and response boundaries, structured page/fragment completion, failures, and a
coalesced count for other activity. It stores at most 2,048 private activity
records or 1 MiB of serialized activity per run, whichever comes first. When a
limit is reached it retains terminal/material records, stops storing ordinary
activity, and writes one `reviewer.activity_summary` per reviewer containing
suppressed counts, first/last timestamps, and last meaningful progress. Raw
per-event activity is available only with `diagnostics.activity_detail =
"full"`; full mode is still capped at 16,384 records and 8 MiB, and overflow is
reported explicitly rather than silently truncated.

`emitFinal` cancels an optional heartbeat that has not started and waits for an
already-started optional write within shutdown grace. It writes a private
`run.terminal_summary` containing intended public delivery mode, then the
digest-bearing `run.artifact_terminal`, closes and hashes the artifact, updates
the run index, and only then emits the public `run.completed` line. The mutable
run index records the observed final-public-write outcome after that write;
artifact-derived views label the immutable field `planned_public_stream` and
use the index's `observed_public_stream` when available. Event-v6
`run.completed` is never mirrored back into an artifact-format-2 file, avoiding
both digest recursion and a post-terminal record. No public event may appear
after `run.completed`. If the final public write fails, the indexed artifact is
authoritative and the CLI reports the stream failure on stderr without
reopening or modifying the artifact.

## Changed-file evidence coverage

### Lens relevance policy

Every schema-v7 logical lens declares a `change_coverage` policy:

```toml
[agents.example.change_coverage]
relevant_paths = ["src/**", "tests/**"] # ["**"] means all changed paths
minimum_inspection = "full_file"         # or "diff"
proof = "observed"                       # or "attested"
```

`relevant_paths` selects the authoritative changed paths for which this lens is
responsible. It is independent of `applicability`: applicability decides
whether a lens runs; change coverage decides what a running lens must inspect.
A profile with no relevant path match is `not_applicable`, not a clean pass.

New profiles default to `relevant_paths = ["**"]`,
`minimum_inspection = "full_file"`, and `proof = "observed"`. Migration derives
relevant paths from an existing `changed_paths` applicability policy when one
exists, otherwise `["**"]`. It uses the v9 `full_file` and `observed` defaults;
this is a deliberate strengthening of clean-review semantics.

`minimum_inspection = "diff"` accepts inspection of the complete untruncated
diff hunk for the path when core verifies that those exact diff bytes were
included in the provider request; this proves evidence delivery, not model
attention, and the ledger labels the method `diff_delivered`. With observed
proof, `full_file` requires the current changed file to be read through Review
Mesh-owned bounded file tools in addition to the diff. For every successful
tool response, core records the exact returned byte offset, byte count, and
SHA-256 of those bytes. The union of verified response chunks must cover the
complete identity-pinned snapshot with no gaps, and deterministic reconstruction
must equal the pinned snapshot digest; overlapping chunks must agree byte-for-byte,
and ranges reported without matching response bytes never count. One
partial/chunk read is insufficient. With
attested proof, `full_file` means the opaque adapter asserts a complete snapshot
read and supplies the exact core-pinned snapshot digest; the ledger labels this
attested and never represents it as core-observed. Deleted files are covered by
the complete base-to-head diff and are labelled `deleted_diff`.

`proof = "observed"` requires Review Mesh to mediate the file read and hash the
response bytes itself. All built-in v9 adapters with Review Mesh-owned file
tools must provide this capability. Command-protocol v2 may add bounded
`file_access` claims and a coverage attestation, but an external process reading
files directly remains `attested`; protocol v1 has neither claim and is legacy
attested-only. A future command adapter may advertise observed proof only if
all file reads are delegated through a Review Mesh-owned broker. Capability
preflight rejects a configured proof mode that the selected adapter cannot
supply before provider contact. `attested` permits reviewer self-attestation
for explicitly accepted opaque runtimes and is reported as weaker evidence.

### Authoritative ledger

Review Mesh creates a run-owned coverage ledger for every selected lens and
every authoritative changed path. Each entry first records `relevant: true` or
`false` and the matching policy reference. A non-relevant path has disposition
`policy_excluded`; it remains visible in coverage accounting but has no
inspection obligations. Each relevant path instead carries explicit evidence
obligations and their independently recorded states:

- `snapshot_read`: `satisfied`, `not_required`, `unavailable`, `oversize`,
  `binary`, or `not_inspected`;
- `diff_delivery`: `satisfied`, `not_required`, `context_truncated`,
  `unavailable`, `binary`, or `not_inspected`; and
- overall disposition: `satisfied` or `deficit`.

For a tracked, modified or added text path, `full_file` requires both a complete
snapshot read and complete diff delivery. Under observed proof, the snapshot is
the verified gap-free reconstruction; under attested proof, it is the
digest-matched self-attestation described above. An untracked path has no base
diff and therefore requires the proof-mode-appropriate complete snapshot read
only. A deleted path requires complete deleted-file diff delivery and no
snapshot read. `diff` requires complete diff delivery for tracked paths and a
complete snapshot read for untracked paths. A relevant binary or oversize file
is a deficit unless the lens policy explicitly excludes it by path before the
run; reviewers cannot invent a binary/size exclusion. `policy_excluded` is
core-derived from configured globs and includes the policy reference.

Tool failures are recorded once by normalized path and reason. Partial reads do
not satisfy `snapshot_read`. Diff or changed-file truncation makes the relevant
`diff_delivery` obligations, and therefore all affected lenses, incomplete.

The private artifact stores one coverage ledger per completed reviewer result,
in chunked `reviewer.coverage` records with at most 256 path entries per record.
The run also derives a lens union for diagnostics, but the union never converts
partial reviewer results into a clean quorum. Public events contain counts, a
SHA-256 ledger digest, a bounded sample of deficits, and the artifact reference
rather than copying thousands of paths.

### Reviewer result v4 coverage result

Reviewer result v4 adds a core-owned `change_coverage` result:

```json
{
  "status": "complete",
  "proof_kind": "observed",
  "scope_digest": "64-lowercase-hex",
  "inspected_count": 5,
  "deficit_count": 0,
  "deficit_sample": []
}
```

For a changes review, `scope_digest` is SHA-256 over the UTF-8 encoding of a
fixed-key-order JSON object containing: `schema_version`, the SHA-256 of the
captured diff bytes, the sorted normalized authoritative changed paths, and for
each path its lens relevance, required inspection method, and proof policy.
Paths use `/`, are workspace-relative, Unicode NFC normalized, and sorted by
Unicode code point. The same serializer is used by adapters and core.

For `proof_kind = "observed"`, the provider does not emit this field. Review
Mesh computes and injects it after assembling provider content and reconciling
the result-specific ledger. Core file-access telemetry is authoritative.

For `proof_kind = "attested"`, page zero instead carries a provider
`coverage_attestation` containing the same scope digest and a canonical array
of `{ path, method, snapshot_digest }` entries sorted by normalized path.
`method` is `full_file`, `diff`, or `deleted_diff`; `snapshot_digest` is
required when the method includes a snapshot read and absent for diff-only
evidence. Review Mesh verifies exact path/method set equality and digest format.
For every snapshot-read entry it requires equality with the core-pinned
snapshot digest; for diff-only entries it verifies the core-delivered diff
obligation. It then converts the attestation into the core-owned final field and
retains both values privately. Attested mode cannot claim observed proof and
supports at most 256 relevant paths; a larger opaque review is explicitly
incomplete rather than silently sampled.

A provider-supplied final `change_coverage` field, mismatched scope digest, or
incorrect attested set makes the provider result invalid. `deficit_sample` is
core-derived, contains at most eight entries, and points to the full ledger.

A syntactically valid `pass` with an unsatisfied ledger is persisted for
diagnosis as a completed result, followed by a reviewer terminal status of
`incomplete` with reason `change_coverage_incomplete`; it does not count as a
clean pass. Every reviewer result that contributes to pass quorum must
individually satisfy every relevant path. Disjoint partial inspection across
three reviewers cannot satisfy a 3-of-5 clean quorum. A finding result remains
visible while its logical lens and overall run coverage are partial. A finding
can remain gate-eligible when its own cited evidence and causal changed path are
observed; it receives `source_coverage_unverified` only when that evidence
coverage is absent, not merely because an unrelated relevant path was unread.

Each changes-scoped finding must cite at least one relevant changed path, or
its `change_impact` must cite a changed path and explain the causal effect on an
unchanged dependency. Findings against unrelated pre-existing code are
classified as out of scope.

### Coverage dimensions

V9 reports two explicit dimensions:

- `execution_coverage`: whether selected lenses reached their configured
  quorum or adjudicated terminal state; and
- `change_coverage`: whether each terminal lens satisfied its relevant path
  ledger.

Overall `coverage_outcome` is `complete` only when both are complete. Missing
required input, infrastructure failure, scope truncation, legacy-unknown
coverage, and unread relevant paths all make it `partial`.

Execution coverage for a lens is complete when it reaches pass quorum, or when
a valid finding result terminates the lens and no adjudication is required, or
when every required adjudication candidate receives a complete terminal
decision. Candidates intentionally skipped by an explicit
`short_circuit_after_finding` policy are policy-satisfied and appear in the
skip ledger; they are not incomplete executions. A required adjudicator that
times out, returns invalid output, or omits any candidate decision makes
execution coverage partial even when known findings remain visible.

For an explicit full review, `change_coverage.status` is `not_applicable` and
satisfies the change-coverage dimension; execution coverage alone determines
overall completeness. `legacy_unknown` is partial only for historical
change-scoped artifacts. Retry inheritance may satisfy coverage only by linking
and digest-verifying completed parent reviewer ledgers for the same scope and
policy; otherwise the retry result must inspect the paths itself.

## Bounded structured result production

### Reviewer result v4

Reviewer result v4 retains `verdict`, `review_markdown`, `summary`, structured
findings, informational notes, and the new coverage claim. Each finding also
adds a structured atomic claim:

```json
{
  "claim": {
    "trigger": "condition that activates the issue",
    "affected_behavior": "operation or contract that changes",
    "outcome": "observable wrong result"
  }
}
```

The provider-facing schema declares bounds before generation:

- 16 MiB maximum for the complete assembled sanitized reviewer result,
  including lossless `review_markdown`;
- 1 KiB summary;
- at most 16 actionable findings across all pages;
- at most two findings per finding page;
- at most three evidence entries per finding;
- 256-byte finding IDs, root IDs, duplicate references, and titles;
- at most eight duplicate-finding IDs;
- 768-byte trigger, affected-behavior, outcome, and description fields;
- 1 KiB workspace-relative evidence paths;
- 512-byte evidence details;
- 768-byte suggested directions, verification text, and change impact;
- at most four assumptions of 256 bytes each; and
- at most four informational notes with a 256-byte title and 1 KiB body.

These are admission limits in reviewer result v4, not post-generation
truncation rules. A value outside them is never shortened into acceptance.
V9 preserves v8's lossless legal-result contract, including the acceptance
fixture with a 13 MiB `review_markdown`; prompt guidance asks for concise prose
but does not turn that guidance into a smaller schema limit.

Every serialized result page has a hard 32 KiB UTF-8 limit, checked before
schema acceptance. Oversize output fails as `result_page_too_large`; the
diagnostic spool retains the received bytes. The assembled sanitized result
retains the existing 16 MiB absolute safety limit.

### Semantic result pages

All adapters finalize through a shared bounded page collector. Each page uses
this envelope:

```json
{
  "schema_version": "1",
  "kind": "review-mesh.result-page",
  "result_id": "core-supplied-random-id",
  "result_kind": "reviewer",
  "result_schema_version": "4",
  "page_index": 0,
  "page_count": 3,
  "page_kind": "header",
  "previous_page_digest": null,
  "payload": {}
}
```

For `result_kind = "reviewer"`, page zero has `page_kind = "header"` and
contains summary, informational notes, declared narrative byte count and
fragment count, declared actionable-finding count, and an attestation entry
count/digest in attested mode. It contains neither attestation entries,
narrative, nor findings. Attested results next use contiguous `coverage` pages,
each containing one to 16 canonical attestation entries while also satisfying
the serialized page limit. Contiguous `narrative` pages follow and each
contains one `text_fragment` of at most 24 KiB UTF-8. Concatenating fragments
in page order produces the exact `review_markdown`. Contiguous `findings` pages
follow and contain at most two new findings each. Observed results declare zero
coverage pages; a narrative of zero bytes declares zero narrative pages.

For `result_kind = "adjudication"`, page zero contains a narrative of at most
16 KiB, a 1 KiB summary, at most four bounded informational notes, the candidate
count, and a digest of the ordered candidate IDs, but no full candidate list or
decisions. Later pages have `page_kind = "decisions"` and contain at most four
new adjudication decisions for the exact candidate IDs supplied by core for
that page. Adjudication result schema v2 requires one decision for every
candidate and may also contain explicit atomic-duplicate relationship decisions
used by canonicalization. Before adjudication, Review Mesh performs only
deterministic exact candidate coalescing: findings with identical atomic
signatures and overlapping evidence may share one adjudication decision. An
explicit duplicate reference may join that candidate only when it independently
passes the same compatibility rule; otherwise it remains distinct. All source
finding IDs stay attached to their candidate. Review Mesh does not use semantic
similarity to reduce candidates. Every distinct atomic candidate is retained
and adjudicated in deterministic canonical order.

Reviewer `page_count` is between 1 and 951: one header, at most 256 attestation
pages, at most 686 narrative pages, and at most eight finding pages. This
provides 16 MiB plus bounded JSON-escaping margin of raw narrative-fragment capacity and allows the
attested-mode maximum even when long escaped paths force one entry per page;
the complete assembled result's 16 MiB limit is still authoritative, so
envelope capacity does not enlarge the accepted result. Adjudication
`page_count` is between 1 and 65: one header plus at most 64 decision pages,
which covers the schema-v2 maximum of 256 distinct candidates. If exact
duplicate collapse still leaves more than 256 candidates, the lens ends
`structured_page_limit_exceeded`; no candidate is silently excluded from
gating.

The core supplies `result_id`, expected `page_index`, and the SHA-256 digest of
the preceding page's exact UTF-8 bytes in each continuation prompt. The model
must echo them. For adjudication decision pages it also supplies the exact
ordered candidate IDs assigned to that page; the page must return one decision
for each and no others. Page zero uses `previous_page_digest = null`; later
pages must match the supplied digest. All pages repeat the same `page_count`.
The last page is exactly `page_count - 1`; there is no separate free-form
completion marker.

Assembly rejects an unexpected result ID/kind/version, index gap, duplicate
index, changed page count, broken digest chain, illegal page-kind ordering,
repeated finding or candidate ID, attestation count/digest mismatch, narrative
byte/fragment mismatch, finding/decision-count mismatch, missing final page,
or any page after the final index. `assemblePages` concatenates attestation
entries and narrative fragments exactly, then findings or decisions by
ascending page and array order, and validates one reviewer result v4 or
adjudication result v2 object. Sanitization occurs once on that assembled
object. Its canonical digest and serialized object are identical in
orchestration, full JSONL, the artifact, report, findings, status, and
dashboard. Raw valid pages and their exact digests remain in the diagnostic
spool.

Transport-level `finish_reason = "length"` still uses exact fragment
continuation for the current page. The continuation request must not repeat,
rewrite, or condense received bytes. It is bounded by the same attempt, lens,
and run deadlines. If exact continuation cannot finish the page, the reviewer
ends as `output_truncated`; partial JSON is never accepted as a pass.

The artifact stores any assembled narrative larger than 24 KiB in ordered,
chunked private `reviewer.narrative` records referenced by the reviewer-result
record; narratives at or below 24 KiB remain inline. These records are part of
the accepted result, not optional supplemental reasoning. Strict readers
reconstruct and verify the full `review_markdown`; `full-jsonl` emits the same
reconstructed result and digest without shortening it.

## Outcome semantics

Public event v6 replaces the ambiguous primary status with:

- `run_outcome`: `clear`, `gate_findings`, `inconclusive`, or `cancelled`;
- `gate_outcome`: `no_gate_findings` or `gate_findings`; and
- `coverage_outcome`: `complete` or `partial`.

Precedence is:

1. caller cancellation -> `cancelled`;
2. partial coverage -> `inconclusive`;
3. complete coverage with gate findings -> `gate_findings`; and
4. complete coverage without gate findings -> `clear`.

This means a partially covered run with known gate findings is headlined as
inconclusive while still exposing `gate_outcome = gate_findings` and the exact
gate count. Human rendering leads with a single sentence such as:

```text
Inconclusive: partial coverage; 0 gate findings; 11 non-gating subfindings; 2 lenses incomplete.
```

`non_gating_subfindings` is the sum of advisory, rejected,
needs-verification, out-of-scope, and policy-non-gating atomic subfindings. It
is never labelled simply `advisories`; the component counts remain separately
available.

V9 replaces the ambiguous `results_complete` boolean with:

```json
{
  "result_delivery": {
    "completed_results": 26,
    "artifact": "complete",
    "planned_public_stream": "references_only"
  }
}
```

`artifact` is `complete`, `not_requested`, or `failed`.
`planned_public_stream` is `complete` or `references_only`. The immutable
terminal summary and the public `run.completed` event store only that planned
value because success or failure of writing the terminal line is knowable only
after its JSON has been constructed. The run index separately stores
`observed_public_stream` as `complete`, `references_only`, or `failed` after the
write. Artifact-derived views expose the observed field only when joined with a
verified index entry; a directly supplied orphan artifact labels it unavailable
rather than guessing. Concise and compact modes require `artifact = complete`
and plan `references_only`. Every v9 run also requires `artifact = complete` in
full mode; full mode plans `complete`. `not_requested` is retained only when
normalizing a historical artifact whose run did not request persistence. A
cancelled run uses the same fields for the results completed before
cancellation. With zero completed results, the artifact channel is `complete`
when its terminal record was successfully finalized. These fields describe
result delivery only, never review coverage.

### Gate eligibility reasons

Gate eligibility is orchestrator-derived. Every canonical subfinding contains:

```json
{
  "gate_eligibility": {
    "eligible": false,
    "reasons": ["confidence_below_threshold"]
  }
}
```

An eligible finding has an empty reason array. A non-eligible finding has one
or more of these stable reason codes:

- `classification_not_confirmed`;
- `severity_below_threshold`;
- `confidence_below_threshold`;
- `adjudication_required`;
- `adjudication_rejected`;
- `evidence_unverified`;
- `ordered_proof_missing`;
- `change_impact_unverified`;
- `source_coverage_unverified`;
- `out_of_scope`; or
- `policy_non_gating`.

Reports may add explanatory text, but consumers key on the code. Model output
cannot set this structure.

## Canonical findings and semantic grouping

### Atomic findings

Every reviewer finding remains an immutable source finding. V9 derives an
atomic signature from:

- normalized trigger;
- normalized affected behavior;
- normalized outcome;
- category; and
- sorted evidence anchors consisting of path and line range.

Normalization uses Unicode NFKC, lower-casing, punctuation-to-space, and
collapsed whitespace. Arrival order is never an input.

Two source findings collapse into one atomic subfinding only when their atomic
signatures are identical and they have at least one identical or overlapping
evidence anchor. Explicit duplicate metadata is a proposal, not sufficient
proof: it collapses only when the same structural compatibility test passes or
an adjudicator explicitly confirms the duplicate relationship. A duplicate ID
that resolves but conflicts in trigger, affected behavior, outcome, or evidence
is retained as `conflicting_duplicate_claim` and both atomics remain distinct.

### Roots and subfindings

`root_issue_id` groups atomic subfindings under one canonical root; it no
longer unions them into one finding. Thus a shared root can retain distinct
concurrency, metadata, compatibility, and cleanup failure modes with separate
evidence, remediation, severity, and gate eligibility.

For any pair of distinct atomic findings not already in the same root, a
deterministic relatedness proposal may suggest a display association when:

- their category matches;
- they share a path or overlapping evidence anchor; and
- at least two of trigger, affected behavior, and outcome have token Jaccard
  similarity of at least 0.75, or all three have similarity of at least 0.85.

Tokenization applies the same NFKC/lowercase/punctuation/whitespace
normalization, then splits on spaces; there is no stop-word list. Similarity is
set Jaccard similarity. The calculation is pairwise only and non-transitive.
Each proposal contains the two atomic signature IDs in lexical order plus its
three field scores.

This relation is labelled `semantic_proposal`. It may let a UI place
stale-documentation variants next to each other, but it does not create a
canonical root, change root counts, collapse atomic subfindings, or change any
subfinding's gate eligibility. An explicit duplicate relation or adjudicated
duplicate decision that passes the structural compatibility rule is required
to collapse them. Semantic proposals are sorted
by their pair of atomic IDs and are a separate derived array. A proposal may
connect a rootless atomic to an atomic already displayed under a root; it names
both atomics and the existing root for presentation only. UI text calls these
"related findings", never "deduplicated findings", because counts are
intentionally unchanged.

Canonical output reports separately:

- raw source findings;
- atomic subfindings after exact duplicate collapse;
- canonical roots;
- gate-eligible subfindings;
- advisory subfindings;
- rejected subfindings; and
- needs-verification subfindings.

Public event v6 and report v2 use exactly these count fields:

- `raw_source_findings`;
- `atomic_subfindings`;
- `canonical_roots`;
- `gate_eligible_subfindings`;
- `advisory_subfindings`;
- `rejected_subfindings`; and
- `needs_verification_subfindings`.

V6 does not reuse `unique_findings`. A normalized v5 artifact retains its
reported `unique_findings` under `reported_counts` and derives the v9 count
fields from preserved source findings.

`findings --deduplicate` returns canonical roots containing `subfindings[]`.
Live aggregation, report, findings, status, and dashboard use the same module
and produce identical counts and ordering.

## Concise live output and detailed artifacts

V9 adds the event-v6 `concise-jsonl` mode and makes it the default. Event-v5
output contracts remain frozen in v8 binaries; v9 does not offer an option to
emit v5 events.

- `concise-jsonl` emits bounded context, suite resolution, material phase
  transitions, aggregate heartbeats, reviewer terminal summaries, and a compact
  `run.completed` containing counts, concise lens summaries, exclusions,
  warnings, and one artifact reference.
- `compact-jsonl` is the event-v6 successor to v8 compact mode: it emits every
  lifecycle and material progress event without full reviewer result payloads.
- `full-jsonl` emits every accepted reviewer result v4 and its digest in the
  original invocation. Result payloads are never coalesced or shortened.

The detailed immutable artifact is required for every v9 output mode.
With `diagnostics.persist_runs = true`, the managed run artifact is
authoritative and `--details-file` is an optional verified copy. With
`diagnostics.persist_runs = false`, an exclusive `--details-file` is required
before `run.started`: Review Mesh identity-pins an internal staging file and
the requested target, finalizes the artifact, publishes it without overwrite,
verifies exact bytes, and indexes the external target path, file identity,
digest, and size as the authoritative artifact. Only then may it remove staging.
Status, report, findings, retry, and dashboard resolve that indexed external
path and reverify its identity and digest. If the user later removes or replaces
it, readers return `artifact_unavailable` or `artifact_identity_changed` rather
than falling back to stale staging. Missing `--details-file`, publication
failure, or verification failure prevents a successful terminal claim and
exits 3.

The v6 terminal artifact reference is one object:

```json
{
  "path": "...",
  "sha256": "...",
  "byte_count": 123456,
  "completed_results": 26
}
```

The SHA-256 value covers the finalized artifact's exact UTF-8 bytes after the
terminal record and trailing newline are written. Because the artifact cannot
contain its own final byte digest without recursion, the digest is published in
the terminal public event, authoritative `--details-file` publication metadata
when applicable, and the run index. Strict readers verify it when supplied; the
artifact's internal `run.artifact_terminal` instead stores the content digest
immediately before that terminal line.

Per-result digests remain inside the artifact and in full `reviewer.result`
events. `run.completed` no longer repeats the same artifact path for every
reviewer.

Concise events use deterministic bounded lists. Each ID or reason string is at
most 128 UTF-8 bytes. `run.completed` includes at most eight lens summaries,
eight exclusions, eight warnings, and eight deficit samples; heartbeats include
at most eight active entries. When more exist, the event carries the total,
`omitted_*_count`, a SHA-256 digest of the complete canonical array, and the
single artifact reference. An individual protocol value is rejected rather
than silently shortened. For a 40-model suite, the concise terminal event and
each heartbeat must remain below 16 KiB.

Rich provider diagnostics, response structure, correlation headers, detailed
activity, exact attempt history, result pages, and coverage path chunks remain
private records. Public incomplete events contain the stable reason, failure
stage, attempt counts, retry/fallback disposition, and one `detail_ref`.

## Change-readiness prerequisites

Schema v7 adds a declared lens `kind`. Supported initial values are `generic`
and `change_readiness`. Review Mesh never infers this kind from a lens ID,
purpose, or prompt text.

A schema-v7 lens uses `required_input`, whose JSON Pointer selectors traverse a
normalized object containing `request`, including typed `pull_request`, and
legacy `context`. Migration rewrites every v6 `required_context = ["/x"]` entry
as `required_input = ["/context/x"]`, preserving its meaning.

A `change_readiness` lens must declare all standard selectors in
`required_input`:

- `/request/pull_request/id`;
- `/request/pull_request/url`;
- `/request/pull_request/title`;
- `/request/pull_request/description`;
- `/request/pull_request/work_items`;
- `/request/pull_request/validation`;
- `/request/pull_request/contract_impact`.

Configuration validation rejects a v7 change-readiness profile that omits one.
The TUI populates these selector names in the lens configuration, and
documented request templates show caller-supplied metadata placeholders. No
tool populates PR values from a remote service.

Review request v3 adds this strict optional field:

```json
{
  "pull_request": {
    "id": "16936099",
    "url": "https://dev.azure.com/example/project/_git/repo/pullrequest/16936099",
    "title": "...",
    "description": "...",
    "work_items": [
      {
        "id": "12345",
        "url": "https://dev.azure.com/example/project/_workitems/edit/12345",
        "title": "Optional bounded title"
      }
    ],
    "validation": [
      {
        "name": "unit tests",
        "status": "passed",
        "details": "521 tests passed",
        "url": "https://dev.azure.com/example/build/results"
      }
    ],
    "contract_impact": {
      "status": "none",
      "summary": "No published contract changes.",
      "references": []
    }
  }
}
```

The `pull_request` object rejects unknown keys. ID is a 1-to-128-byte string.
URLs are 1-to-2,048-byte absolute HTTPS URLs with no user information. Title is
limited to 512 bytes and description to 32 KiB. `work_items` contains at most
100 strict objects with required ID and optional URL/title under the same
bounds. `validation` contains at most 100 strict objects with a name of at most
256 bytes, status `passed`, `failed`, or `not_run`, optional details of at most
2 KiB, and optional HTTPS URL. `contract_impact.status` is `none`, `changed`, or
`unknown`; summary is required and limited to 8 KiB; references contains at
most 32 workspace-relative changed paths or HTTPS URLs, each at most 2 KiB.
`status = none` is a caller declaration, not evidence, and the readiness lens
must compare it with the captured diff.

Empty work-item, validation, or reference arrays mean the caller explicitly
supplied no entries. JSON type, object-shape, and total request-size violations
are invalid requests and exit 2 before the run. Absent fields, empty required
strings, a non-HTTPS/malformed URL, or an invalid workspace-relative reference
produce selector-level `missing_required_input` or `invalid_required_input`
diagnostics for the readiness lens.

If any required selector is absent or value-invalid, the lens becomes
`not_evaluated_missing_input` before capability probing. It makes zero provider
calls and lists every exact selector with its missing/invalid code. Other
lenses continue. Because a selected required lens was not evaluated, overall
coverage is partial and the run exits 3.

Review Mesh sanitizes and provenance-labels supplied metadata as
`caller_supplied`. It does not derive a description from the branch name, ask a
model to invent metadata, or contact Azure DevOps/GitHub in v9. Metadata
presence is not correctness: the reviewer must compare it with the captured
change context.

## Provider topology and resilience

V9 preserves v8's config-time protections:

- concentrated multi-provider primaries require
  `allow_provider_concentration = true`; and
- zero provider-outage tolerance requires each affected lens to set
  `allow_zero_outage_tolerance = true`.

These acknowledgements remain validation gates, not warnings. Once explicitly
acknowledged, the exact policy runs unchanged. Review Mesh never silently
changes 5-of-5 to 3-of-5.

New five-model configurations continue to default to three clean passes from
three provider groups and distributed primaries. Legacy migration preserves
explicit model order, quorum, provider-group minimum, concentration setting,
and acknowledgement.

Normal `review` preflight now emits resolved topology diagnostics before
provider contact. Stable warnings include:

- `provider_concentration`;
- `zero_outage_tolerance`;
- `single_failure_makes_quorum_unreachable`; and
- `provider_concurrency_amplification`.

Each warning states whether it was acknowledged and names affected lenses and
provider groups. Warnings are exposed by `describe`, effective config,
`suite.resolved`, `run.completed`, status, report, and dashboard. They do not
change exit status.

## Shallow and incomplete Git history

Change-scope resolution runs `git rev-parse --is-shallow-repository` before
merge-base collection and retains the command result in sanitized diagnostics.

The decision tree is:

1. A shallow repository whose requested or inferred base ref is unavailable
   produces `git_history_incomplete` with subtype `base_ref_unavailable`.
2. A non-shallow repository whose requested or inferred base ref is
   unavailable produces `review_base_unresolvable`.
3. When both refs resolve but a shallow repository has no merge base, the
   result is `git_history_incomplete` with subtype
   `merge_base_unavailable`.
4. When both refs resolve in a non-shallow repository but have no merge base,
   the result is `merge_base_unresolvable`.
5. A later diff, status, or path collection failure produces
   `change_scope_collection_failed`.

`git_history_incomplete` includes shallow status, requested and resolved refs,
and safe checks such as:

```text
git rev-parse --is-shallow-repository
git cat-file -e <base>^{commit}
git merge-base <base> <head>
```

Requested/ref strings in public diagnostics are sanitized and bounded to 512
UTF-8 bytes. Raw Git stderr is never published; a redacted 1 KiB excerpt and
SHA-256 fingerprint may be retained privately. The diagnostic explains that
the caller may fetch/deepen the required history according to repository
policy, without running a fetch or prescribing a destructive reset. A shallow
clone with sufficient ancestry is accepted. Full-review mode does not require
a merge base and remains available only when explicitly requested.

## Persistence, normalization, and derived views

V9 introduces one central version-dispatch and normalization layer used by
status, report, findings, retry, and dashboard. It replaces separate
hand-normalization paths. `review`, `status`, `report`, `findings`, `retry`, and
the dashboard receive the run-index digest when they resolve an artifact and
perform finalized-byte verification. A directly supplied orphan artifact with
no external digest remains strictly schema/content-digest validated and is
reported as `final_digest_unavailable`, not falsely called byte-verified.

Every v9 artifact begins with a strict `run.artifact` header containing
`artifact_format_version = "2"`, tool version, run ID, creation timestamp, and
the allowed private-record schema versions. It ends with a private terminal
`run.artifact_terminal` containing the exact SHA-256 of every preceding
artifact byte, excluding the terminal line itself. Immediately before it,
`run.terminal_summary` stores the terminal run state without the finalized-file
digest. Public event-v6 `run.completed` is deliberately not mirrored into a
format-2 artifact; readers derive the equivalent public view from the private
summary plus the indexed final digest. The dispatcher validates each
private record type independently: `resolution`, `request`, `context`,
`reviewer.attempt`, `reviewer.activity`, `reviewer.activity_summary`,
`reviewer.coverage`, `reviewer.result_page`, `reviewer.narrative`,
`reviewer.result`, `reviewer.terminal`, allowed nonterminal public-event mirror,
`run.terminal_summary`, and `run.artifact_terminal`. Headerless v8 artifacts are
format 1 and dispatch through the existing event-v4/v5 and private-record
parsers.

Strict readers accept known historical versions and reject a future version
with `unsupported_schema_version`. `--best-effort` may salvage independently
valid records, marks coverage partial, and lists warnings; it is not a
same-version compatibility workaround.

Legacy artifacts without path coverage normalize to
`change_coverage.status = "legacy_unknown"`. Their original reported outcome is
retained under `reported_outcome`, but their normalized v9 coverage is partial
and they cannot be reused as proof of a clear v9 gate.

Run report v2, status v3, and dashboard payload v2 expose:

- run, gate, and coverage outcomes;
- execution and change-coverage dimensions;
- deadline selection and remaining time for active runs;
- topology warnings;
- complete exclusion/skip ledgers;
- gate-eligibility reasons;
- canonical roots and atomic subfindings; and
- the single immutable artifact reference.

Markdown and dashboard headlines always render `run_outcome` first. A report
with advisory findings never says “No findings were available.”

## Doctor parity

`doctor --structured-output` continues to use the real reviewer mechanism
against a Review Mesh-owned synthetic workspace. In v9 it exercises the
selected model and effort, streaming negotiation, bounded read tools,
file-access telemetry, result-page protocol, exact fragment continuation,
retry/backoff, no-progress handling, attempt/lens deadline calculation, result
v4 validation, sanitization, and digesting.

Doctor reports authentication/model readiness, progress-observability support,
streaming negotiation, changed-file access, page production and assembly,
coverage reconciliation, and schema validation as separate stages. Failures
use the same typed reason/stage, sanitized provider diagnostics, attempt count,
and artifact detail reference as a real run. A synthetic file-access failure
cannot be mislabeled as structured output, and doctor success cannot bypass the
v9 coverage ledger.

## Configuration migration

Review Mesh reads config versions 1 through 7. It does not rewrite a config
during review, describe, doctor, status, or report. A successful user-initiated
TUI save or `config apply` writes schema v7 atomically.

Migration rules are:

1. preserve reviewer roster, instructions, models, effort, provider groups,
   topology acknowledgements, quorum, applicability, and gate thresholds;
2. add the adaptive suite deadline and five-minute no-progress timeout when no
   v7 deadline policy exists;
3. derive lens relevance from existing changed-path applicability or `["**"]`,
   use `full_file`, and choose `observed` only for a built-in adapter whose
   reads are mediated and hashed by Review Mesh; migrate command-protocol v1,
   command-protocol v2 without a Review Mesh-owned read broker, and other
   opaque adapters to `attested` with a stable upgrade warning;
4. set undeclared lens kind to `generic`; never infer change-readiness from its
   name;
5. preserve explicit strict 5-of-5 behavior and surface its warnings; and
6. report every derived value through `config effective` before saving.

An explicit v7 `proof = "observed"` paired with an adapter that lacks the
observed-read capability is a preflight configuration error, not an automatic
downgrade. Command-protocol v2's access claims improve attested diagnostics but
do not become observed evidence merely by using the newer envelope.

The adaptive deadline and changed-file proof requirements are intentional v9
behavior changes. They are not hidden: legacy configurations receive stable
`implicit_v9_deadline`, `implicit_v9_change_coverage`, and, where applicable,
`attested_coverage_requires_adapter_upgrade` warnings until saved as v7. A
user-initiated v7 save shows the derived proof mode and requires confirmation
before persisting it.

The `fo-change-readiness` profile captured in the motivating artifact may be
updated to `kind = "change_readiness"` only as an explicit deployment step
after the v7 config is validated. Source migration does not guess about the
current machine or other unknown profiles.

## Security and resource handling

- File-access telemetry contains normalized workspace-relative paths and
  bounded status data, never file contents beyond the existing sanitized
  evidence contract.
- Caller metadata and provider diagnostics use existing credential redaction.
- Result pages and narrative spools remain outside the reviewed workspace, use
  owned handles, and follow bounded stale cleanup.
- Coverage paths are verified against the pinned workspace root; symlink and
  TOCTOU protections remain mandatory.
- Deadline cancellation invokes bounded adapter cleanup and cannot extend the
  run by another reviewer timeout.
- Public concise output never contains provider response bodies, raw config,
  credentials, or private activity transcripts.
- An output, persistence, or digest failure prevents a successful terminal
  claim.

## Release acceptance criteria

1. A fake-clock reproduction of the v8 heartbeat bug times out one attempt,
   starts a retry and fallback, and emits aggregate heartbeats throughout with
   no gap greater than one interval plus scheduler tolerance.
2. The five-file, 23,285-byte fixture selects the 30-minute adaptive deadline;
   no provider, retry, continuation, or adjudicator can run beyond it plus
   shutdown grace.
3. Queue and semaphore wait consume lens time, and terminal reasons identify
   the exact exhausted boundary.
4. Repeated activity without new bytes or tool results triggers the configured
   no-progress timeout and permits an eligible fallback, while a declared
   non-observable non-streaming call remains governed by its attempt deadline.
   Schema validation rejects values below 1,000 or above 3,600,000
   milliseconds, and simultaneous expiry follows the declared abort precedence.
5. A reviewer that returns `pass` after relevant Worker and test files are
   unavailable is persisted but does not count as a clean pass; the run has
   partial change coverage.
6. Observed full-file access for every relevant path produces verified byte
   chunks whose gap-free reconstruction matches the pinned snapshot digest and
   permits a clean result; forged ranges or mismatched chunk hashes fail.
   Tracked text files also require complete diff delivery; untracked files
   require only the verified snapshot, deleted files require deleted diff, and
   relevant binary or oversize files remain explicit deficits.
7. An opaque adapter's attested full-file claim satisfies its weaker configured
   policy only when every asserted snapshot digest equals the core-pinned
   digest; a forged or incorrect digest is rejected and cannot appear observed.
8. Three disjoint partial reviewer ledgers cannot satisfy a 3-of-5 pass quorum;
   only individually complete results count, including through fallback and
   retry inheritance.
9. Missing or truncated changed-file context can never produce complete
   coverage, while explicit full review records change coverage as not
   applicable and can complete.
10. Bounded structured pages collect more than four distinct findings without
   repeating evidence and assemble one exact result v4; both the legal 13 MiB
   v8 fixture and a result just below the 16 MiB assembled ceiling round-trip
   losslessly through narrative pages, full JSONL, the artifact, report,
   status, findings, and dashboard detail.
11. Page assembly rejects an index gap, duplicate, broken digest chain, changed
    page count, or false declared finding/decision count; oversize pages fail as
    `result_page_too_large` without truncation.
12. A `finish_reason = "length"` page either completes by exact continuation or
    ends explicitly as `output_truncated`; partial JSON is rejected.
13. A paged adjudication result returns exactly one decision per candidate and
    cannot repeat narrative/evidence on later pages; 80 distinct candidates
    from five 16-finding reviewers fit without semantic preselection, while
    exact duplicate candidates coalesce deterministically first without losing
    their source finding IDs.
14. A v6 terminal event for partial coverage and 11 non-gating subfindings reports
    `run_outcome = inconclusive`, `gate_outcome = no_gate_findings`, and never
    renders a “no findings” headline.
15. Every advisory, rejected, needs-verification, out-of-scope, or
    policy-non-gating canonical subfinding has at least one gate exclusion
    reason; eligible subfindings have none.
16. Two related but distinct failure modes sharing one root ID remain separate
    subfindings, while exact duplicates collapse deterministically.
17. Near-duplicate stale-documentation findings may receive a pairwise semantic
    proposal across rootless and rooted atomics without changing canonical
    roots, counts, or either atomic finding's eligibility; UI labels it related,
    not deduplicated.
18. Canonical ordering and all v6 named counts are identical across live completion,
    strict report, findings, status, and dashboard regardless of result arrival
    order.
19. `concise-jsonl` is the default, keeps a 40-model terminal event below 16
    KiB, repeats the artifact path once, and leaves complete results retrievable
    from the strict immutable artifact.
20. List overflow in concise events produces exact totals, omitted counts,
    canonical digests, and artifact references without shortening a protocol
    value; strict reading verifies a published finalized-artifact digest.
21. Ten thousand repetitive adapter activity events remain within the default
    private activity budget while preserving phase transitions, material
    events, last progress, and suppressed counts.
22. An 81-minute unchanged 40-model run keeps public concise heartbeat bytes
    within 1 MiB, never exceeds the configured liveness interval plus scheduler
    tolerance, and switches to minimal liveness records instead of going silent.
23. Explicit `full-jsonl` returns every accepted reviewer result byte-for-byte
    after sanitization with matching digests.
24. A valid finding completes execution coverage when adjudication is off or
    every required candidate decision completes; policy short-circuit skips are
    satisfied, while an incomplete required adjudication makes coverage partial.
25. A change-readiness lens missing any required PR field makes zero provider
    calls, reports exact missing selectors, and makes coverage partial without
    blocking unrelated lenses.
26. Request v3 rejects malformed PR object shape before a run, while
    selector-level absent or value-invalid PR input produces exact readiness
    diagnostics and exit 3.
27. An explicitly acknowledged 5-of-5 concentrated policy remains 5-of-5,
    emits stable topology warnings, and fails closed after one required provider
    failure.
28. A new five-model profile defaults to distributed primaries and a 3-pass,
    3-provider-group quorum.
29. Shallow history with an absent base or unavailable merge base produces the
    correct `git_history_incomplete` subtype and actionable checks without
    fetching or mutating Git; sufficient shallow ancestry succeeds, and the
    corresponding non-shallow cases retain distinct errors.
30. `doctor --structured-output` exercises file telemetry, result pages,
    continuation, deadline/no-progress handling, coverage reconciliation, and
    stage-specific diagnostics through the real v9 reviewer path.
31. Strict readers round-trip a real artifact-format-2/event-v6/result-v4 run.
    Headerless event-v4/v5 and result-v1/v2/v3 artifacts remain readable and
    change-scoped results are labelled `legacy_unknown` for path coverage.
32. Artifact finalization writes private terminal summary and preterminal
    digest records, closes and hashes the file, indexes it, and then emits the
    unmirrored public terminal event without digest recursion; the mutable index
    records the observed final stdout outcome without rewriting the artifact.
33. With `persist_runs = false`, a verified exclusive details file becomes the
    indexed authoritative artifact; deleted or replaced external artifacts fail
    strict lookup instead of resolving stale internal staging.
34. Config apply schema v1 validates CAS then migrates configs 1 through 6 to
    v7 without silently changing explicit quorum/topology; opaque adapters show
    and require confirmation for attested proof mode, and observed proof paired
    with an incapable command adapter fails preflight.
35. Full test, format, typecheck, portable build, Windows/Linux standalone
    acceptance, artifact checksum, and independent zero-finding review gates
    pass before publication.
