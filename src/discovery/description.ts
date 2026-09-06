import { resolve } from "node:path";
import { describeEffectiveConfig } from "../config/effective.js";
import { getAppPaths } from "../config/paths.js";
import { reviewMeshVersion } from "./help.js";

export interface DescribeToolOptions {
  workspace?: string;
  cwd?: string;
  configFile?: string;
  signal?: AbortSignal;
}

const commands = [
  {
    name: "review",
    usage: "review-mesh review [WORKSPACE]",
    help_command: "review-mesh help review",
  },
  {
    name: "describe",
    usage: "review-mesh describe [WORKSPACE] --json",
    help_command: "review-mesh help describe",
  },
  {
    name: "status",
    usage: "review-mesh status RUN_ID [REVIEWER_ID] --json",
    help_command: "review-mesh help status",
  },
  {
    name: "report",
    usage: "review-mesh report RUN_ID --format markdown|json [--best-effort]",
    help_command: "review-mesh help report",
  },
  {
    name: "findings",
    usage: "review-mesh findings RUN_ID --deduplicate --json [--best-effort]",
    help_command: "review-mesh help findings",
  },
  {
    name: "retry",
    usage: "review-mesh retry RUN_ID --only-incomplete",
    help_command: "review-mesh help retry",
  },
  {
    name: "doctor",
    usage:
      "review-mesh doctor [WORKSPACE] [--adapter ID] [--model MODEL] [--structured-output]",
    help_command: "review-mesh help doctor",
  },
  {
    name: "serve",
    usage: "review-mesh serve [--host 127.0.0.1] [--port 0] [--no-open]",
    help_command: "review-mesh help serve",
  },
  {
    name: "schema",
    usage: "review-mesh schema list | review-mesh schema NAME --json",
    help_command: "review-mesh help schema",
  },
  {
    name: "config effective",
    usage: "review-mesh config effective [WORKSPACE] --json",
    help_command: "review-mesh config --help",
  },
  {
    name: "config export",
    usage: "review-mesh config export --json",
    help_command: "review-mesh config --help",
  },
  {
    name: "config apply",
    usage: "review-mesh config apply --json",
    help_command: "review-mesh config --help",
  },
] as const;

