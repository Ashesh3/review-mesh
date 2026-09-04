import { z } from "zod";
import {
  isolationPolicySchema,
  type IsolationPolicy,
  type JsonValue,
} from "../protocol/schemas.js";

const nonEmptyString = z.string().min(1);
export const projectNameSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(
    /^(?!\.{1,2}$)(?!\s)(?!.*\s$)[^\u0000-\u001f/\\]+$/u,
    "project name must be trimmed and contain no path separators or control characters",
  )
  .describe(
    "Portable project-name key matched case-insensitively against the workspace's Git-derived repository name.",
  );
export const reasoningEffortSchema = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "persistent",
]);
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;
const positiveInteger = z.number().int().positive();
const nonNegativeInteger = z.number().int().nonnegative();
const maximumTimerMilliseconds = 2_147_483_647;
const timerMilliseconds = positiveInteger.max(maximumTimerMilliseconds);
const jsonRecordSchema = z.record(z.string(), z.json());
const safeModelRunId = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/,
    "model run id must contain only letters, numbers, underscores, and hyphens",
  );
const uniqueAgentIds = z
  .array(nonEmptyString)
  .min(1)
  .refine(
    (ids) => new Set(ids).size === ids.length,
    "agent ids must be unique",
  );

export const adapterRegistrationSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("copilot"),
    env_allowlist: z.array(nonEmptyString).optional(),
    use_logged_in_user: z.boolean().optional(),
  }),
  z.strictObject({
    type: z.literal("claude"),
    env_allowlist: z.array(nonEmptyString).optional(),
    executable: nonEmptyString.optional(),
  }),
  z.strictObject({
    type: z.literal("codex"),
    env_allowlist: z.array(nonEmptyString).optional(),
    executable: nonEmptyString.optional(),
  }),
  z.strictObject({
    type: z.literal("openai_compatible"),
    base_url_env: nonEmptyString,
    api_key_env: nonEmptyString,
    streaming: z.enum(["auto", "required", "disabled"]).optional(),
  }),
  z.strictObject({
    type: z.literal("command"),
    command: nonEmptyString,
    args: z.array(z.string()).optional(),
    env_allowlist: z.array(nonEmptyString).optional(),
    protocol: z.literal("review-mesh-command-v1"),
  }),
]);

const reviewerProfileBaseShape = {
  adapter: nonEmptyString,
  purpose: nonEmptyString,
  instructions: nonEmptyString.optional(),
  instructions_file: nonEmptyString.optional(),
  isolation: isolationPolicySchema,
  timeout_ms: timerMilliseconds,
  runtime: jsonRecordSchema.optional(),
};

function validateInstructionSource(
  profile: {
    instructions?: string | undefined;
    instructions_file?: string | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  if (
    (profile.instructions === undefined) ===
    (profile.instructions_file === undefined)
  ) {
    ctx.addIssue({
      code: "custom",
      message:
        "reviewer profile requires exactly one of instructions or instructions_file",
    });
  }
}

export const reviewerProfileSchema = z
  .strictObject({
    ...reviewerProfileBaseShape,
    model: nonEmptyString,
    effort: reasoningEffortSchema.optional(),
  })
  .superRefine(validateInstructionSource);

export const modelRunSchema = z.strictObject({
  id: safeModelRunId,
  adapter: nonEmptyString.optional(),
  model: nonEmptyString,
  effort: reasoningEffortSchema.optional(),
  provider_group: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/)
    .optional(),
  timeout_ms: timerMilliseconds.optional(),
});

const modelRunsSchema = z
  .array(modelRunSchema)
  .min(2, "multi-model agent requires at least two model runs")
  .refine(
    (runs) => new Set(runs.map((run) => run.id)).size === runs.length,
    "model run ids must be unique",
  );

const multiModelReviewerProfileSchema = z
  .strictObject({
    ...reviewerProfileBaseShape,
    model_runs: modelRunsSchema,
  })
  .superRefine(validateInstructionSource);

