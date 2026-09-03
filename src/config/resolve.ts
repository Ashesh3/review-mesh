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
  type TrustedConfigV5,
} from "./schemas.js";
import {
  DEFAULT_GATE_THRESHOLDS,
  DEFAULT_PASS_QUORUM_POLICY,
  validateLensPolicy,
} from "../orchestrator/lens-policy.js";
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
  agentId: string,
  modelIndex: number,
  modelCount: number,
  previousReviewerId: string | undefined,
  profile: ReviewerProfileBase,
  adapterId: string,
  model: string,
  effort: ModelRun["effort"],
  adapters: TrustedConfigV2["adapters"],
  projectInstructions?: string,
  options?: {
    providerGroup?: string;
    attemptTimeoutMs?: number;
    policy?: ResolvedReviewer["policy"];
  },
): ResolvedReviewer {
  const adapter = configuredAdapter(id, adapterId, adapters);
  if (profile.instructions === undefined) {
    throw new Error(`agent ${id} has unresolved instructions_file`);
  }
  validateAdapterEffort(adapter.type, effort, `agent ${id}`);
  return {
    id,
    agentId,
    modelIndex,
    modelCount,
    ...(previousReviewerId === undefined ? {} : { previousReviewerId }),
    ...(options?.providerGroup === undefined
      ? {}
      : { providerGroup: options.providerGroup }),
    ...(options?.attemptTimeoutMs === undefined
      ? {}
      : { attemptTimeoutMs: options.attemptTimeoutMs }),
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
    ...(options?.policy === undefined ? {} : { policy: options.policy }),
  };
}

function resolvedPolicy(profile: AgentProfile): ResolvedReviewer["policy"] {
  const candidate = profile as AgentProfile & {
    applicability?: {
      any_changed_paths: string[];
      case_sensitive?: boolean;
    };
    required_context?: string[];
    pass_quorum?: number;
    minimum_provider_groups?: number;
    adjudication?: "off" | "required";
    gate_minimum_severity?: "critical" | "high" | "medium" | "low";
    gate_minimum_confidence?: "high" | "medium" | "low";
  };
  if (
    !("model_runs" in profile) &&
    !("pass_quorum" in profile) &&
    !("applicability" in profile) &&
    !("required_context" in profile) &&
    !("adjudication" in profile) &&
    !("gate_minimum_severity" in profile) &&
    !("gate_minimum_confidence" in profile)
  )
    return undefined;
  const passQuorum =
    candidate.pass_quorum ??
    ("model_runs" in profile
      ? Math.min(2, profile.model_runs.length)
      : DEFAULT_PASS_QUORUM_POLICY.passQuorum);
  const distinctProviderGroups =
    "model_runs" in profile
      ? new Set(
          profile.model_runs.map(
            (run) => run.provider_group ?? run.adapter ?? profile.adapter,
          ),
        ).size
      : 1;
  const minimumProviderGroups =
    candidate.minimum_provider_groups ?? Math.min(2, distinctProviderGroups);
  const policy: NonNullable<ResolvedReviewer["policy"]> = {
    ...(candidate.applicability === undefined
      ? {}
      : {
          applicability: {
            anyChangedPaths: [...candidate.applicability.any_changed_paths],
            ...(candidate.applicability.case_sensitive === undefined
              ? {}
              : { caseSensitive: candidate.applicability.case_sensitive }),
          },
        }),
    ...(candidate.required_context === undefined
      ? {}
      : { requiredCallerContext: [...candidate.required_context] }),
    passQuorum,
    minimumProviderGroups,
    adjudication:
      candidate.adjudication ?? ("model_runs" in profile ? "required" : "off"),
    gateMinimumSeverity:
      candidate.gate_minimum_severity ??
      DEFAULT_GATE_THRESHOLDS.minimumSeverity,
    gateMinimumConfidence:
      candidate.gate_minimum_confidence ??
      DEFAULT_GATE_THRESHOLDS.minimumConfidence,
  };
  validateLensPolicy({
    ...(policy.applicability === undefined
      ? {}
      : { applicability: policy.applicability }),
    ...(policy.requiredCallerContext === undefined
      ? {}
      : { requiredCallerContext: policy.requiredCallerContext }),
    pass: {
      passQuorum: policy.passQuorum,
      minimumProviderGroups: policy.minimumProviderGroups,
    },
    gate: {
      minimumSeverity: policy.gateMinimumSeverity,
      minimumConfidence: policy.gateMinimumConfidence,
    },
  });
  return policy;
}

