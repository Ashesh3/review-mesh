import { z } from "zod";
import {
  isolationPolicySchema,
  type IsolationPolicy,
  type JsonValue,
} from "../protocol/schemas.js";

const nonEmptyString = z.string().min(1);
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

export const trustedConfigSchema = z.union([
  trustedConfigV1Schema,
  trustedConfigV2Schema,
  trustedConfigV3Schema,
]);

export type TrustedConfigV1 = z.infer<typeof trustedConfigV1Schema>;
export type TrustedConfigV2 = z.infer<typeof trustedConfigV2Schema>;
export type TrustedConfigV3 = z.infer<typeof trustedConfigV3Schema>;
export type ProjectConfig = z.infer<typeof projectConfigSchema>;
export type TrustedConfig = z.infer<typeof trustedConfigSchema>;

export type TrustedReviewerDefinition = z.infer<
  typeof trustedReviewerDefinitionSchema
>;

export type AdapterRegistration = z.infer<typeof adapterRegistrationSchema>;
export type ReviewerProfile = z.infer<typeof reviewerProfileSchema>;
export type ModelRun = z.infer<typeof modelRunSchema>;
export type AgentProfile = z.infer<typeof agentProfileSchema>;

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
}

export interface ResolvedConfig {
  execution: TrustedConfigV1["execution"];
  diagnostics: TrustedConfigV1["diagnostics"];
  selection?: {
    source: "legacy" | "defaults" | "project";
    matchedProjectPath?: string;
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
  config: z.union([trustedConfigV2Schema, trustedConfigV3Schema]),
});