const lensPolicyShape = {
  applicability: z
    .strictObject({
      any_changed_paths: z.array(nonEmptyString).min(1).max(256),
      case_sensitive: z.boolean().optional(),
    })
    .optional(),
  required_context: z.array(nonEmptyString).max(256).optional(),
  pass_quorum: positiveInteger.optional(),
  minimum_provider_groups: positiveInteger.optional(),
  adjudication: z.enum(["off", "required"]).optional(),
  gate_minimum_severity: z
    .enum(["critical", "high", "medium", "low"])
    .optional(),
  gate_minimum_confidence: z.enum(["high", "medium", "low"]).optional(),
};

const applicabilityV6Schema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("always") }),
  z.strictObject({
    mode: z.literal("changed_paths"),
    any_changed_paths: z.array(nonEmptyString).min(1).max(256),
    case_sensitive: z.boolean().optional(),
  }),
]);

const lensPolicyV6Shape = {
  applicability: applicabilityV6Schema,
  required_context: z.array(nonEmptyString).max(256),
  pass_quorum: positiveInteger.optional(),
  minimum_provider_groups: positiveInteger.optional(),
  allow_zero_outage_tolerance: z.boolean().optional(),
  adjudication: z.enum(["off", "required"]).optional(),
  gate_minimum_severity: z
    .enum(["critical", "high", "medium", "low"])
    .optional(),
  gate_minimum_confidence: z.enum(["high", "medium", "low"]).optional(),
};

const reviewerProfileV5Schema = z
  .strictObject({
    ...reviewerProfileBaseShape,
    ...lensPolicyShape,
    model: nonEmptyString,
    effort: reasoningEffortSchema.optional(),
    provider_group: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/)
      .optional(),
  })
  .superRefine(validateInstructionSource)
  .superRefine((profile, ctx) => {
    if (profile.adjudication === "required") {
      ctx.addIssue({
        code: "custom",
        message: "required adjudication needs a multi-model agent",
      });
    }
  });

const multiModelReviewerProfileV5Schema = z
  .strictObject({
    ...reviewerProfileBaseShape,
    ...lensPolicyShape,
    model_runs: modelRunsSchema,
  })
  .superRefine(validateInstructionSource)
  .superRefine((profile, ctx) => {
    const providerGroups = new Set(
      profile.model_runs.map(
        (run) => run.provider_group ?? run.adapter ?? profile.adapter,
      ),
    );
    const quorum =
      profile.pass_quorum ?? Math.min(2, profile.model_runs.length);
    const groups =
      profile.minimum_provider_groups ?? Math.min(2, providerGroups.size);
    if (quorum > profile.model_runs.length) {
      ctx.addIssue({
        code: "custom",
        message: "pass quorum cannot exceed model run count",
      });
    }
    if (groups > quorum) {
      ctx.addIssue({
        code: "custom",
        message: "minimum provider groups cannot exceed pass quorum",
      });
    }
    if (providerGroups.size < groups) {
      ctx.addIssue({
        code: "custom",
        message:
          "minimum provider groups exceeds the distinct configured provider groups",
      });
    }
    if (profile.adjudication === "required" && providerGroups.size < 2) {
      ctx.addIssue({
        code: "custom",
        message: "required adjudication needs at least two provider groups",
      });
    }
  });

export const agentProfileV5Schema = z.union([
  reviewerProfileV5Schema,
  multiModelReviewerProfileV5Schema,
]);

function profileProviderGroups(profile: {
  adapter: string;
  model_runs: Array<{
    adapter?: string | undefined;
    provider_group?: string | undefined;
  }>;
}): string[] {
  return profile.model_runs.map(
    (run) => run.provider_group ?? run.adapter ?? profile.adapter,
  );
}

function v6DefaultPassQuorum(modelCount: number): number {
  return modelCount === 5 ? 3 : Math.min(2, modelCount);
}

