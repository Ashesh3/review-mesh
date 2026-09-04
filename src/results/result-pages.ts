import { createHash } from "node:crypto";
import {
  adjudicationResultV2Schema,
  coverageAttestationSchema,
  providerReviewerResultV4Schema,
  resultPageSchema,
  type AdjudicationDecisionV2,
  type AdjudicationResultV2,
  type CoverageAttestation,
  type ProviderReviewerResultV4,
  type ResultPage,
  type V9IncompleteReason,
} from "../protocol/v9.js";
import { canonicalJson } from "./digest.js";
import { sanitizeReviewerOutput } from "./sanitize.js";

export const MAX_RESULT_PAGE_BYTES = 32 * 1_024;

export type ResultPageErrorReason = Extract<
  V9IncompleteReason,
  | "structured_page_limit_exceeded"
  | "result_page_too_large"
  | "provider_response_invalid"
  | "protocol_violation"
  | "invalid_result"
  | "result_too_large"
>;

export class ResultPageError extends Error {
  readonly reason: ResultPageErrorReason;
  readonly receivedRaw: string | undefined;
  readonly receivedBytes: number | undefined;

  constructor(
    reason: ResultPageErrorReason,
    message: string,
    options: {
      receivedRaw?: string;
      receivedBytes?: number;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ResultPageError";
    this.reason = reason;
    this.receivedRaw = options.receivedRaw;
    this.receivedBytes = options.receivedBytes;
  }
}

export interface ResultPageRequest {
  resultId: string;
  pageIndex: number;
  previousPageDigest: string | null;
  candidateIds: readonly string[];
}

export interface ResultPageCollector {
  readonly complete: boolean;
  nextRequest(): ResultPageRequest;
  addPage(raw: string): void;
  assemble(): ProviderReviewerResultV4 | AdjudicationResultV2;
}

export interface ResultPageCollectorOptions {
  resultId: string;
  resultKind: "reviewer" | "adjudication";
  candidateIds?: readonly string[];
}

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

function fail(
  reason: ResultPageErrorReason,
  message: string,
  raw?: string,
  cause?: unknown,
): never {
  const details: {
    receivedRaw?: string;
    receivedBytes?: number;
    cause?: unknown;
  } = {};
  if (raw !== undefined) {
    details.receivedRaw = raw;
    details.receivedBytes = Buffer.byteLength(raw, "utf8");
  }
  if (cause !== undefined) details.cause = cause;
  throw new ResultPageError(reason, message, details);
}

function assertExactIds(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
  raw?: string,
): void {
  if (
    actual.length !== expected.length ||
    actual.some((id, index) => id !== expected[index])
  ) {
    fail(
      "protocol_violation",
      `${label} must contain the exact assigned IDs in order`,
      raw,
    );
  }
}

export function createResultPageCollector(
  options: ResultPageCollectorOptions,
): ResultPageCollector {
  const candidateIds = [...(options.candidateIds ?? [])];
  if (new Set(candidateIds).size !== candidateIds.length) {
    fail("protocol_violation", "candidate IDs must be unique");
  }
  if (options.resultKind === "reviewer" && candidateIds.length !== 0) {
    fail(
      "protocol_violation",
      "reviewer result collectors do not accept candidate IDs",
    );
  }
  if (options.resultKind === "adjudication" && candidateIds.length > 256) {
    fail(
      "structured_page_limit_exceeded",
      "adjudication accepts at most 256 candidate IDs",
    );
  }

  const accepted: Array<{ raw: string; page: ResultPage }> = [];
  let pageCount: number | undefined;
  let phase: "header" | "coverage" | "narrative" | "findings" | "decisions" =
    "header";
  const seenFindingIds = new Set<string>();
  const seenDecisionIds = new Set<string>();
  let acceptedCoverageEntries = 0;
  let acceptedNarrativeFragments = 0;

  function assignedCandidateIds(pageIndex: number): readonly string[] {
    if (options.resultKind !== "adjudication" || pageIndex === 0) return [];
    return candidateIds.slice((pageIndex - 1) * 4, pageIndex * 4);
  }

  function nextRequest(): ResultPageRequest {
    const last = accepted.at(-1);
    return {
      resultId: options.resultId,
      pageIndex: accepted.length,
      previousPageDigest: last === undefined ? null : sha256(last.raw),
      candidateIds: assignedCandidateIds(accepted.length),
    };
  }

  function validateOrdering(page: ResultPage, raw: string): typeof phase {
    if (page.page_index === 0) {
      if (page.page_kind !== "header")
        fail("protocol_violation", "page zero must be a header", raw);
      return page.result_kind === "reviewer" ? "coverage" : "decisions";
    }
    if (page.result_kind === "adjudication") {
      if (page.page_kind !== "decisions")
        fail(
          "protocol_violation",
          "adjudication continuation pages must contain decisions",
          raw,
        );
      return "decisions";
    }
    if (page.page_kind === "coverage") {
      if (phase !== "coverage")
        fail(
          "protocol_violation",
          "coverage pages must be contiguous and first",
          raw,
        );
      return "coverage";
    }
    if (page.page_kind === "narrative") {
      const header = accepted[0]?.page;
      if (
        header?.result_kind === "reviewer" &&
        header.page_kind === "header" &&
        acceptedCoverageEntries !==
          (header.payload.coverage_attestation?.entry_count ?? 0)
      ) {
        fail(
          "protocol_violation",
          "narrative pages cannot start before declared coverage entries are complete",
          raw,
        );
      }
      if (phase === "findings" || phase === "decisions")
        fail(
          "protocol_violation",
          "narrative pages must precede findings",
          raw,
        );
      return "narrative";
    }
    if (page.page_kind === "findings") {
      const header = accepted[0]?.page;
      if (
        header?.result_kind === "reviewer" &&
        header.page_kind === "header" &&
        (acceptedCoverageEntries !==
          (header.payload.coverage_attestation?.entry_count ?? 0) ||
          acceptedNarrativeFragments !==
            header.payload.narrative_fragment_count)
      ) {
        fail(
          "protocol_violation",
          "findings cannot precede declared coverage and narrative content",
          raw,
        );
      }
      return "findings";
    }
    fail("protocol_violation", "unexpected page kind", raw);
  }

  function addPage(raw: string): void {
    const receivedBytes = Buffer.byteLength(raw, "utf8");
    if (receivedBytes > MAX_RESULT_PAGE_BYTES) {
      fail("result_page_too_large", "result page exceeds 32 KiB", raw);
    }
    if (pageCount !== undefined && accepted.length >= pageCount) {
      fail("protocol_violation", "received a page after the final index", raw);
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch (error) {
      fail(
        "provider_response_invalid",
        "result page is not valid JSON",
        raw,
        error,
      );
    }
    const parsed = resultPageSchema.safeParse(parsedJson);
    if (!parsed.success) {
      fail(
        "provider_response_invalid",
        "result page does not match the v9 schema",
        raw,
        parsed.error,
      );
    }
    const page = parsed.data;
    const request = nextRequest();
    if (page.result_id !== options.resultId)
      fail("protocol_violation", "unexpected result ID", raw);
    if (page.result_kind !== options.resultKind)
      fail("protocol_violation", "unexpected result kind", raw);
    if (page.page_index !== request.pageIndex)
      fail("protocol_violation", "unexpected page index", raw);
    if (page.previous_page_digest !== request.previousPageDigest)
      fail("protocol_violation", "broken previous page digest", raw);
    if (pageCount !== undefined && page.page_count !== pageCount)
      fail("protocol_violation", "page count changed", raw);
    if (page.page_count <= page.page_index)
      fail("protocol_violation", "page index exceeds declared count", raw);
    const nextPhase = validateOrdering(page, raw);
    let nextCoverageEntries = acceptedCoverageEntries;
    let nextNarrativeFragments = acceptedNarrativeFragments;
    if (page.result_kind === "reviewer" && page.page_kind === "coverage") {
      const header = accepted[0]?.page;
      nextCoverageEntries += page.payload.entries.length;
      if (
        header?.result_kind !== "reviewer" ||
        header.page_kind !== "header" ||
        nextCoverageEntries >
          (header.payload.coverage_attestation?.entry_count ?? 0)
      ) {
        fail(
          "protocol_violation",
          "coverage entries exceed the declared count",
          raw,
        );
      }
    }
    if (page.result_kind === "reviewer" && page.page_kind === "narrative") {
      const header = accepted[0]?.page;
      nextNarrativeFragments += 1;
      if (
        header?.result_kind !== "reviewer" ||
        header.page_kind !== "header" ||
        nextNarrativeFragments > header.payload.narrative_fragment_count
      ) {
        fail(
          "protocol_violation",
          "narrative fragments exceed the declared count",
          raw,
        );
      }
    }

    let findingIds: string[] = [];
    if (page.result_kind === "reviewer" && page.page_kind === "findings") {
      findingIds = page.payload.actionable_findings.map(
        (finding) => finding.id,
      );
      if (
        new Set(findingIds).size !== findingIds.length ||
        findingIds.some((id) => seenFindingIds.has(id))
      ) {
        fail("protocol_violation", "finding IDs must be unique", raw);
      }
    }
    let decisionIds: string[] = [];
    if (page.result_kind === "adjudication" && page.page_kind === "decisions") {
      decisionIds = page.payload.decisions.map(
        (decision) => decision.source_finding_id,
      );
      assertExactIds(decisionIds, request.candidateIds, "decision page", raw);
      if (decisionIds.some((id) => seenDecisionIds.has(id))) {
        fail("protocol_violation", "candidate IDs must not repeat", raw);
      }
    }

    pageCount ??= page.page_count;
    phase = nextPhase;
    acceptedCoverageEntries = nextCoverageEntries;
    acceptedNarrativeFragments = nextNarrativeFragments;
    for (const id of findingIds) seenFindingIds.add(id);
    for (const id of decisionIds) seenDecisionIds.add(id);
    accepted.push({ raw, page });
  }

  function assembleReviewer(): ProviderReviewerResultV4 {
    const header = accepted[0]?.page;
    if (header?.result_kind !== "reviewer" || header.page_kind !== "header") {
      fail("invalid_result", "reviewer header is missing");
    }
    const entries = accepted.flatMap(({ page }) =>
      page.result_kind === "reviewer" && page.page_kind === "coverage"
        ? page.payload.entries
        : [],
    );
    const fragments = accepted.flatMap(({ page }) =>
      page.result_kind === "reviewer" && page.page_kind === "narrative"
        ? [page.payload.text_fragment]
        : [],
    );
    const findings = accepted.flatMap(({ page }) =>
      page.result_kind === "reviewer" && page.page_kind === "findings"
        ? page.payload.actionable_findings
        : [],
    );
    const narrative = fragments.join("");
    if (
      Buffer.byteLength(narrative, "utf8") !==
        header.payload.narrative_byte_count ||
      fragments.length !== header.payload.narrative_fragment_count
    ) {
      fail("invalid_result", "narrative count or byte declaration is false");
    }
    if (findings.length !== header.payload.actionable_finding_count) {
      fail("invalid_result", "actionable finding count declaration is false");
    }
    let coverage_attestation: CoverageAttestation | undefined;
    const declaration = header.payload.coverage_attestation;
    if (declaration !== null && declaration !== undefined) {
      if (
        entries.length !== declaration.entry_count ||
        sha256(canonicalJson(entries)) !== declaration.entries_digest
      ) {
        fail(
          "invalid_result",
          "coverage attestation count or digest declaration is false",
        );
      }
      const parsedAttestation = coverageAttestationSchema.safeParse({
        scope_digest: declaration.scope_digest,
        entries,
      });
      if (!parsedAttestation.success) {
        fail(
          "invalid_result",
          "coverage attestation is invalid",
          undefined,
          parsedAttestation.error,
        );
      }
      coverage_attestation = parsedAttestation.data;
    } else if (entries.length !== 0) {
      fail(
        "invalid_result",
        "coverage pages require a header attestation declaration",
      );
    }
    const output: unknown = {
      schema_version: "4",
      verdict: header.payload.verdict,
      review_markdown: narrative,
      summary: header.payload.summary,
      actionable_findings: findings,
      informational_notes: header.payload.informational_notes,
      ...(coverage_attestation === undefined ? {} : { coverage_attestation }),
    };
    try {
      return providerReviewerResultV4Schema.parse(
        sanitizeReviewerOutput(output),
      );
    } catch (error) {
      fail(
        error instanceof Error &&
          "code" in error &&
          error.code === "result_too_large"
          ? "result_too_large"
          : "invalid_result",
        "assembled reviewer result is invalid",
        undefined,
        error,
      );
    }
  }

  function assembleAdjudication(): AdjudicationResultV2 {
    const header = accepted[0]?.page;
    if (
      header?.result_kind !== "adjudication" ||
      header.page_kind !== "header"
    ) {
      fail("invalid_result", "adjudication header is missing");
    }
    if (
      header.payload.candidate_count !== candidateIds.length ||
      header.payload.candidate_ids_digest !==
        sha256(JSON.stringify(candidateIds))
    ) {
      fail("invalid_result", "candidate count or digest declaration is false");
    }
    const decisions = accepted.flatMap(({ page }) =>
      page.result_kind === "adjudication" && page.page_kind === "decisions"
        ? page.payload.decisions
        : [],
    ) as AdjudicationDecisionV2[];
    assertExactIds(
      decisions.map((decision) => decision.source_finding_id),
      candidateIds,
      "assembled adjudication",
    );
    try {
      return adjudicationResultV2Schema.parse(
        sanitizeReviewerOutput({
          schema_version: "2",
          kind: "review-mesh.adjudication-result",
          verdict: header.payload.verdict,
          review_markdown: header.payload.review_markdown,
          summary: header.payload.summary,
          actionable_findings: [],
          decisions,
          informational_notes: header.payload.informational_notes,
        }),
      );
    } catch (error) {
      fail(
        error instanceof Error &&
          "code" in error &&
          error.code === "result_too_large"
          ? "result_too_large"
          : "invalid_result",
        "assembled adjudication result is invalid",
        undefined,
        error,
      );
    }
  }

  return {
    get complete() {
      return pageCount !== undefined && accepted.length === pageCount;
    },
    nextRequest,
    addPage,
    assemble() {
      if (pageCount === undefined || accepted.length !== pageCount)
        fail("invalid_result", "result pages are incomplete");
      return options.resultKind === "reviewer"
        ? assembleReviewer()
        : assembleAdjudication();
    },
  };
}
