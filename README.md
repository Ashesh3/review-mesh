# Review Mesh

Review Mesh coordinates code reviews across vendor-owned coding-agent SDKs:

| Model family                         | Harness            |
| ------------------------------------ | ------------------ |
| OpenAI                               | Codex SDK          |
| Anthropic                            | Claude Agent SDK   |
| Other supported models, such as Kimi | GitHub Copilot SDK |

The SDKs own model requests, repository exploration, tool execution, context
management, compaction, and provider retries. Review Mesh owns the trusted reviewer
roster, review scope, concurrency, deadlines, cancellation, structured results,
configured gate policy, and durable reports.

The raw `openai_compatible` inference engine is retired in v10.0.0.
See [SDK configuration and migration](docs/sdk-migration.md) for the replacement.
See [v10.1.0 release notes](docs/releases/v10.1.0.md) for changes and upgrade requirements.

## Download

- [Windows x64](https://github.com/Ashesh3/review-mesh/releases/download/v10.1.0/review-mesh-windows-x64.exe)
- [Linux x64](https://github.com/Ashesh3/review-mesh/releases/download/v10.1.0/review-mesh-linux-x64)
- [SHA-256 checksums](https://github.com/Ashesh3/review-mesh/releases/download/v10.1.0/SHA256SUMS.txt)

## Build

Development requires Node.js 22.12+ and the configured npm registry:

```powershell
npm ci --registry=https://packagefeedproxy.microsoft.io/npm/
npm run build
```

Run the development CLI with `node --import tsx src/cli.ts`, or use the generated
`dist/review-mesh.mjs`. The portable JavaScript file requires the installed native
SDK runtime assets. To build standalone Windows and Linux x64 executables:

```powershell
npm run build:standalone
```

Standalone executables embed all three native runtimes and extract them on first
use. No separately installed Codex, Claude, or Copilot CLI is needed. Each platform
artifact is approximately 600 MB. Git, trusted configuration, and credentials
remain external. Linux binary acceptance on Windows uses WSL.

## Configure reviewers

The global configuration defines independent reviewers and project-name
assignments. Another agent can inspect and update it through versioned JSON:

```powershell
review-mesh config export --json
review-mesh config effective . --json
review-mesh config apply --json
```

`config apply` reads a revision-checked request from stdin. `config export` includes
trusted instruction text; `config effective` and `describe` redact instruction
bodies and credential values. Running `review-mesh config` opens the local
configuration manager.

Use one `sdk` adapter for a compatible gateway, or explicit `codex`, `claude`, and
`copilot` adapters with separate credentials. Model IDs are preserved exactly;
model availability is determined by the selected vendor runtime/provider.
OpenAI models always use Codex and Anthropic models always use Claude.

Native reviewers receive the configured reviewer prompt, branch and changed-file
context, and read-only access to the full workspace and Git through their SDK.
The agent chooses which files, supporting code, and ranges to inspect. Review Mesh
does not require every changed file to be read, impose page-by-page instructions,
or collect per-file read receipts. Review Mesh validates result schemas and applies
the configured model-review and adjudication policy, retaining cited evidence and
limitations in the report. A completed SDK review is not an all-files or exhaustive
defect-detection guarantee.

Legacy `change_coverage` settings do not become native read obligations and need
not be migrated to `native_attested`. Native results mark change coverage as
`status = "not_applicable"` and `proof_kind = "unknown"`; optional historical
`native_scope_attestation` is metadata, not an acceptance requirement. Command-only
legacy review keeps its existing snapshot and coverage semantics.

For complete-roster evaluation, select `execution.review_profile = "strict-evaluation"`
in trusted configuration. Every applicable configured model runs, including the
remaining independent adjudicators after a finding. Failed jobs keep execution
incomplete. Differing model assessments remain in the report with an
`adjudication_disagreement` warning and do not make completed execution incomplete.
Routine reviews retain their configured early exits. Model-job completion is
distinct from a clean PR: a complete review may correctly exit `1` with findings.

Native heartbeats include model counts and active reviewer details from workspace
preparation through finalization. The configured `no_progress_timeout_ms` is
enforced using advancing native response bytes or distinct inspection activity;
repeating the same read does not extend it. Rejected Copilot submissions receive
schema and candidate-decision feedback inside the same SDK session. Accepted
results retain the models' cited evidence and limitations; native review does not
independently verify those citations against source files.

Existing raw configuration can be migrated through a read-only preview:

```powershell
review-mesh config migrate-sdk --json > sdk-config-apply.json
# Review the preview and verify the gateway supports each SDK's native protocol.
Get-Content -Raw sdk-config-apply.json | review-mesh config apply --json
```

See [migration details](docs/sdk-migration.md) for protocol/authentication requirements,
coverage semantics, and legacy command compatibility.

## Run and retrieve a review

```powershell
review-mesh describe . --json
review-mesh doctor . --structured-output
review-mesh review .
review-mesh report RUN_ID --format markdown
review-mesh findings RUN_ID --deduplicate --json
```

By default, reviews target current changes. Full-scope reviews use an explicit
JSON request; the request schema is available from `review-mesh schema request --json`.
Project identity is resolved from the repository name. Configuration—not request
input—selects the reviewer roster.

Native `doctor --structured-output` checks a usable SDK structured review and its
persisted result and execution records (`end_to_end_native_review`). It does not
require a scope attestation or certify per-file read coverage.

A run emits factual JSONL through terminal `run.completed` or
`run.persistence_failed`. Default `concise-jsonl` output references complete
results in the durable artifact; `--output-mode full-jsonl` also emits the complete
sanitized results during the invocation. Result narrative and finding lists are
retained without a model-driven page/digest conversation.

| Exit | Meaning                                                  |
| ---- | -------------------------------------------------------- |
| 0    | Configured review policy completed with no gate findings |
| 1    | Completed review has gate findings                       |
| 2    | Invalid request/configuration or migration required      |
| 3    | Inconclusive execution, coverage, evidence, or delivery  |
| 4    | Cancelled                                                |

Completed findings remain available when another reviewer fails. A malformed or
missing result, unavailable model, exhausted quota, invalid required evidence, or
observed workspace mutation cannot become a clean review. Native retries explicitly
rerun reviewers instead of inheriting old snapshot evidence.

## Progress and local dashboard

```powershell
review-mesh status RUN_ID --json
review-mesh cancel RUN_ID
review-mesh pause RUN_ID
review-mesh resume RUN_ID
review-mesh retry RUN_ID --only-incomplete
review-mesh serve
```

The dashboard is read-only, dependency-free, and served on loopback. It displays
persisted progress and results; it does not mutate reviewed repositories. Native
reviewer activity and aggregate heartbeats distinguish liveness from completeness.

Artifacts are published atomically with digests and recoverable copies. Historical
artifacts remain readable. To recover a verified artifact explicitly:

```powershell
review-mesh recover RUN_ID --artifact PATH
```

## Execution boundaries

Vendor runtimes run as managed noninteractive processes. Claude and Copilot use
hidden Windows launchers. The pinned Codex SDK has no exposed `windowsHide` option;
headless operation is verified, but a universal no-window guarantee is not claimed.

Claude/Copilot use native read/search tools with shell/write tools disabled. Codex
uses its read-only sandbox and native command tools, with Windows sandbox mode set
explicitly. Review Mesh disables ambient tool/config extensions where supported.
These are runtime restrictions, not an independently enforced outer filesystem
boundary. Native reviewers therefore reject `require_enforced`.

No provider credentials, raw reasoning, or full provider request bodies are printed
in progress diagnostics. Explicit key/URL environment references fail when missing
instead of silently selecting another account or endpoint.

## Verification

```powershell
npm run verify
npm run verify:standalone
```

Tests cover public CLI routing, structured results, historical artifact readers,
gate/adjudication behavior, cancellation, output failure, and runtime packaging.
Native SDK integration tests use loopback provider fixtures without paid inference.
They establish integration behavior, not real-model review quality.

[SDK validation results](docs/sdk-validation.md) record automated checks and the live synthetic model comparison.

[Independent quality evaluation](docs/quality-evaluation.md) uses separate synthetic
behavioral oracles to score model-provided scenarios from final reports.

Official SDK references: [Codex](https://learn.chatgpt.com/docs/codex-sdk),
[Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview),
[GitHub Copilot SDK](https://github.com/github/copilot-sdk).