function v6DefaultProviderGroups(
  modelCount: number,
  distinctProviderGroups: number,
): number {
  return modelCount === 5 ? 3 : Math.min(2, distinctProviderGroups);
}

function addMultiModelPolicyIssues(
  profile: {
    adapter: string;
    model_runs: Array<{
      adapter?: string | undefined;
      provider_group?: string | undefined;
    }>;
    pass_quorum?: number | undefined;
    minimum_provider_groups?: number | undefined;
    adjudication?: "off" | "required" | undefined;
    allow_zero_outage_tolerance?: boolean | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  const providerGroups = profileProviderGroups(profile);
  const distinctProviderGroups = new Set(providerGroups).size;
  const quorum =
    profile.pass_quorum ?? v6DefaultPassQuorum(profile.model_runs.length);
  const groups =
    profile.minimum_provider_groups ??
    v6DefaultProviderGroups(profile.model_runs.length, distinctProviderGroups);
  if (quorum > profile.model_runs.length) {
    ctx.addIssue({
      code: "custom",
      message: "pass quorum cannot exceed model run count",
    });
  }
  if (groups > quorum) {
    ctx.addIssue({
      code: "custom",
      message: "minimum provider groups cannot exceed pass quorum",
    });
  }
  if (distinctProviderGroups < groups) {
    ctx.addIssue({
      code: "custom",
      message:
        "minimum provider groups exceeds the distinct configured provider groups",
    });
  }
  if (profile.adjudication === "required" && distinctProviderGroups < 2) {
    ctx.addIssue({
      code: "custom",
      message: "required adjudication needs at least two provider groups",
    });
  }
  if (
    distinctProviderGroups > 1 &&
    quorum <= providerGroups.length &&
    groups <= distinctProviderGroups
  ) {
    const counts = [...new Set(providerGroups)].map(
      (group) =>
        providerGroups.filter((candidate) => candidate === group).length,
    );
    const largest = Math.max(...counts);
    const toleratesOneProvider =
      providerGroups.length - largest >= quorum &&
      distinctProviderGroups - 1 >= groups;
    if (!toleratesOneProvider && profile.allow_zero_outage_tolerance !== true) {
      ctx.addIssue({
        code: "custom",
        message:
          "multi-provider lens has zero provider-outage tolerance; set allow_zero_outage_tolerance = true to acknowledge it",
      });
    }
  }
}

const reviewerProfileV6Schema = z
  .strictObject({
    ...reviewerProfileBaseShape,
    ...lensPolicyV6Shape,
    model: nonEmptyString,
    effort: reasoningEffortSchema.optional(),
    provider_group: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/)
      .optional(),
  })
  .superRefine(validateInstructionSource)
  .superRefine((profile, ctx) => {
    if ((profile.pass_quorum ?? 1) > 1) {
      ctx.addIssue({
        code: "custom",
        message: "pass quorum cannot exceed model run count",
      });
    }
    if ((profile.minimum_provider_groups ?? 1) > 1) {
      ctx.addIssue({
        code: "custom",
        message:
          "minimum provider groups exceeds the distinct configured provider groups",
      });
    }
    if (profile.adjudication === "required") {
      ctx.addIssue({
        code: "custom",
        message: "required adjudication needs a multi-model agent",
      });
    }
  });

const multiModelReviewerProfileV6BaseSchema = z.strictObject({
  ...reviewerProfileBaseShape,
  ...lensPolicyV6Shape,
  model_runs: modelRunsSchema,
});

const multiModelReviewerProfileV6Schema = multiModelReviewerProfileV6BaseSchema
  .superRefine(validateInstructionSource)
  .superRefine(addMultiModelPolicyIssues);

export const agentProfileV6Schema = z.union([
  reviewerProfileV6Schema,
  multiModelReviewerProfileV6Schema,
]);

export const agentProfileSchema = z.union([
  reviewerProfileSchema,
  multiModelReviewerProfileSchema,
]);

