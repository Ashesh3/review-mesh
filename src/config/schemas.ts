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

export const reviewerProfileSchema = z
  .strictObject({
    adapter: nonEmptyString,
    model: nonEmptyString,
    effort: reasoningEffortSchema.optional(),
    purpose: nonEmptyString,
    instructions: nonEmptyString.optional(),
    instructions_file: nonEmptyString.optional(),
    isolation: isolationPolicySchema,
    timeout_ms: timerMilliseconds,
    runtime: jsonRecordSchema.optional(),
  })
  .superRefine((profile, ctx) => {
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
  });

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

export const trustedConfigSchema = z.union([
  trustedConfigV1Schema,
  trustedConfigV2Schema,
]);

export type TrustedConfigV1 = z.infer<typeof trustedConfigV1Schema>;
export type TrustedConfigV2 = z.infer<typeof trustedConfigV2Schema>;
export type ProjectConfig = z.infer<typeof projectConfigSchema>;
export type TrustedConfig = z.infer<typeof trustedConfigSchema>;

export type TrustedReviewerDefinition = z.infer<
  typeof trustedReviewerDefinitionSchema
>;

export type AdapterRegistration = z.infer<typeof adapterRegistrationSchema>;
export type ReviewerProfile = z.infer<typeof reviewerProfileSchema>;

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
  project_context?: JsonValue;
  reviewers: ResolvedReviewer[];
}
