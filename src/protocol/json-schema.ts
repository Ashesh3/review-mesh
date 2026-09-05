import { z } from "zod";
import {
  adjudicationResultSchema,
  adjudicationResultV2Schema,
  providerReviewerResultV4Schema,
  resultPageSchema,
  reviewerResultV3Schema,
} from "./schemas.js";

export const reviewerResultJsonSchema = z.toJSONSchema(reviewerResultV3Schema, {
  target: "draft-07",
});

export const adjudicationResultJsonSchema = z.toJSONSchema(
  adjudicationResultSchema,
  { target: "draft-07" },
);

export const providerReviewerResultV4JsonSchema = z.toJSONSchema(
  providerReviewerResultV4Schema,
  { target: "draft-07" },
);

export const adjudicationResultV2JsonSchema = z.toJSONSchema(
  adjudicationResultV2Schema,
  { target: "draft-07" },
);

export const resultPageJsonSchema = z.toJSONSchema(resultPageSchema, {
  target: "draft-07",
});

export function adjudicationResultJsonSchemaFor(
  candidateFindingIds: readonly string[],
): Record<string, unknown> {
  const schema = structuredClone(adjudicationResultJsonSchema) as Record<
    string,
    unknown
  >;
  const properties = schema.properties as Record<string, unknown> | undefined;
  const decisions = properties?.decisions as
    Record<string, unknown> | undefined;
  const items = decisions?.items as Record<string, unknown> | undefined;
  const decisionProperties = items?.properties as
    Record<string, unknown> | undefined;
  const sourceId = decisionProperties?.source_finding_id as
    Record<string, unknown> | undefined;
  if (sourceId !== undefined) sourceId.enum = [...candidateFindingIds];
  if (decisions !== undefined) {
    decisions.minItems = candidateFindingIds.length;
    decisions.maxItems = candidateFindingIds.length;
  }
  return schema;
}