export const trustedReviewerDefinitionSchema = z.strictObject({
  id: nonEmptyString,
  profile: nonEmptyString,
  append_instructions: nonEmptyString.optional(),
});

const executionSchema = z.strictObject({
  max_concurrency: positiveInteger,
  heartbeat_interval_ms: timerMilliseconds,
  shutdown_grace_period_ms: timerMilliseconds,
});

const executionV5Schema = executionSchema.extend({
  distribute_primaries: z.boolean().optional(),
  default_provider_concurrency: positiveInteger.optional(),
  provider_limits: z.record(nonEmptyString, positiveInteger).optional(),
  circuit_breaker_threshold: positiveInteger.optional(),
  circuit_breaker_cooldown_ms: timerMilliseconds.optional(),
  retry_attempts: positiveInteger.max(10).optional(),
  retry_backoff_ms: nonNegativeInteger.max(maximumTimerMilliseconds).optional(),
});

const executionV6Schema = executionV5Schema.extend({
  allow_provider_concentration: z.boolean().optional(),
  continuation_attempts: positiveInteger.max(10).optional(),
});

const requiredReadinessSelectors = [
  "/request/pull_request/id",
  "/request/pull_request/url",
  "/request/pull_request/title",
  "/request/pull_request/description",
  "/request/pull_request/work_items",
  "/request/pull_request/validation",
  "/request/pull_request/contract_impact",
] as const;

const executionV7Schema = executionV6Schema
  .extend({
    heartbeat_interval_ms: positiveInteger.min(1_000).max(300_000),
    deadline_mode: z.enum(["adaptive", "fixed"]),
    run_deadline_ms: positiveInteger.min(60_000).max(14_400_000).optional(),
    no_progress_timeout_ms: positiveInteger.min(1_000).max(3_600_000),
  })
  .superRefine((execution, ctx) => {
    if (
      execution.deadline_mode === "fixed" &&
      execution.run_deadline_ms === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["run_deadline_ms"],
        message: "fixed deadline mode requires run_deadline_ms",
      });
    }
    if (
      execution.deadline_mode === "adaptive" &&
      execution.run_deadline_ms !== undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["run_deadline_ms"],
        message: "adaptive deadline mode does not accept run_deadline_ms",
      });
    }
  });

const changeCoveragePolicySchema = z.strictObject({
  relevant_paths: z.array(nonEmptyString).min(1).max(256),
  minimum_inspection: z.enum(["full_file", "diff"]),
  proof: z.enum(["observed", "attested"]),
});

const lensPolicyV7Shape = {
  applicability: applicabilityV6Schema,
  kind: z.enum(["generic", "change_readiness"]),
  required_input: z.array(nonEmptyString).max(256),
  lens_deadline_ms: positiveInteger.min(1_000).max(14_400_000).optional(),
  change_coverage: changeCoveragePolicySchema,
  pass_quorum: positiveInteger.optional(),
  minimum_provider_groups: positiveInteger.optional(),
  allow_zero_outage_tolerance: z.boolean().optional(),
  adjudication: z.enum(["off", "required"]).optional(),
  gate_minimum_severity: z
    .enum(["critical", "high", "medium", "low"])
    .optional(),
  gate_minimum_confidence: z.enum(["high", "medium", "low"]).optional(),
};

function validateV7Lens(
  profile: {
    kind: "generic" | "change_readiness";
    required_input: string[];
  },
  ctx: z.RefinementCtx,
): void {
  if (profile.kind !== "change_readiness") return;
  for (const selector of requiredReadinessSelectors) {
    if (!profile.required_input.includes(selector)) {
      ctx.addIssue({
        code: "custom",
        path: ["required_input"],
        message: `change-readiness lens requires selector ${selector}`,
      });
    }
  }
}

