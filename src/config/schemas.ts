import { z } from "zod";
import {
  isolationPolicySchema,
  protocolVersionSchema,
  type IsolationPolicy,
  type JsonValue,
} from "../protocol/schemas.js";

const nonEmptyString = z.string().min(1);
const positiveInteger = z.number().int().positive();
const maximumTimerMilliseconds = 2_147_483_647;
const timerMilliseconds = positiveInteger.max(maximumTimerMilliseconds);
const jsonRecordSchema = z.record(z.string(), z.json());

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

export const trustedConfigSchema = z.strictObject({
  schema_version: protocolVersionSchema,
  execution: z.strictObject({
    max_concurrency: positiveInteger,
    heartbeat_interval_ms: timerMilliseconds,
    shutdown_grace_period_ms: timerMilliseconds,
  }),
  diagnostics: z.strictObject({
    persist_runs: z.boolean(),
    max_runs: positiveInteger,
  }),
  adapters: z.record(nonEmptyString, adapterRegistrationSchema),
  reviewer_profiles: z.record(nonEmptyString, reviewerProfileSchema),
  reviewers: z.array(trustedReviewerDefinitionSchema).min(1),
});

const repositoryReviewerSchema = z.strictObject({
  id: nonEmptyString,
  profile: nonEmptyString,
  instructions: nonEmptyString.optional(),
  append_instructions: nonEmptyString.optional(),
  timeout_ms: timerMilliseconds.optional(),
  require_enforced: z.literal(true).optional(),
});

const repositoryReviewerOverrideSchema = z
  .strictObject({
    id: nonEmptyString,
    append_instructions: nonEmptyString.optional(),
    timeout_ms: timerMilliseconds.optional(),
    require_enforced: z.literal(true).optional(),
  })
  .refine(
    (override) =>
      override.append_instructions !== undefined ||
      override.timeout_ms !== undefined ||
      override.require_enforced !== undefined,
    "repository reviewer override must change an allowed additive setting",
  );

export const repositoryPolicySchema = z.strictObject({
  schema_version: protocolVersionSchema,
  context: z.json().optional(),
  reviewers: z.array(repositoryReviewerSchema).optional(),
  reviewer_overrides: z.array(repositoryReviewerOverrideSchema).optional(),
});

export type AdapterRegistration = z.infer<typeof adapterRegistrationSchema>;
export type ReviewerProfile = z.infer<typeof reviewerProfileSchema>;
export type TrustedReviewerDefinition = z.infer<
  typeof trustedReviewerDefinitionSchema
>;
export type TrustedConfig = z.infer<typeof trustedConfigSchema>;
export type RepositoryReviewer = z.infer<typeof repositoryReviewerSchema>;
export type RepositoryReviewerOverride = z.infer<
  typeof repositoryReviewerOverrideSchema
>;
export type RepositoryPolicy = z.infer<typeof repositoryPolicySchema>;

export interface ResolvedReviewer {
  id: string;
  purpose: string;
  adapterId: string;
  adapter: AdapterRegistration;
  model: string;
  instruction_layers: Array<{
    source: "trusted" | "repository";
    content: string;
  }>;
  isolationPolicy: IsolationPolicy;
  timeoutMs: number;
  runtime: Record<string, JsonValue>;
}

export interface ResolvedConfig {
  execution: TrustedConfig["execution"];
  diagnostics: TrustedConfig["diagnostics"];
  repository_context?: JsonValue;
  reviewers: ResolvedReviewer[];
}
