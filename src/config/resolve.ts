import {
  trustedConfigSchema,
  validateAdapterEffort,
  type ResolvedConfig,
  type ResolvedReviewer,
  type ReviewerProfile,
  type TrustedConfig,
  type TrustedConfigV1,
  type TrustedConfigV2,
} from "./schemas.js";
import { selectProject } from "./project-paths.js";

export interface ResolveConfigInput {
  trusted: TrustedConfig;
  workspace?: string;
}

function resolveAgent(
  id: string,
  profile: ReviewerProfile,
  adapters: TrustedConfigV2["adapters"],
  projectInstructions?: string,
): ResolvedReviewer {
  const adapter = Object.hasOwn(adapters, profile.adapter)
    ? adapters[profile.adapter]
    : undefined;
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
    selection: { source: "legacy" },
    reviewers,
  };
}

function resolveV2(
  config: TrustedConfigV2,
  workspace: string | undefined,
): ResolvedConfig {
  const selectedProject = selectProject(config.projects, workspace);
  const project = selectedProject?.project;
  const agentIds = project?.agents ?? config.defaults?.agents;
  if (agentIds === undefined || agentIds.length === 0) {
    throw new Error("no agents are configured for the requested project");
  }
  const reviewers = agentIds.map((id) => {
    const agent = Object.hasOwn(config.agents, id)
      ? config.agents[id]
      : undefined;
    if (agent === undefined) throw new Error(`unknown configured agent: ${id}`);
    return resolveAgent(id, agent, config.adapters, project?.instructions);
  });
  return {
    execution: config.execution,
    diagnostics: config.diagnostics,
    selection: {
      source: project?.agents === undefined ? "defaults" : "project",
      ...(selectedProject === undefined
        ? {}
        : { matchedProjectPath: selectedProject.path }),
    },
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