const reviewerProfileV7Schema = z
  .strictObject({
    ...reviewerProfileBaseShape,
    ...lensPolicyV7Shape,
    model: nonEmptyString,
    effort: reasoningEffortSchema.optional(),
    provider_group: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/)
      .optional(),
  })
  .superRefine(validateInstructionSource)
  .superRefine(validateV7Lens)
  .superRefine((profile, ctx) => {
    if ((profile.pass_quorum ?? 1) > 1)
      ctx.addIssue({
        code: "custom",
        message: "pass quorum cannot exceed model run count",
      });
    if ((profile.minimum_provider_groups ?? 1) > 1)
      ctx.addIssue({
        code: "custom",
        message:
          "minimum provider groups exceeds the distinct configured provider groups",
      });
    if (profile.adjudication === "required")
      ctx.addIssue({
        code: "custom",
        message: "required adjudication needs a multi-model agent",
      });
  });

const multiModelReviewerProfileV7Schema = z
  .strictObject({
    ...reviewerProfileBaseShape,
    ...lensPolicyV7Shape,
    model_runs: modelRunsSchema,
  })
  .superRefine(validateInstructionSource)
  .superRefine(validateV7Lens)
  .superRefine(addMultiModelPolicyIssues);

export const agentProfileV7Schema = z.union([
  reviewerProfileV7Schema,
  multiModelReviewerProfileV7Schema,
]);

const diagnosticsSchema = z.strictObject({
  persist_runs: z.boolean(),
  max_runs: positiveInteger,
});

const diagnosticsV7Schema = diagnosticsSchema.extend({
  activity_detail: z.enum(["condensed", "full"]).optional(),
});

export const trustedConfigV1Schema = z.strictObject({
  schema_version: z.literal("1"),
  execution: executionSchema,
  diagnostics: diagnosticsSchema,
  adapters: z.record(nonEmptyString, adapterRegistrationSchema),
  reviewer_profiles: z.record(nonEmptyString, reviewerProfileSchema),
  reviewers: z.array(trustedReviewerDefinitionSchema).min(1),
});

export const projectConfigSchema = z
  .strictObject({
    agents: uniqueAgentIds.optional(),
    instructions: nonEmptyString.optional(),
    instructions_file: nonEmptyString.optional(),
    context: z.json().optional(),
  })
  .superRefine((project, ctx) => {
    if (
      project.instructions !== undefined &&
      project.instructions_file !== undefined
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "project permits only one of instructions or instructions_file",
      });
    }
  });

export const trustedConfigV2Schema = z.strictObject({
  schema_version: z.literal("2"),
  execution: executionSchema,
  diagnostics: diagnosticsSchema,
  adapters: z.record(nonEmptyString, adapterRegistrationSchema),
  agents: z.record(nonEmptyString, reviewerProfileSchema),
  defaults: z.strictObject({ agents: uniqueAgentIds }).optional(),
  projects: z.record(nonEmptyString, projectConfigSchema).optional(),
});

export const trustedConfigV3Schema = z.strictObject({
  schema_version: z.literal("3"),
  execution: executionSchema,
  diagnostics: diagnosticsSchema,
  adapters: z.record(nonEmptyString, adapterRegistrationSchema),
  agents: z.record(nonEmptyString, agentProfileSchema),
  defaults: z.strictObject({ agents: uniqueAgentIds }).optional(),
  projects: z.record(nonEmptyString, projectConfigSchema).optional(),
});

export const trustedConfigV4Schema = z.strictObject({
  schema_version: z.literal("4"),
  execution: executionSchema,
  diagnostics: diagnosticsSchema,
  adapters: z.record(nonEmptyString, adapterRegistrationSchema),
  agents: z.record(nonEmptyString, agentProfileSchema),
  defaults: z.strictObject({ agents: uniqueAgentIds }).optional(),
  projects: z.record(projectNameSchema, projectConfigSchema).optional(),
});

