# SDK refactor validation

Validated on 2026-09-06 against the SDK refactor based on Review Mesh 9.7.0 (`c6776e4`). This is development-branch evidence, not a published release.

## Automated and packaged checks

- `npm run verify`: **1,256 passed, 11 skipped**, 93 passing test files. Formatting, application/test TypeScript, and portable build passed.
- `npm run verify:standalone`: rebuilt Windows and Linux x64 artifacts and passed the full-result/artifact acceptance test on both platforms.
- SDK startup/version/handshake/shutdown checks using the rebuilt Windows executable: **9 passed**.
- The same checks using the rebuilt Linux executable through WSL Ubuntu: **9 passed**.
- Native Codex, Claude, and Copilot tests exercise actual vendor runtimes against local provider fixtures. They cover source inspection, read-only behavior, strict schema boundaries, cancellation, missing/invalid credentials, and cleanup.
- Public application tests cover native admission limits, retained results on stream/cleanup failure, output disconnect, scope attestation, content-based workspace-change detection, adjudication, and durable artifact retrieval.
- The portable application dependency graph contains none of the retired raw-inference, transport, context-budget, or segmentation modules.

The unrestricted legacy suite exposed process timing failures under CPU contention. Those 54 legacy tests passed in isolation; the default test worker count is now two so SDK/process fixtures do not exhaust the host. No model transport retry settings were added to address testing timing.

An independent review found and verified fixes for command-only retry compatibility, mixed-roster rejection, startup admission limits, SDK/runtime version attribution, and report retention after cleanup. Additional real-provider checks caught strict-schema and gateway-prefix issues, overly strict handling of informational caveats, and metadata-only mutation false positives. Regression coverage was added for those boundaries.

## Live SDK checks

Saved Windows user environment variables were loaded only for isolated subprocesses. The gateway catalog advertised `gpt-6-astra`, `claude-opus-5`, and `kimi-k3`. No credentials or endpoint values are included here, and the global configuration was not changed.

Each run reviewed a tiny synthetic state-retention module and its contract in a temporary workspace. The independent oracle was outside the declared review scope. No production repository or private application source was submitted. Model findings and scenario claims remain distinct from the independently executed oracle.

| Model / SDK              | Fixture   | Run outcome                     | Findings | Evidence                                                                                                                                                                                                                   |
| ------------------------ | --------- | ------------------------------- | -------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gpt-6-astra` / Codex    | Buggy     | Gate findings                   |        2 | Seeded defect confirmed by independent scenario scoring; run `run_051003f5-8616-4536-9420-9d4047899290`.                                                                                                                   |
| `gpt-6-astra` / Codex    | Corrected | Clear                           |        0 | Corrected control passed; run `run_e9794995-2ac2-4f32-8735-d0708100a08f`.                                                                                                                                                  |
| `kimi-k3` / Copilot      | Buggy     | Gate findings                   |        2 | Runtime and structured submission completed; scenario claims did not satisfy the independent scorer; run `run_cba863be-b61a-4acd-a16b-3c8640e8a239`.                                                                       |
| `kimi-k3` / Copilot      | Corrected | Gate findings                   |        1 | False positive: model treated an absent numeric value as allowed despite the contract; run `run_87762bab-00f8-4b4e-b35d-8242deda0ef8`.                                                                                     |
| `claude-opus-5` / Claude | Buggy     | Inconclusive, with gate finding |        2 | Complete structured report; the seeded defect was reported, while an uncertain second finding lacked required ordered proof. Scenario scoring did not establish detection; run `run_45230d1d-bf71-4d83-9df4-98ae687398c4`. |
| `claude-opus-5` / Claude | Corrected | Clear                           |        1 | One non-gating finding remained; independent scoring counted it as a false positive; run `run_aee14aa3-6102-4003-94ed-76cada718714`.                                                                                       |

These checks establish end-to-end integration with the configured gateway. They are too small to rank model quality or demonstrate exhaustive review. No large-context native-compaction benchmark was performed. SDKs own compaction and transient inference retries, while Review Mesh still reports terminal failures and validates returned results.

## Remaining operational boundaries

- Standalone artifacts bundle three runtimes and are approximately 600 MB each.
- Native runtimes are managed child processes. Claude and Copilot hide their Windows launchers; the pinned Codex SDK lacks an exposed `windowsHide` option, so a universal no-window guarantee is not established.
- Native coverage is explicitly model-attested. Content fingerprints detect observed changes between checks, not every transient workspace mutation or every SDK-read byte.
- Mixed command/native rosters require separate runs. Command-only compatibility and historical artifacts retain their own contracts.
- Global configuration migration is explicit through `config migrate-sdk --json` and revision-checked `config apply --json`.

Detailed local logs and private run artifacts remain in the ignored `.superpowers/sdd/2026-09-06-sdk-owned-review/` validation workspace.
