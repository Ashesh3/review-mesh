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
  retry_attempts: positiveInteger.max(10).optional(),
  retry_backoff_ms: nonNegativeInteger.max(maximumTimerMilliseconds).optional(),
});

const diagnosticsSchema = z.strictObject({
  persist_runs: z.boolean(),
  max_runs: positiveInteger,
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

export const trustedConfigSchema = z.union([
  trustedConfigV1Schema,
  trustedConfigV2Schema,
  trustedConfigV3Schema,
  trustedConfigV4Schema,
  trustedConfigV5Schema,
]);

export type TrustedConfigV1 = z.infer<typeof trustedConfigV1Schema>;
export type TrustedConfigV2 = z.infer<typeof trustedConfigV2Schema>;
export type TrustedConfigV3 = z.infer<typeof trustedConfigV3Schema>;
export type TrustedConfigV4 = z.infer<typeof trustedConfigV4Schema>;
export type TrustedConfigV5 = z.infer<typeof trustedConfigV5Schema>;
export type ProjectConfig = z.infer<typeof projectConfigSchema>;
export type TrustedConfig = z.infer<typeof trustedConfigSchema>;

export type TrustedReviewerDefinition = z.infer<
  typeof trustedReviewerDefinitionSchema
>;

export type AdapterRegistration = z.infer<typeof adapterRegistrationSchema>;
export type ReviewerProfile = z.infer<typeof reviewerProfileSchema>;
export type ModelRun = z.infer<typeof modelRunSchema>;
export type AgentProfile =
  z.infer<typeof agentProfileSchema> | z.infer<typeof agentProfileV5Schema>;
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
    applicability?: {
      anyChangedPaths: string[];
      caseSensitive?: boolean;
    };
    requiredCallerContext?: string[];
    passQuorum: number;
    minimumProviderGroups: number;
    adjudication: "off" | "required";
    gateMinimumSeverity: "critical" | "high" | "medium" | "low";
    gateMinimumConfidence: "high" | "medium" | "low";
    mode?: "full_review" | "adjudication";
    adjudicatesReviewerId?: string;
    candidateFindings?: JsonValue;
  };
}

export interface ResolvedConfig {
  execution: TrustedConfigV1["execution"] & {
    distribute_primaries: boolean;
    default_provider_concurrency: number;
    provider_limits: Record<string, number>;
    circuit_breaker_threshold: number;
    retry_attempts: number;
    retry_backoff_ms: number;
  };
  diagnostics: TrustedConfigV1["diagnostics"];
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
  config: z.union([
    trustedConfigV2Schema,
    trustedConfigV3Schema,
    trustedConfigV4Schema,
    trustedConfigV5Schema,
  ]),
});