export const trustedConfigV5Schema = z.strictObject({
  schema_version: z.literal("5"),
  execution: executionV5Schema,
  diagnostics: diagnosticsSchema,
  adapters: z.record(nonEmptyString, adapterRegistrationSchema),
  agents: z.record(nonEmptyString, agentProfileV5Schema),
  defaults: z.strictObject({ agents: uniqueAgentIds }).optional(),
  projects: z.record(projectNameSchema, projectConfigSchema).optional(),
});

function providerGroupForScalar(profile: {
  adapter: string;
  provider_group?: string | undefined;
}): string {
  return profile.provider_group ?? profile.adapter;
}

function assignedAgentRosters(config: {
  defaults?: { agents: string[] } | undefined;
  projects?: Record<string, { agents?: string[] | undefined }> | undefined;
}): string[][] {
  const rosters: string[][] = [];
  if (config.defaults !== undefined) rosters.push(config.defaults.agents);
  for (const project of Object.values(config.projects ?? {})) {
    if (project.agents !== undefined) rosters.push(project.agents);
  }
  const unique = new Map<string, string[]>();
  for (const roster of rosters) unique.set(JSON.stringify(roster), roster);
  return [...unique.values()];
}

type ConcentrationConfig = {
  execution: {
    allow_provider_concentration?: boolean | undefined;
    distribute_primaries?: boolean | undefined;
  };
  agents: Record<
    string,
    | { adapter: string; provider_group?: string | undefined }
    | {
        adapter: string;
        model_runs: Array<{
          adapter?: string | undefined;
          provider_group?: string | undefined;
        }>;
      }
  >;
  defaults?: { agents: string[] } | undefined;
  projects?: Record<string, { agents?: string[] | undefined }> | undefined;
};

function validateProviderConcentration(
  config: ConcentrationConfig,
  ctx: z.RefinementCtx,
): void {
  if (config.execution.allow_provider_concentration === true) return;
  const distributePrimaries = config.execution.distribute_primaries ?? true;
  for (const roster of assignedAgentRosters(config)) {
    if (roster.length < 2) continue;
    let rotatableLensIndex = 0;
    const allProviderGroups = new Set<string>();
    const primaryProviderGroups = new Set<string>();
    let completeRoster = true;
    for (const agentId of roster) {
      const profile = config.agents[agentId];
      if (profile === undefined) {
        completeRoster = false;
        break;
      }
      if ("model_runs" in profile) {
        const providerGroups = profileProviderGroups(profile);
        for (const group of providerGroups) allProviderGroups.add(group);
        const primaryIndex = distributePrimaries
          ? rotatableLensIndex++ % providerGroups.length
          : 0;
        primaryProviderGroups.add(providerGroups[primaryIndex]!);
      } else {
        const group = providerGroupForScalar(profile);
        allProviderGroups.add(group);
        primaryProviderGroups.add(group);
      }
    }
    if (
      completeRoster &&
      allProviderGroups.size > 1 &&
      primaryProviderGroups.size === 1
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["execution", "allow_provider_concentration"],
        message:
          "multi-lens, multi-provider suite concentrates every primary on one provider group; set allow_provider_concentration = true to acknowledge it",
      });
      return;
    }
  }
}

export const trustedConfigV6Schema = z
  .strictObject({
    schema_version: z.literal("6"),
    execution: executionV6Schema,
    diagnostics: diagnosticsSchema,
    adapters: z.record(nonEmptyString, adapterRegistrationSchema),
    agents: z.record(nonEmptyString, agentProfileV6Schema),
    defaults: z.strictObject({ agents: uniqueAgentIds }).optional(),
    projects: z.record(projectNameSchema, projectConfigSchema).optional(),
  })
  .superRefine(validateProviderConcentration);

function adapterProvidesObservedReads(adapter: AdapterRegistration): boolean {
  return (
    adapter.type === "openai_compatible" ||
    adapter.type === "claude" ||
    adapter.type === "copilot"
  );
}

