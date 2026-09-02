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
  const ready = configuration.valid;
  const effectiveWorkspace =
    configuration.valid && "workspace" in configuration
      ? configuration.workspace
      : workspace;
  const reviewCommand =
    options.workspace === undefined
      ? "review-mesh review"
      : `review-mesh review "${effectiveWorkspace.replaceAll('"', '\\"')}"`;
  return {
    schema_version: "1" as const,
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
        stdin: "empty-or-review-request-json-v1" as const,
        stdout: "public-events-jsonl-v2" as const,
        stderr: "diagnostic-jsonl-v1" as const,
        final_event: "run.completed" as const,
      },
    },
    commands,
    schemas: {
      request: { command: "review-mesh schema request --json" },
      events: { command: "review-mesh schema events --json" },
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
      status: "not_probed" as const,
      meaning:
        "Configuration and workspace selection are valid; adapters, credentials, models, and isolation are probed when review starts.",
    },
    protocol: {
      version: "2" as const,
      consistency_mode: "live_worktree" as const,
      maximum_request_bytes: 8 * 1024 * 1024,
      outcome_precedence: ["incomplete", "findings", "passed"] as const,
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
      },
    },
    exit_codes: {
      "0": "success or review passed",
      "1": "review completed with actionable findings",
      "2": "invalid usage, request, configuration, or project assignment",
      "3": "review incomplete because a reviewer or runtime failed",
      "4": "interrupted",
    },
    next_actions: ready
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
              reason: "The requested workspace must be an existing directory.",
            },
          ]
        : [
            {
              command: "review-mesh config --help",
              reason: "Create or repair the trusted configuration.",
            },
            {
              command: "review-mesh config export --json",
              reason: "Inspect the current config revision when a file exists.",
            },
          ],
  };
}
