import { describeTool } from "./description.js";

export interface DescribeWorkspaceOptions {
  workspace?: string;
  cwd?: string;
  configFile?: string;
  signal?: AbortSignal;
}

export async function describeWorkspace(
  options: DescribeWorkspaceOptions = {},
): Promise<Awaited<ReturnType<typeof describeTool>>> {
  return describeTool(options);
}

export function renderDescription(
  description: Awaited<ReturnType<typeof describeTool>>,
  json: boolean,
): string {
  if (json) return `${JSON.stringify(description)}\n`;
  const configuration = description.configuration;
  const lines = [
    `Review Mesh: ${description.tool.version}`,
    `Workspace: ${description.invocation.workspace}`,
    `Configuration: ${configuration.config_path}`,
    `Configuration valid: ${configuration.valid ? "yes" : "no"}`,
    `Runtime readiness: ${description.readiness.status}`,
  ];
  if (!configuration.valid) {
    const actions = description.next_actions.flatMap((action) => [
      `  - Run ${action.command}`,
      `    ${action.reason}`,
    ]);
    lines.push(
      `Problem: ${configuration.error.message}`,
      "",
      "Next actions:",
      ...actions,
    );
    return `${lines.join("\n")}\n`;
  }
  lines.push(
    `Selection: ${configuration.selection.source}${configuration.selection.matched_project_path === undefined ? "" : ` (${configuration.selection.matched_project_path})`}`,
    `Reviewers: ${configuration.reviewers.length}`,
    `Concurrency: ${configuration.execution.max_concurrency}`,
    `Heartbeat: every ${configuration.execution.heartbeat_interval_ms} ms`,
    "",
  );
  configuration.reviewers.forEach((reviewer, index) => {
    lines.push(
      `${index + 1}. ${reviewer.id} — ${reviewer.purpose}`,
      `   model=${reviewer.model} adapter=${reviewer.adapter_id} (${reviewer.adapter_type})${reviewer.effort === undefined ? "" : ` effort=${reviewer.effort}`}`,
      `   isolation=${reviewer.isolation_policy} timeout_ms=${reviewer.timeout_ms}`,
    );
  });
  lines.push(
    "",
    "Next actions:",
    `  - Run ${description.invocation.default_review} to review this workspace.`,
    "  - Run review-mesh schema request --json for the explicit request contract.",
  );
  return `${lines.join("\n")}\n`;
}