export const trustedConfigV7Schema = z
  .strictObject({
    schema_version: z.literal("7"),
    execution: executionV7Schema,
    diagnostics: diagnosticsV7Schema,
    adapters: z.record(nonEmptyString, adapterRegistrationSchema),
    agents: z.record(nonEmptyString, agentProfileV7Schema),
    defaults: z.strictObject({ agents: uniqueAgentIds }).optional(),
    projects: z.record(projectNameSchema, projectConfigSchema).optional(),
  })
  .superRefine((config, ctx) => {
    validateProviderConcentration(config, ctx);
    for (const [agentId, profile] of Object.entries(config.agents)) {
      const candidateIds =
        "model_runs" in profile
          ? profile.model_runs.map((run) => `${agentId}::${run.id}`)
          : [agentId];
      if (candidateIds.some((id) => Buffer.byteLength(id, "utf8") > 128)) {
        ctx.addIssue({
          code: "custom",
          path: ["agents", agentId],
          message: "expanded reviewer id exceeds 128 UTF-8 bytes",
        });
      }
      if (profile.change_coverage.proof !== "observed") continue;
      const adapterIds =
        "model_runs" in profile
          ? profile.model_runs.map((run) => run.adapter ?? profile.adapter)
          : [profile.adapter];
      for (const adapterId of adapterIds) {
        const adapter = Object.hasOwn(config.adapters, adapterId)
          ? config.adapters[adapterId]
          : undefined;
        if (adapter !== undefined && !adapterProvidesObservedReads(adapter)) {
          ctx.addIssue({
            code: "custom",
            path: ["agents", agentId, "change_coverage", "proof"],
            message: `observed proof is unsupported by adapter ${adapterId}`,
          });
        }
      }
    }
  });

export const trustedConfigSchema = z.union([
  trustedConfigV1Schema,
  trustedConfigV2Schema,
  trustedConfigV3Schema,
  trustedConfigV4Schema,
  trustedConfigV5Schema,
  trustedConfigV6Schema,
  trustedConfigV7Schema,
]);

export type TrustedConfigV1 = z.infer<typeof trustedConfigV1Schema>;
export type TrustedConfigV2 = z.infer<typeof trustedConfigV2Schema>;
export type TrustedConfigV3 = z.infer<typeof trustedConfigV3Schema>;
export type TrustedConfigV4 = z.infer<typeof trustedConfigV4Schema>;
export type TrustedConfigV5 = z.infer<typeof trustedConfigV5Schema>;
export type TrustedConfigV6 = z.infer<typeof trustedConfigV6Schema>;
export type TrustedConfigV7 = z.infer<typeof trustedConfigV7Schema>;
export type ProjectConfig = z.infer<typeof projectConfigSchema>;
export type TrustedConfig = z.infer<typeof trustedConfigSchema>;

export type TrustedReviewerDefinition = z.infer<
  typeof trustedReviewerDefinitionSchema
>;

export type AdapterRegistration = z.infer<typeof adapterRegistrationSchema>;
export type ReviewerProfile = z.infer<typeof reviewerProfileSchema>;
export type ModelRun = z.infer<typeof modelRunSchema>;
export type AgentProfile =
  | z.infer<typeof agentProfileSchema>
  | z.infer<typeof agentProfileV5Schema>
  | z.infer<typeof agentProfileV6Schema>
  | z.infer<typeof agentProfileV7Schema>;
export type AgentProfileV5 = z.infer<typeof agentProfileV5Schema>;

const adapterEffortSupport = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: [
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "ultra",
    "persistent",
  ],
} as const satisfies Partial<
  Record<AdapterRegistration["type"], readonly ReasoningEffort[]>
>;

export function supportedEffortsForAdapter(
  type: AdapterRegistration["type"],
): readonly ReasoningEffort[] | undefined {
  return adapterEffortSupport[type as keyof typeof adapterEffortSupport];
}

export function validateAdapterEffort(
  type: AdapterRegistration["type"],
  effort: ReasoningEffort | undefined,
  label: string,
): void {
  if (effort === undefined) return;
  const supported = supportedEffortsForAdapter(type);
  if (supported !== undefined && !supported.includes(effort)) {
    throw new Error(`${label} configures unsupported ${type} effort ${effort}`);
  }
}

