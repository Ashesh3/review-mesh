import { isAbsolute, normalize, relative, resolve, sep } from "node:path";
import {
  trustedConfigSchema,
  validateAdapterEffort,
  type ProjectConfig,
  type ResolvedConfig,
  type ResolvedReviewer,
  type ReviewerProfile,
  type TrustedConfig,
  type TrustedConfigV1,
  type TrustedConfigV2,
} from "./schemas.js";

export interface ResolveConfigInput {
  trusted: TrustedConfig;
  workspace?: string;
}

function normalizedProjectPath(path: string): string {
  if (!isAbsolute(path))
    throw new Error(`project path must be absolute: ${path}`);
  const normalized = normalize(resolve(path)).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function resolveAgent(
  id: string,
  profile: ReviewerProfile,
  adapters: TrustedConfigV2["adapters"],
  projectInstructions?: string,
): ResolvedReviewer {
  const adapter = adapters[profile.adapter];
  if (adapter === undefined) {
    throw new Error(
      `agent ${id} references unknown adapter ${profile.adapter}`,
    );
  }
  if (profile.instructions === undefined) {
    throw new Error(`agent ${id} has unresolved instructions_file`);
  }
  validateAdapterEffort(adapter.type, profile.effort, `agent ${id}`);
  return {
    id,
    purpose: profile.purpose,
    adapterId: profile.adapter,
    adapter,
    model: profile.model,
    ...(profile.effort === undefined ? {} : { effort: profile.effort }),
    instruction_layers: [
      { source: "trusted", content: profile.instructions },
      ...(projectInstructions === undefined
        ? []
        : [{ source: "project" as const, content: projectInstructions }]),
    ],
    isolationPolicy: profile.isolation,
    timeoutMs: profile.timeout_ms,
    runtime: profile.runtime ?? {},
  };
}

function resolveV1(config: TrustedConfigV1): ResolvedConfig {
  const ids = new Set<string>();
  const reviewers = config.reviewers.map((definition) => {
    if (ids.has(definition.id)) {
      throw new Error(`duplicate trusted reviewer id: ${definition.id}`);
    }
    ids.add(definition.id);
    const profile = config.reviewer_profiles[definition.profile];
    if (profile === undefined) {
      throw new Error(
        `trusted reviewer ${definition.id} references unknown profile ${definition.profile}`,
      );
    }
    const reviewer = resolveAgent(definition.id, profile, config.adapters);
    if (definition.append_instructions !== undefined) {
      reviewer.instruction_layers.push({
        source: "trusted",
        content: definition.append_instructions,
      });
    }
    return reviewer;
  });
  return {
    execution: config.execution,
    diagnostics: config.diagnostics,
    reviewers,
  };
}

function selectProject(
  config: TrustedConfigV2,
  workspace: string | undefined,
): ProjectConfig | undefined {
  const entries = Object.entries(config.projects ?? {});
  const normalized = new Map<string, ProjectConfig>();
  for (const [path, project] of entries) {
    const key = normalizedProjectPath(path);
    if (normalized.has(key)) {
      throw new Error(`duplicate normalized project path: ${path}`);
    }
    normalized.set(key, project);
  }
  if (workspace === undefined) return undefined;
  const key = normalizedProjectPath(workspace);
  let selected: { path: string; project: ProjectConfig } | undefined;
  for (const [candidate, project] of normalized) {
    const remainder = relative(candidate, key);
    const contains =
      remainder === "" ||
      (remainder !== ".." &&
        !remainder.startsWith(`..${sep}`) &&
        !isAbsolute(remainder));
    if (
      contains &&
      (selected === undefined || candidate.length > selected.path.length)
    ) {
      selected = { path: candidate, project };
    }
  }
  return selected?.project;
}

function resolveV2(
  config: TrustedConfigV2,
  workspace: string | undefined,
): ResolvedConfig {
  const project = selectProject(config, workspace);
  const agentIds = project?.agents ?? config.defaults?.agents;
  if (agentIds === undefined || agentIds.length === 0) {
    throw new Error("no agents are configured for the requested project");
  }
  const reviewers = agentIds.map((id) => {
    const agent = config.agents[id];
    if (agent === undefined) throw new Error(`unknown configured agent: ${id}`);
    return resolveAgent(id, agent, config.adapters, project?.instructions);
  });
  return {
    execution: config.execution,
    diagnostics: config.diagnostics,
    ...(project?.context === undefined
      ? {}
      : { project_context: project.context }),
    reviewers,
  };
}

export function resolveConfig(input: ResolveConfigInput): ResolvedConfig {
  const trusted = trustedConfigSchema.parse(input.trusted);
  return trusted.schema_version === "1"
    ? resolveV1(trusted)
    : resolveV2(trusted, input.workspace);
}
