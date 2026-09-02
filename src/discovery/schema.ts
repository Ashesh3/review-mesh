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