export async function describeTool(options: DescribeToolOptions = {}) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const workspace = resolve(cwd, options.workspace ?? ".");
  const configPath = options.configFile ?? getAppPaths().configFile;
  const configuration = await describeEffectiveConfig({
    configFile: configPath,
    workspace,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const migrationRequired =
    configuration.valid &&
    configuration.reviewers.some(
      (reviewer) => reviewer.adapter_type === "openai_compatible",
    );
  const effectiveWorkspace =
    configuration.valid && "workspace" in configuration
      ? configuration.workspace
      : workspace;
  const reviewCommand =
    options.workspace === undefined
      ? "review-mesh review"
      : `review-mesh review "${effectiveWorkspace.replaceAll('"', '\\"')}"`;
  const explicitChangeRequest =
    configuration.valid && configuration.selection.project_name !== undefined
      ? {
          schema_version: "3" as const,
          project_name: configuration.selection.project_name,
          workspace: effectiveWorkspace,
          instructions:
            "Review the current changes for actionable correctness, security, reliability, compatibility, and test-coverage defects.",
          review_scope: { mode: "changes" as const },
        }
      : undefined;
  return {
    schema_version: "2" as const,
    kind: "review-mesh.description" as const,
    tool: {
      name: "review-mesh" as const,
      version: reviewMeshVersion,
      agent_first: true as const,
      read_only_reviews: true as const,
    },
    invocation: {
      cwd,
      workspace: effectiveWorkspace,
      default_review: reviewCommand,
    },
    streams: {
      review: {
        stdin: "empty-or-review-request-json-v2-or-v3" as const,
        stdout: "public-events-jsonl-v6" as const,
        default_output_mode: "concise-jsonl" as const,
        output_modes: ["concise-jsonl", "full-jsonl", "compact-jsonl"] as const,
        stderr: "diagnostic-jsonl-v1" as const,
        final_event: "run.completed" as const,
        persistence_failure_event: "run.persistence_failed" as const,
        status_query: "review-mesh status RUN_ID [REVIEWER_ID] --json" as const,
      },
    },
    commands,
    schemas: {
      request: { command: "review-mesh schema request --json" },
      events: { command: "review-mesh schema events --json" },
      run_status: { command: "review-mesh schema run-status --json" },
      reviewer_result: { command: "review-mesh schema result --json" },
      config: { command: "review-mesh schema config --json" },
      config_apply: { command: "review-mesh schema config-apply --json" },
      diagnostic: { command: "review-mesh schema diagnostic --json" },
      command_adapter_event: {
        command: "review-mesh schema command-adapter-event --json",
      },
    },
    configuration,
    readiness: {
      status: migrationRequired
        ? ("migration_required" as const)
        : ("not_probed" as const),
      review_supported: configuration.valid && !migrationRequired,
      meaning: migrationRequired
        ? "The configuration remains inspectable for migration, but reviews reject the retired raw-inference adapter."
        : configuration.valid
          ? "Configuration and workspace selection are valid; credentials, model access, and isolation remain unprobed. Use structured doctor to verify native execution."
          : "Repair configuration or workspace selection before probing native execution.",
    },
    protocol: {
      version: "6" as const,
      request_version: "3" as const,
      consistency_mode: "live_worktree" as const,
      maximum_request_bytes: 8 * 1024 * 1024,
      outcomes: ["run_outcome", "gate_outcome", "coverage_outcome"] as const,
      model_fallback: {
        parallelism: "across_agents" as const,
        order: "effective_cyclic_model_runs" as const,
        distribute_primaries: configuration.valid
          ? configuration.execution.distribute_primaries
          : undefined,
        advance_after: [
          "clean_pass_until_quorum",
          "operational_failure",
        ] as const,
        stop_agent_after: ["confirmed_findings", "quorum"] as const,
      },
      progress: {
        phases: [
          "queued",
          "probing",
          "starting",
          "reviewing",
          "validating",
          "terminal",
        ] as const,
        heartbeats_cover: ["probing", "queued", "reviewing"] as const,
        percentages_reported: false as const,
        adapter_activity_streamed: false as const,
        status_query_available: true as const,
        sdk_transport_recovery: "vendor_owned" as const,
      },
      deadlines: configuration.valid
        ? {
            mode: configuration.execution.deadline_mode,
            run_deadline_ms: configuration.execution.run_deadline_ms,
            no_progress_timeout_ms:
              configuration.execution.no_progress_timeout_ms,
          }
        : undefined,
      sdk_execution: {
        contract: "native_review_v1" as const,
        mode: "managed_process" as const,
        routing: {
          openai: "codex",
          anthropic: "claude",
          other_models: "copilot",
        } as const,
        inference_owner: "vendor_sdk" as const,
        tool_execution_owner: "vendor_sdk" as const,
        context_management_owner: "vendor_sdk" as const,
        in_turn_retry_owner: "vendor_sdk" as const,
        mesh_session_attempts: 1 as const,
        mesh_exact_output_continuation: false as const,
        structured_submission: {
          codex: "output_schema",
          claude: "output_format_json_schema",
          copilot: "terminal_submit_review_tool",
        } as const,
      },
      model_support: {
        source: "vendor_runtime" as const,
        availability: "not_probed" as const,
        exact_model_identifier_preserved: true as const,
        verification_command: "review-mesh doctor --structured-output",
      },
      retry: {
        native_inheritance: "rerun_all" as const,
        native_coverage_basis: "model_attested" as const,
        legacy_command_inheritance: "verified_compatible_results" as const,
      },
      review_scope: {
        default_mode: "changes" as const,
        full_review_requires_explicit_mode: true as const,
        inferred_base_order: [
          "origin/HEAD",
          "origin/main",
          "origin/master",
          "other-remote/HEAD",
          "other-remote/main",
          "other-remote/master",
          "main",
          "master",
        ] as const,
        included_changes: [
          "merge-base-to-checked-out-head",
          "staged",
          "unstaged",
          "untracked",
        ] as const,
      },
    },
    request_examples:
      explicitChangeRequest === undefined
        ? undefined
        : {
            changes: explicitChangeRequest,
            full: {
              ...explicitChangeRequest,
              instructions:
                "Review the entire codebase for actionable defects.",
              review_scope: { mode: "full" as const },
            },
          },
    exit_codes: {
      "0": "success or review passed",
      "1": "review completed with actionable findings",
      "2": "invalid usage, request, configuration, or project assignment",
      "3": "review incomplete because a reviewer or runtime failed",
      "4": "interrupted",
    },
    next_actions: migrationRequired
      ? [
          {
            command: "review-mesh config export --json",
            reason:
              'Migrate the retired adapter to type "sdk" with explicitly selected native_attested coverage. Preserve the exact models and supported provider environment references.',
          },
        ]
      : configuration.valid
        ? [
            {
              command: reviewCommand,
              reason:
                "Configuration is valid. Run the review to probe adapter, authentication, model, and isolation readiness, then consume JSONL through run.completed.",
            },
          ]
        : configuration.error.code === "invalid_workspace"
          ? [
              {
                command: "review-mesh describe <existing-workspace> --json",
                reason:
                  "The requested workspace must be an existing directory.",
              },
            ]
          : [
              {
                command: "review-mesh config --help",
                reason: "Create or repair the trusted configuration.",
              },
              {
                command: "review-mesh config export --json",
                reason:
                  "Inspect the current config revision when a file exists.",
              },
            ],
  };
}