export interface ResolvedReviewer {
  id: string;
  agentId?: string;
  modelIndex?: number;
  configuredModelIndex?: number;
  modelCount?: number;
  previousReviewerId?: string;
  providerGroup?: string;
  attemptTimeoutMs?: number;
  purpose: string;
  adapterId: string;
  adapter: AdapterRegistration;
  model: string;
  effort?: ReasoningEffort;
  instruction_layers: Array<{
    source: "trusted" | "project";
    content: string;
  }>;
  isolationPolicy: IsolationPolicy;
  timeoutMs: number;
  runtime: Record<string, JsonValue>;
  policy?: {
    kind?: "generic" | "change_readiness";
    lensDeadlineMs?: number;
    requiredInput?: string[];
    changeCoverage?: {
      relevantPaths: string[];
      minimumInspection: "full_file" | "diff";
      proof: "observed" | "attested";
    };
    applicability?:
      | { mode: "always" }
      | {
          mode: "changed_paths";
          anyChangedPaths: string[];
          caseSensitive?: boolean;
        };
    requiredCallerContext?: string[];
    passQuorum: number;
    minimumProviderGroups: number;
    allowZeroOutageTolerance?: boolean;
    adjudication: "off" | "required";
    gateMinimumSeverity: "critical" | "high" | "medium" | "low";
    gateMinimumConfidence: "high" | "medium" | "low";
    mode?: "full_review" | "adjudication";
    adjudicatesReviewerId?: string;
    candidateFindings?: JsonValue;
  };
}

export interface ResolvedConfig {
  sourceSchemaVersion?: TrustedConfig["schema_version"];
  migrated?: boolean;
  migrationWarnings?: Array<{
    code:
      | "implicit_v9_deadline"
      | "implicit_v9_change_coverage"
      | "attested_coverage_requires_adapter_upgrade";
    message: string;
    lens_ids: string[];
  }>;
  execution: TrustedConfigV1["execution"] & {
    distribute_primaries: boolean;
    allow_provider_concentration: boolean;
    default_provider_concurrency: number;
    provider_limits: Record<string, number>;
    circuit_breaker_threshold: number;
    circuit_breaker_cooldown_ms: number;
    retry_attempts: number;
    continuation_attempts: number;
    retry_backoff_ms: number;
    deadline_mode?: "adaptive" | "fixed" | undefined;
    run_deadline_ms?: number | undefined;
    no_progress_timeout_ms?: number | undefined;
  };
  diagnostics: TrustedConfigV1["diagnostics"] & {
    activity_detail?: "condensed" | "full" | undefined;
  };
  selection?: {
    source: "legacy" | "defaults" | "project";
    projectName?: string;
    projectNameSource?:
      "git_remote" | "git_common_directory" | "git_root" | "workspace";
    matchedProjectName?: string;
  };
  project_context?: JsonValue;
  reviewers: ResolvedReviewer[];
}

export const configRevisionSchema = z.union([
  z.literal("missing"),
  z.string().regex(/^[a-f0-9]{64}$/),
]);

export const configApplyRequestSchema = z.strictObject({
  schema_version: z.literal("1"),
  expected_revision: configRevisionSchema,
  confirm_attested_coverage: z.boolean().optional(),
  config: z.union([
    trustedConfigV1Schema,
    trustedConfigV2Schema,
    trustedConfigV3Schema,
    trustedConfigV4Schema,
    trustedConfigV5Schema,
    trustedConfigV6Schema,
    trustedConfigV7Schema,
  ]),
});

export const configApplyEnvelopeSchema = z.strictObject({
  schema_version: z.literal("1"),
  expected_revision: configRevisionSchema,
  config: z.unknown(),
  confirm_attested_coverage: z.boolean().optional(),
});