function resolveAgent(
  id: string,
  profile: AgentProfile,
  adapters: TrustedConfigV2["adapters"],
  projectInstructions?: string,
): ResolvedReviewer[] {
  configuredAdapter(id, profile.adapter, adapters);
  if ("model_runs" in profile) {
    const policy = resolvedPolicy(profile);
    return profile.model_runs.map((run, index) => {
      const adapterId = run.adapter ?? profile.adapter;
      const label = `agent ${id} model run ${run.id}`;
      const adapter = configuredAdapter(id, adapterId, adapters, label);
      validateAdapterEffort(adapter.type, run.effort, label);
      const reviewerId = `${id}::${run.id}`;
      return resolveReviewer(
        reviewerId,
        id,
        index,
        profile.model_runs.length,
        index === 0 ? undefined : `${id}::${profile.model_runs[index - 1]!.id}`,
        profile,
        adapterId,
        run.model,
        run.effort,
        adapters,
        projectInstructions,
        {
          providerGroup: run.provider_group ?? adapterId,
          ...(run.timeout_ms === undefined
            ? {}
            : { attemptTimeoutMs: run.timeout_ms }),
          ...(policy === undefined ? {} : { policy }),
        },
      );
    });
  }
  const policy = resolvedPolicy(profile);
  return [
    resolveReviewer(
      id,
      id,
      0,
      1,
      undefined,
      profile,
      profile.adapter,
      profile.model,
      profile.effort,
      adapters,
      projectInstructions,
      {
        providerGroup:
          ("provider_group" in profile ? profile.provider_group : undefined) ??
          profile.adapter,
        ...(policy === undefined ? {} : { policy }),
      },
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
  config: TrustedConfigV3 | TrustedConfigV4 | TrustedConfigV5,
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
      definition.id,
      0,
      1,
      undefined,
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
    execution: {
      ...config.execution,
      default_provider_concurrency: 2,
      provider_limits: {},
      circuit_breaker_threshold: 2,
      retry_attempts: 2,
      retry_backoff_ms: 1_000,
    },
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
  config: TrustedConfigV2 | TrustedConfigV3 | TrustedConfigV4 | TrustedConfigV5,
  workspace: string | undefined,
  projectName: string | undefined,
  projectNameSource: ResolveConfigInput["projectNameSource"],
): ResolvedConfig {
  if (
    config.schema_version === "3" ||
    config.schema_version === "4" ||
    config.schema_version === "5"
  ) {
    requireUniqueExpandedAgentIds(config);
  }
  const selectedByName =
    config.schema_version === "4" || config.schema_version === "5"
      ? selectProjectByName(config.projects, projectName)
      : undefined;
  const selectedByPath =
    config.schema_version === "4" || config.schema_version === "5"
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
    execution: {
      ...config.execution,
      default_provider_concurrency:
        "default_provider_concurrency" in config.execution
          ? (config.execution.default_provider_concurrency ?? 2)
          : 2,
      provider_limits:
        "provider_limits" in config.execution
          ? (config.execution.provider_limits ?? {})
          : {},
      circuit_breaker_threshold:
        "circuit_breaker_threshold" in config.execution
          ? (config.execution.circuit_breaker_threshold ?? 2)
          : 2,
      retry_attempts:
        "retry_attempts" in config.execution
          ? (config.execution.retry_attempts ?? 2)
          : 2,
      retry_backoff_ms:
        "retry_backoff_ms" in config.execution
          ? (config.execution.retry_backoff_ms ?? 1_000)
          : 1_000,
    },
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
