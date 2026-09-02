import {
  trustedConfigSchema,
  validateAdapterEffort,
  type ResolvedConfig,
  type ResolvedReviewer,
  type AgentProfile,
  type ModelRun,
  type ReviewerProfile,
  type TrustedConfig,
  type TrustedConfigV1,
  type TrustedConfigV2,
  type TrustedConfigV3,
  type TrustedConfigV4,
} from "./schemas.js";
import { selectProject } from "./project-paths.js";
import {
  projectNameFromLegacyPath,
  selectProjectByName,
} from "./project-names.js";

export interface ResolveConfigInput {
  trusted: TrustedConfig;
  workspace?: string;
  projectName?: string;
  projectNameSource?:
    "git_remote" | "git_common_directory" | "git_root" | "workspace";
}

type ReviewerProfileBase = Pick<
  AgentProfile,
  | "adapter"
  | "purpose"
  | "instructions"
  | "isolation"
  | "timeout_ms"
  | "runtime"
>;

function configuredAdapter(
  id: string,
  adapterId: string,
  adapters: TrustedConfigV2["adapters"],
  label = `agent ${id}`,
): NonNullable<TrustedConfigV2["adapters"][string]> {
  const adapter = Object.hasOwn(adapters, adapterId)
    ? adapters[adapterId]
    : undefined;
  if (adapter === undefined) {
    throw new Error(`${label} references unknown adapter ${adapterId}`);
  }
  return adapter;
}

function resolveReviewer(
  id: string,
  profile: ReviewerProfileBase,
  adapterId: string,
  model: string,
  effort: ModelRun["effort"],
  adapters: TrustedConfigV2["adapters"],
  projectInstructions?: string,
): ResolvedReviewer {
  const adapter = configuredAdapter(id, adapterId, adapters);
  if (profile.instructions === undefined) {
    throw new Error(`agent ${id} has unresolved instructions_file`);
  }
  validateAdapterEffort(adapter.type, effort, `agent ${id}`);
  return {
    id,
    purpose: profile.purpose,
    adapterId,
    adapter,
    model,
    ...(effort === undefined ? {} : { effort }),
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

function resolveAgent(
  id: string,
  profile: AgentProfile,
  adapters: TrustedConfigV2["adapters"],
  projectInstructions?: string,
): ResolvedReviewer[] {
  configuredAdapter(id, profile.adapter, adapters);
  if ("model_runs" in profile) {
    return profile.model_runs.map((run) => {
      const adapterId = run.adapter ?? profile.adapter;
      const label = `agent ${id} model run ${run.id}`;
      const adapter = configuredAdapter(id, adapterId, adapters, label);
      validateAdapterEffort(adapter.type, run.effort, label);
      return resolveReviewer(
        `${id}::${run.id}`,
        profile,
        adapterId,
        run.model,
        run.effort,
        adapters,
        projectInstructions,
      );
    });
  }
  return [
    resolveReviewer(
      id,
      profile,
      profile.adapter,
      profile.model,
      profile.effort,
      adapters,
      projectInstructions,
    ),
  ];
}

function requireUniqueResolvedIds(
  reviewers: readonly ResolvedReviewer[],
): void {
  const ids = new Set<string>();
  for (const reviewer of reviewers) {
    if (ids.has(reviewer.id)) {
      throw new Error(`expanded reviewer id collision: ${reviewer.id}`);
    }
    ids.add(reviewer.id);
  }
}

function requireUniqueExpandedAgentIds(
  config: TrustedConfigV3 | TrustedConfigV4,
): void {
  const ids = new Set<string>();
  for (const [agentId, profile] of Object.entries(config.agents)) {
    const expandedIds =
      "model_runs" in profile
        ? profile.model_runs.map((run) => `${agentId}::${run.id}`)
        : [agentId];
    for (const id of expandedIds) {
      if (ids.has(id)) throw new Error(`expanded reviewer id collision: ${id}`);
      ids.add(id);
    }
  }
}

function resolveV1(
  config: TrustedConfigV1,
  projectName: string | undefined,
  projectNameSource: ResolveConfigInput["projectNameSource"],
): ResolvedConfig {
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
    const reviewer = resolveReviewer(
      definition.id,
      profile,
      profile.adapter,
      profile.model,
      profile.effort,
      config.adapters,
    );
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
    selection: {
      source: "legacy",
      ...(projectName === undefined ? {} : { projectName }),
      ...(projectNameSource === undefined ? {} : { projectNameSource }),
    },
    reviewers,
  };
}

function resolveV2(
  config: TrustedConfigV2 | TrustedConfigV3 | TrustedConfigV4,
  workspace: string | undefined,
  projectName: string | undefined,
  projectNameSource: ResolveConfigInput["projectNameSource"],
): ResolvedConfig {
  if (config.schema_version === "3" || config.schema_version === "4") {
    requireUniqueExpandedAgentIds(config);
  }
  const selectedByName =
    config.schema_version === "4"
      ? selectProjectByName(config.projects, projectName)
      : undefined;
  const selectedByPath =
    config.schema_version === "4"
      ? undefined
      : selectProject(config.projects, workspace);
  const project = (selectedByName ?? selectedByPath)?.project;
  const agentIds = project?.agents ?? config.defaults?.agents;
  if (agentIds === undefined || agentIds.length === 0) {
    throw new Error("no agents are configured for the requested project");
  }
  const reviewers = agentIds.flatMap((id) => {
    const agent = Object.hasOwn(config.agents, id)
      ? config.agents[id]
      : undefined;
    if (agent === undefined) throw new Error(`unknown configured agent: ${id}`);
    return resolveAgent(id, agent, config.adapters, project?.instructions);
  });
  requireUniqueResolvedIds(reviewers);
  return {
    execution: config.execution,
    diagnostics: config.diagnostics,
    selection: {
      source: project?.agents === undefined ? "defaults" : "project",
      ...(projectName === undefined ? {} : { projectName }),
      ...(projectNameSource === undefined ? {} : { projectNameSource }),
      ...(selectedByName === undefined && selectedByPath === undefined
        ? {}
        : {
            matchedProjectName:
              selectedByName?.name ??
              projectNameFromLegacyPath(selectedByPath!.path),
          }),
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
    ? resolveV1(trusted, input.projectName, input.projectNameSource)
    : resolveV2(
        trusted,
        input.workspace,
        input.projectName,
        input.projectNameSource,
      );
}
