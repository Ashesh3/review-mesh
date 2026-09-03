import { z } from "zod";
import {
  configApplyRequestSchema,
  trustedConfigSchema,
} from "../config/schemas.js";
import {
  publicEventSchema,
  reviewerResultSchema,
  reviewRequestV2Schema,
} from "../protocol/schemas.js";

const runStatusReviewerSchema = z.strictObject({
  reviewer_id: z.string().min(1),
  purpose: z.string().min(1).optional(),
  adapter: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  state: z.enum([
    "deferred",
    "queued",
    "probing",
    "starting",
    "reviewing",
    "validating",
    "completed",
    "incomplete",
    "skipped",
  ]),
  last_event_seq: z.number().int().positive().optional(),
  last_event_at: z.iso.datetime({ offset: true }).optional(),
  last_activity_message: z.string().min(1).max(1_000).optional(),
  attempt: z.number().int().positive().optional(),
  elapsed_ms: z.number().int().nonnegative().optional(),
  isolation: z
    .enum(["enforced_read_only", "runtime_read_only", "prompt_only"])
    .optional(),
  result: z
    .strictObject({
      verdict: z.enum(["pass", "fail"]),
      summary: z.string().min(1),
      actionable_findings: z.number().int().nonnegative(),
      informational_notes: z.number().int().nonnegative(),
    })
    .optional(),
  complete_result: reviewerResultSchema.optional(),
  failure: z
    .strictObject({
      reason: z.string().min(1),
      message: z.string().min(1).max(1_000),
      retryable: z.boolean(),
    })
    .optional(),
  skipped: z
    .strictObject({
      reason: z.string().min(1),
      blocked_by_reviewer_id: z.string().min(1).optional(),
      missing_inputs: z.array(z.string().min(1)).optional(),
    })
    .optional(),
  attempts: z
    .array(
      z.strictObject({
        attempt: z.number().int().positive(),
        started_at: z.iso.datetime({ offset: true }).optional(),
        elapsed_ms: z.number().int().nonnegative(),
        failure: z.record(z.string(), z.unknown()),
      }),
    )
    .max(8)
    .optional(),
  cause: z
    .strictObject({
      kind: z.enum(["root_failure", "downstream_effect"]),
      reviewer_id: z.string().min(1),
      reason: z.string().min(1).optional(),
    })
    .optional(),
});

const runStatusSchema = z.strictObject({
  schema_version: z.enum(["1", "2"]),
  kind: z.literal("review-mesh.run-status"),
  run_id: z.string().min(1),
  active: z.boolean(),
  status: z.enum(["running", "passed", "findings", "incomplete"]),
  gate_outcome: z.enum(["no_findings", "findings"]).optional(),
  coverage_outcome: z.enum(["complete", "partial"]).optional(),
  exit_code: z.number().int().nonnegative().optional(),
  total_elapsed_ms: z.number().int().nonnegative().optional(),
  suite: z
    .strictObject({
      total: z.number().int().nonnegative(),
      deferred: z.number().int().nonnegative(),
      queued: z.number().int().nonnegative(),
      running: z.number().int().nonnegative(),
      completed: z.number().int().nonnegative(),
      incomplete: z.number().int().nonnegative(),
      skipped: z.number().int().nonnegative(),
    })
    .optional(),
  model_runs: z.record(z.string(), z.unknown()).optional(),
  logical_lenses: z.record(z.string(), z.unknown()).optional(),
  reviewers: z.array(runStatusReviewerSchema),
  reviewer_id: z.string().min(1).optional(),
  last_seq: z.number().int().nonnegative(),
});

const diagnosticSchema = z.strictObject({
  schema_version: z.literal("1"),
  kind: z.literal("review-mesh.diagnostic"),
  error: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean(),
  help_command: z.string().min(1).optional(),
  next_actions: z.array(z.string().min(1)).optional(),
  current_revision: z.string().min(1).optional(),
  config_file: z.string().min(1).optional(),
  line: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
  record_type: z.string().min(1).max(128).optional(),
  schema_paths: z.array(z.string().min(1).max(256)).max(8).optional(),
  issues: z
    .array(
      z.strictObject({
        path: z.string(),
        code: z.string().min(1),
        message: z.string().min(1),
      }),
    )
    .optional(),
});

const commandAdapterEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("capabilities"),
    isolation: z.enum([
      "enforced_read_only",
      "runtime_read_only",
      "prompt_only",
    ]),
  }),
  z.strictObject({
    type: z.literal("progress"),
    phase: z.string().min(1),
    message: z.string().min(1).optional(),
  }),
  z.strictObject({ type: z.literal("activity"), message: z.string().min(1) }),
  z.strictObject({ type: z.literal("result"), result: reviewerResultSchema }),
  z.strictObject({
    type: z.literal("failure"),
    failure: z.strictObject({
      reason: z.string().min(1),
      message: z.string().min(1),
      retryable: z.boolean(),
    }),
  }),
]);

export const schemaNames = [
  "request",
  "events",
  "run-status",
  "result",
  "config",
  "config-apply",
  "diagnostic",
  "command-adapter-event",
] as const;
export type SchemaName = (typeof schemaNames)[number];

const schemas = {
  request: reviewRequestV2Schema,
  events: publicEventSchema,
  "run-status": runStatusSchema,
  result: reviewerResultSchema,
  config: trustedConfigSchema,
  "config-apply": configApplyRequestSchema,
  diagnostic: diagnosticSchema,
  "command-adapter-event": commandAdapterEventSchema,
} satisfies Record<SchemaName, z.ZodType>;

export function isSchemaName(value: string | undefined): value is SchemaName {
  return schemaNames.some((name) => name === value);
}

export function jsonSchema(name: SchemaName): Record<string, unknown> {
  return z.toJSONSchema(schemas[name], { target: "draft-07" }) as Record<
    string,
    unknown
  >;
}

export function renderSchema(name: SchemaName, json: boolean): string {
  const document = { name, schema: jsonSchema(name) };
  return json
    ? `${JSON.stringify(document)}\n`
    : `Review Mesh ${name} schema (JSON Schema draft-07)\n${JSON.stringify(document.schema, null, 2)}\n`;
}
