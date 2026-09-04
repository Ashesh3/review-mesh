import { resultPageJsonSchema } from "../protocol/json-schema.js";
import type { ResultPageRequest } from "../results/result-pages.js";

type ResultKind = "reviewer" | "adjudication";

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function resultPageRequestMessage(
  request: ResultPageRequest,
  resultKind: ResultKind,
): string {
  return JSON.stringify({
    instruction:
      "Return exactly one JSON result-page object for this assignment. Do not repeat earlier pages or return a whole result.",
    result_id: request.resultId,
    result_kind: resultKind,
    page_index: request.pageIndex,
    previous_page_digest: request.previousPageDigest,
    candidate_ids: [...request.candidateIds],
  });
}

export function resultPageSchemaFor(
  request: ResultPageRequest,
  resultKind: ResultKind,
): Record<string, unknown> {
  const schema = structuredClone(resultPageJsonSchema) as Record<
    string,
    unknown
  >;
  const alternatives = Array.isArray(schema.anyOf) ? schema.anyOf : [];
  const matching = alternatives.filter((candidate) => {
    const properties = objectValue(objectValue(candidate)?.properties);
    const kind = objectValue(properties?.result_kind)?.const;
    const pageKind = objectValue(properties?.page_kind)?.const;
    return (
      kind === resultKind &&
      (request.pageIndex === 0 ? pageKind === "header" : pageKind !== "header")
    );
  });
  for (const candidate of matching) {
    const properties = objectValue(objectValue(candidate)?.properties);
    if (properties === undefined) continue;
    properties.result_id = { type: "string", const: request.resultId };
    properties.page_index = { type: "integer", const: request.pageIndex };
    properties.previous_page_digest =
      request.previousPageDigest === null
        ? { type: "null" }
        : { type: "string", const: request.previousPageDigest };
    if (resultKind !== "adjudication" || request.pageIndex === 0) continue;
    const payload = objectValue(properties.payload);
    const payloadProperties = objectValue(payload?.properties);
    const decisions = objectValue(payloadProperties?.decisions);
    const items = objectValue(decisions?.items);
    const decisionProperties = objectValue(items?.properties);
    if (decisionProperties !== undefined) {
      decisionProperties.source_finding_id = {
        type: "string",
        enum: [...request.candidateIds],
      };
    }
    if (decisions !== undefined) {
      decisions.minItems = request.candidateIds.length;
      decisions.maxItems = request.candidateIds.length;
    }
  }
  return { $schema: schema.$schema, anyOf: matching };
}
