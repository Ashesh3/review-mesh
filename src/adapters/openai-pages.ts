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
      "Return exactly one JSON result-page object for this assignment. Do not repeat earlier pages or return a whole result. Preserve validated candidate content exactly; do not emit accepted_candidate_ids again. Complete remaining declared content. Representation byte counts and coverage-entry digests are computed by the host.",
    result_id: request.resultId,
    result_kind: resultKind,
    page_index: request.pageIndex,
    previous_page_digest: request.previousPageDigest,
    candidate_ids: [...request.candidateIds],
    ...(request.pageCount === undefined
      ? {}
      : { page_count: request.pageCount }),
    ...(request.expectedPageKind === undefined
      ? {}
      : { expected_page_kind: request.expectedPageKind }),
    ...(request.acceptedHeader === undefined
      ? {}
      : { accepted_header: request.acceptedHeader }),
    ...(request.remainingCounts === undefined
      ? {}
      : { remaining_counts: request.remainingCounts }),
    ...(request.preservedCandidateIds === undefined
      ? {}
      : { preserved_candidate_ids: request.preservedCandidateIds }),
    ...(request.preservedCandidates === undefined
      ? {}
      : { preserved_candidates: request.preservedCandidates }),
    ...(request.minimumFindingCount === undefined
      ? {}
      : { minimum_finding_count: request.minimumFindingCount }),
    ...(request.preserveFail === true
      ? { preserve_failing_verdict: true }
      : {}),
    ...(request.acceptedCandidateIds === undefined
      ? {}
      : { accepted_candidate_ids: request.acceptedCandidateIds }),
    ...(request.minimumNarrativeFragments === undefined
      ? {}
      : { minimum_narrative_fragments: request.minimumNarrativeFragments }),
    ...(request.minimumCoverageEntries === undefined
      ? {}
      : { minimum_coverage_entries: request.minimumCoverageEntries }),
    ...(request.coverageScopeDigest === undefined
      ? {}
      : { coverage_scope_digest: request.coverageScopeDigest }),
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
      (request.expectedPageKind === undefined ||
        pageKind === request.expectedPageKind) &&
      (request.pageIndex === 0 ? pageKind === "header" : pageKind !== "header")
    );
  });
  for (const candidate of matching) {
    const properties = objectValue(objectValue(candidate)?.properties);
    if (properties === undefined) continue;
    properties.result_id = { type: "string", const: request.resultId };
    properties.page_index = { type: "integer", const: request.pageIndex };
    if (request.pageCount !== undefined)
      properties.page_count = { type: "integer", const: request.pageCount };
    if (request.pageIndex === 0 && resultKind === "reviewer") {
      const payloadProperties = objectValue(
        objectValue(properties.payload)?.properties,
      );
      if (payloadProperties !== undefined) {
        if (request.preserveFail === true)
          payloadProperties.verdict = { type: "string", const: "fail" };
        if (request.minimumFindingCount !== undefined)
          payloadProperties.actionable_finding_count = {
            type: "integer",
            minimum: request.minimumFindingCount,
            maximum: 16,
          };
        if (request.minimumNarrativeFragments !== undefined)
          payloadProperties.narrative_fragment_count = {
            type: "integer",
            minimum: request.minimumNarrativeFragments,
            maximum: 686,
          };
      }
    }
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
