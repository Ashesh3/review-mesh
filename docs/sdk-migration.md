# SDK-backed reviews

Review Mesh uses vendor coding-agent runtimes for reviews:

| Model family                                                | SDK/harness        |
| ----------------------------------------------------------- | ------------------ |
| OpenAI (`gpt-*`, `o1`/`o3` families, `codex-*`, `openai/*`) | Codex SDK          |
| Anthropic (`claude-*`, `anthropic/*`)                       | Claude Agent SDK   |
| Other model IDs                                             | GitHub Copilot SDK |

The exact configured model ID is preserved. Copilot account/model discovery determines availability for native Copilot service usage; a model such as Kimi K3 must actually be offered by the selected account or compatible configured provider. Routing a name does not grant model access. A Claude model cannot be routed through Copilot in this configuration: it uses the Claude harness.

Each selected SDK owns model requests, repository exploration, tool execution, context management, compaction, and provider retry behavior. Review Mesh owns review scope, trusted configuration, concurrency, deadlines, cancellation, normalized results, configured quorum/adjudication policy, and durable artifacts. It does not retry a completed SDK failure or issue repair/page/checkpoint conversations around the SDK.

## Configuration

`type = "sdk"` routes by model family. Use it with one compatible gateway serving the required SDK protocols, or configure three explicit adapters with separate native credentials:

```toml
[adapters.openai]
type = "codex"
api_key_env = "OPENAI_API_KEY"

[adapters.anthropic]
type = "claude"
api_key_env = "ANTHROPIC_API_KEY"

[adapters.other]
type = "copilot"
use_logged_in_user = true
```

For a supported gateway, set `base_url_env` and `api_key_env` to environment-variable **names**. A terminal `/v1` suffix is removed only for Claude, whose SDK appends `/v1/messages`; deployment prefixes are preserved. Codex uses the Responses protocol; Claude uses Anthropic Messages; Copilot BYOK currently uses OpenAI Chat Completions for other models. Review Mesh does not translate between those provider protocols. Do not point all three at a Chat Completions-only server.

Configure the reviewer model, instructions, policy, and timeout as before. Native agents receive the branch and changed-file context with read-only workspace and Git access, then choose their own supporting reads and review strategy. There is no per-file read receipt, mandatory full-file sweep, or all-files guarantee.

Existing configurations and historical migration previews may contain:

```toml
[agents.correctness.change_coverage]
relevant_paths = ["**"]
minimum_inspection = "full_file"
proof = "native_attested"
```

These legacy `change_coverage` fields do not impose native inspection obligations or require a proof migration. Native results mark change coverage `not_applicable` with proof kind `unknown`; optional `native_scope_attestation` is historical metadata, not an acceptance gate. Review Mesh validates result schemas and applies configured model-review and adjudication policy, retaining the agent's evidence and limitations without claiming independent source coverage. Invalid output, SDK failures, and missing required candidate decisions leave execution incomplete; model uncertainty or disagreement remains review content. Command-only legacy reviews retain their original coverage contract.

Native reviews inspect the live worktree. A content change observed during a review prevents a clean outcome. This is not a filesystem snapshot or protection against every transient modification; provide a stable workspace when reproducibility matters.

## Existing raw-inference configuration

The `openai_compatible` runtime is retired. Existing configuration remains readable for migration; attempts to review with it fail before inference. Generate a read-only migration preview:

```powershell
review-mesh config migrate-sdk --json > sdk-config-apply.json
```

The preview preserves endpoint/key variable names, reviewer instructions, model IDs, assignments, and gate policies; changes raw registrations to `sdk`; historically writes `native_attested` coverage metadata; and removes host provider retry/context-continuation settings. That coverage metadata does not control native file selection. Inspect the preview, verify SDK protocol compatibility, then apply it:

```powershell
Get-Content -Raw sdk-config-apply.json | review-mesh config apply --json
review-mesh describe . --json
review-mesh doctor . --structured-output
```

The apply file contains trusted instructions, like `config export`; keep it private. `config apply` retains revision conflict checks and atomic writes. No environment value is expanded into the preview. Mixed legacy command/SDK runs are rejected; use separate review rosters. Migration previews reject configurations mixing those families so policy changes remain explicit. Command-only compatibility keeps its existing retry and coverage contract.

Native explicit retries rerun the configured review rather than inheriting old snapshot-bound completion or coverage proof. Historical artifacts, reports, status, dashboard, and recovery remain readable.

## Distribution and runtime behavior

Windows and Linux standalone builds bundle each vendor's native runtime. Assets are extracted on first use, so separate Codex/Claude/Copilot CLI installation is unnecessary. The executable is approximately 600 MB because it carries three vendor runtimes. SDK wrapper code alone cannot provide those native assets.

Vendor processes run noninteractively with piped communication. Claude and Copilot launch with hidden Windows windows. The pinned Codex SDK does not expose a `windowsHide` launcher option; its headless operation is tested, but a universal no-window guarantee is not established. No SDK patch or global process hook is applied.

Native reviewers can use their SDK's read/search and read-only Git command tools across the workspace; write tools and unapproved mutating commands remain blocked. File selection and pagination belong to the agent and SDK, not host-issued read checklists. Codex's Windows runtime selects the unelevated sandbox explicitly. Codex uses a private launch directory and configuration, suppresses project configuration and ambient skills discovered at launch, and receives the reviewed workspace through its trusted instructions. These are runtime restrictions, so a configuration requiring an independently enforced outer filesystem boundary remains unavailable.

Claude uses a session-owned loopback transport for API-key requests to keep the SDK's internal text-only compaction tool-free. The trusted SDK compaction hooks identify that phase; ordinary review requests and responses remain native, with no host inference or retry loop.

Credentials come from explicit trusted references or supported SDK-native login. Copilot login uses a dedicated shared Review Mesh account directory with isolated per-session state; users with an older keychain-only login may need to sign in again with `review-mesh config copilot login`. Claude subscription login is not automatically interchangeable with API access for third-party apps. Use supported vendor/provider authentication. Compaction and transient retries are SDK responsibilities, but exhausted quotas, invalid credentials, unavailable models, deadlines, and missing outputs still produce failures.

## Verification

Run `doctor --structured-output` to exercise the production SDK path on a small changed Git fixture. Native checks cover usable structured submission, persisted results and execution records, and safe whole-review retry behavior (`end_to_end_native_review`, proof kind `unknown`). They do not require scope attestation or prove per-file reads. A plain probe only checks runtime/credential/model readiness and cannot establish review quality.

The repository tests additionally exercise native SDKs against loopback test providers, public CLI/artifact behavior, cancellation, missing credentials, adjusted adjudication, workspace mutation, and source/compiled runtime startup on Windows and Linux. Local test-provider evidence is not a benchmark of real-model review quality.

Official references: [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk), [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview), [Claude single executable](https://code.claude.com/docs/en/agent-sdk/typescript#compile-to-a-single-executable), [Copilot SDK](https://github.com/github/copilot-sdk), [Copilot BYOK](https://github.com/github/copilot-sdk/blob/v1.0.13/docs/auth/byok.md).
