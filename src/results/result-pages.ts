import { createHash } from "node:crypto";
import { z } from "zod";
import type { AdapterValidationIssue } from "../adapters/errors.js";
import {
  adjudicationResultV2Schema,
  actionableFindingV4Schema,
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
  readonly validationIssues: AdapterValidationIssue[];
  artifactRef?: string;

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
    this.validationIssues = pageValidationIssues(
      options.cause,
      options.receivedRaw,
    );
    const envelopePaths: Record<string, string> = {
      "unexpected result ID": "result_id",
      "unexpected result kind": "result_kind",
      "unexpected page index": "page_index",
      "broken previous page digest": "previous_page_digest",
      "page count changed": "page_count",
      "page index exceeds declared count": "page_index",
      "page zero must be a header": "page_kind",
      "actionable finding count declaration is false": "actionable_findings",
      "narrative fragment count declaration is false": "review_markdown",
      "coverage attestation entry count declaration is false":
        "coverage_attestation.entries",
    };
    const path = envelopePaths[message];
    if (this.validationIssues.length === 0 && path !== undefined)
      this.validationIssues.push({ path, code: reason, message });
  }
}

/** Publish structural facts only; provider values never enter diagnostics. */
function pageValidationIssues(
  cause: unknown,
  raw: string | undefined,
): AdapterValidationIssue[] {
  if (!(cause instanceof z.ZodError)) return [];
  let value: unknown;
  try {
    value = raw === undefined ? undefined : JSON.parse(raw);
  } catch {
    return [];
  }
  function atPath(path: readonly PropertyKey[]): unknown {
    return path.reduce<unknown>(
      (item, key) =>
        typeof item === "object" && item !== null
          ? (item as Record<PropertyKey, unknown>)[key]
          : undefined,
      value,
    );
  }
  function flatten(issues: readonly z.core.$ZodIssue[]): z.core.$ZodIssue[] {
    return issues.flatMap((issue) => {
      if (issue.code !== "invalid_union") return [issue];
      // Select the closest schema branch; unrelated union alternatives obscure
      // the actionable header/narrative/finding violation.
      const alternatives = issue.errors.map((errors) => flatten(errors));
      alternatives.sort((a, b) => a.length - b.length);
      return alternatives[0] ?? [];
    });
  }
  return flatten(cause.issues)
    .slice(0, 12)
    .map((issue) => {
      const actual = atPath(issue.path);
      const maximum = /at most (\d+) UTF-8 bytes/u.exec(issue.message);
      const unknownKeys =
        issue.code === "unrecognized_keys" ? issue.keys : undefined;
      return {
        path: issue.path.join(".") || "$",
        code: issue.code,
        message:
          unknownKeys !== undefined
            ? "Unexpected object keys."
            : maximum !== null
              ? "UTF-8 byte limit exceeded."
              : `Schema constraint failed (${issue.code}).`,
        ...(maximum === null || typeof actual !== "string"
          ? {}
          : {
              expected_max_bytes: Number(maximum[1]),
              actual_bytes: Buffer.byteLength(actual, "utf8"),
            }),
        ...(unknownKeys === undefined ? {} : { unknown_keys: unknownKeys }),
      };
    });
}

export interface ResultPageRequest {
  resultId: string;
  pageIndex: number;
  previousPageDigest: string | null;
  candidateIds: readonly string[];
  pageCount?: number;
  expectedPageKind?: ResultPage["page_kind"];
  acceptedHeader?: Record<string, unknown>;
  remainingCounts?: {
    coverage_entries: number;
    narrative_fragments: number;
    actionable_findings: number;
  };
  preservedCandidates?: readonly Record<string, unknown>[];
  preservedCandidateIds?: readonly string[];
  minimumFindingCount?: number;
  preserveFail?: boolean;
  minimumNarrativeFragments?: number;
  minimumCoverageEntries?: number;
  coverageScopeDigest?: string;
  acceptedCandidateIds?: readonly string[];
}

export interface ResultPageDraft {
  acceptedPageCount: number;
  candidateIds: string[];
  candidates: Record<string, unknown>[];
  unresolvedObligations: string[];
}

export interface ResultPagePreservation {
  findingCount: number;
  verdictFail: boolean;
  candidateIds: Set<string>;
  candidates: Map<string, Record<string, unknown>>;
  narrativeFragments: number;
  coverageEntries: number;
  coverageScopeDigest?: string;
}

/** One model's obligations survive both result-production and outer attempts. */
export function createResultPagePreservation(): ResultPagePreservation {
  return {
    findingCount: 0,
    verdictFail: false,
    candidateIds: new Set(),
    candidates: new Map(),
    narrativeFragments: 0,
    coverageEntries: 0,
  };
}

export interface ResultPageCollector {
  readonly complete: boolean;
  nextRequest(): ResultPageRequest;
  addPage(raw: string): void;
  assemble(): ProviderReviewerResultV4 | AdjudicationResultV2;
  draft(): ResultPageDraft;
  restart(): ResultPageCollector;
  repairAssembly(): ResultPageCollector | undefined;
}

export interface ResultPageCollectorOptions {
  resultId: string;
  resultKind: "reviewer" | "adjudication";
  candidateIds?: readonly string[];
  preservation?: ResultPagePreservation;
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
  preservation: ResultPagePreservation = options.preservation ??
    createResultPagePreservation(),
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
  let retainedFindingCount = preservation.findingCount;
  const retainedPageFindingIds = new Set<string>();
  let retainedVerdictFail = preservation.verdictFail;

  function assignedCandidateIds(pageIndex: number): readonly string[] {
    if (options.resultKind !== "adjudication" || pageIndex === 0) return [];
    return candidateIds.slice((pageIndex - 1) * 4, pageIndex * 4);
  }

  function nextRequest(): ResultPageRequest {
    const last = accepted.at(-1);
    const header = accepted[0]?.page;
    const reviewerHeader =
      header?.result_kind === "reviewer" && header.page_kind === "header"
        ? header
        : undefined;
    const remainingCounts =
      reviewerHeader === undefined
        ? undefined
        : {
            coverage_entries: Math.max(
              0,
              (reviewerHeader.payload.coverage_attestation?.entry_count ?? 0) -
                acceptedCoverageEntries,
            ),
            narrative_fragments: Math.max(
              0,
              reviewerHeader.payload.narrative_fragment_count -
                acceptedNarrativeFragments,
            ),
            actionable_findings: Math.max(
              0,
              reviewerHeader.payload.actionable_finding_count -
                seenFindingIds.size,
            ),
          };
    const expectedPageKind =
      accepted.length === 0
        ? "header"
        : options.resultKind === "adjudication"
          ? "decisions"
          : remainingCounts!.coverage_entries > 0
            ? "coverage"
            : remainingCounts!.narrative_fragments > 0
              ? "narrative"
              : "findings";
    return {
      resultId: options.resultId,
      pageIndex: accepted.length,
      previousPageDigest: last === undefined ? null : sha256(last.raw),
      candidateIds: assignedCandidateIds(accepted.length),
      ...(pageCount === undefined ? {} : { pageCount }),
      expectedPageKind,
      ...(reviewerHeader === undefined
        ? {}
        : { acceptedHeader: structuredClone(reviewerHeader.payload) }),
      ...(remainingCounts === undefined ? {} : { remainingCounts }),
      ...(preservation.candidateIds.size === 0
        ? {}
        : { preservedCandidateIds: [...preservation.candidateIds] }),
      ...(preservation.candidates.size === 0
        ? {}
        : {
            preservedCandidates: [...preservation.candidates.values()].map(
              (item) => structuredClone(item),
            ),
          }),
      ...(preservation.findingCount === 0
        ? {}
        : { minimumFindingCount: preservation.findingCount }),
      ...(preservation.verdictFail ? { preserveFail: true } : {}),
      ...(preservation.narrativeFragments === 0
        ? {}
        : { minimumNarrativeFragments: preservation.narrativeFragments }),
      ...(preservation.coverageEntries === 0
        ? {}
        : { minimumCoverageEntries: preservation.coverageEntries }),
      ...(preservation.coverageScopeDigest === undefined
        ? {}
        : { coverageScopeDigest: preservation.coverageScopeDigest }),
      ...(seenFindingIds.size === 0
        ? {}
        : { acceptedCandidateIds: [...seenFindingIds] }),
    };
  }

  function draft(): ResultPageDraft {
    const unresolvedObligations: string[] = [];
    const missing = [...preservation.candidateIds].filter(
      (id) => !seenFindingIds.has(id),
    );
    if (missing.length > 0)
      unresolvedObligations.push(
        `Preserve ${missing.length} previously returned candidate IDs.`,
      );
    if (seenFindingIds.size < preservation.findingCount)
      unresolvedObligations.push(
        `Provide at least ${preservation.findingCount} declared actionable findings; ${seenFindingIds.size} accepted in this assembly.`,
      );
    if (preservation.verdictFail)
      unresolvedObligations.push(
        "Preserve the failing verdict and every validated candidate until the complete result is verified.",
      );
    if (acceptedNarrativeFragments < preservation.narrativeFragments)
      unresolvedObligations.push(
        `Provide ${preservation.narrativeFragments} declared narrative fragments; ${acceptedNarrativeFragments} accepted.`,
      );
    if (acceptedCoverageEntries < preservation.coverageEntries)
      unresolvedObligations.push(
        `Provide ${preservation.coverageEntries} declared coverage entries; ${acceptedCoverageEntries} accepted.`,
      );
    return {
      acceptedPageCount: accepted.length,
      candidateIds: [...preservation.candidateIds],
      candidates: [...preservation.candidates.values()].map((item) =>
        structuredClone(item),
      ),
      unresolvedObligations,
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
    if (typeof parsedJson === "object" && parsedJson !== null) {
      const candidate = parsedJson as Record<string, unknown>;
      const payload = candidate.payload as Record<string, unknown> | undefined;
      if (
        candidate.result_id === options.resultId &&
        candidate.page_index === accepted.length &&
        payload !== undefined &&
        payload !== null
      ) {
        if (candidate.page_kind === "header" && payload.verdict === "fail")
          preservation.verdictFail = retainedVerdictFail = true;
        if (
          candidate.page_kind === "header" &&
          typeof payload.actionable_finding_count === "number" &&
          Number.isSafeInteger(payload.actionable_finding_count) &&
          payload.actionable_finding_count >= 0 &&
          payload.actionable_finding_count <= 16
        )
          preservation.findingCount = retainedFindingCount = Math.max(
            retainedFindingCount,
            payload.actionable_finding_count,
          );
        if (
          candidate.page_kind === "findings" &&
          Array.isArray(payload.actionable_findings)
        ) {
          for (const finding of payload.actionable_findings.slice(0, 16)) {
            if (
              typeof finding === "object" &&
              finding !== null &&
              typeof finding.id === "string" &&
              finding.id.length <= 256
            ) {
              retainedPageFindingIds.add(finding.id);
              if (
                !preservation.candidateIds.has(finding.id) &&
                preservation.candidateIds.size >= 16
              )
                fail(
                  "structured_page_limit_exceeded",
                  "Previously returned candidates exceed the result finding limit",
                  raw,
                );
              preservation.candidateIds.add(finding.id);
              const validated = actionableFindingV4Schema.safeParse(finding);
              if (validated.success) {
                const previous = preservation.candidates.get(finding.id);
                if (
                  previous === undefined &&
                  preservation.candidates.size >= 16
                )
                  fail(
                    "structured_page_limit_exceeded",
                    "Previously returned candidates exceed the result finding limit",
                    raw,
                  );
                if (
                  previous !== undefined &&
                  canonicalJson(previous) !== canonicalJson(validated.data)
                )
                  fail(
                    "protocol_violation",
                    "Repairs must preserve previously validated candidate content",
                    raw,
                  );
                preservation.candidates.set(finding.id, validated.data);
                preservation.verdictFail = retainedVerdictFail = true;
              }
            }
          }
          if (payload.actionable_findings.length > 16)
            fail(
              "structured_page_limit_exceeded",
              "Previously returned candidates exceed the result finding limit",
              raw,
            );
        }
      }
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
    if (
      page.result_id === options.resultId &&
      page.page_index === accepted.length &&
      page.result_kind === "reviewer" &&
      page.page_kind === "header"
    ) {
      if (
        page.payload.narrative_fragment_count <
          preservation.narrativeFragments ||
        (page.payload.coverage_attestation?.entry_count ?? 0) <
          preservation.coverageEntries
      )
        fail(
          "protocol_violation",
          "Repairs must preserve declared narrative and coverage item counts",
          raw,
        );
      if (
        preservation.coverageScopeDigest !== undefined &&
        page.payload.coverage_attestation?.scope_digest !==
          preservation.coverageScopeDigest
      )
        fail(
          "protocol_violation",
          "Repairs must preserve the coverage scope digest",
          raw,
        );
      preservation.narrativeFragments = Math.max(
        preservation.narrativeFragments,
        page.payload.narrative_fragment_count,
      );
      preservation.coverageEntries = Math.max(
        preservation.coverageEntries,
        page.payload.coverage_attestation?.entry_count ?? 0,
      );
      if (
        page.payload.coverage_attestation !== undefined &&
        page.payload.coverage_attestation !== null
      )
        preservation.coverageScopeDigest ??=
          page.payload.coverage_attestation.scope_digest;
    }
    if (
      page.result_kind === "reviewer" &&
      page.page_kind === "header" &&
      retainedVerdictFail &&
      page.payload.verdict !== "fail"
    )
      fail(
        "protocol_violation",
        "Repairs must preserve previously declared candidate findings and failing verdict",
        raw,
      );
    if (
      page.result_kind === "reviewer" &&
      page.page_kind === "header" &&
      page.payload.actionable_finding_count < retainedFindingCount
    )
      fail(
        "protocol_violation",
        "Repairs must preserve previously declared candidate findings",
        raw,
      );
    if (
      page.result_kind === "reviewer" &&
      page.page_kind === "findings" &&
      retainedPageFindingIds.size > 0 &&
      [...retainedPageFindingIds].some(
        (id) =>
          !page.payload.actionable_findings.some(
            (finding) => finding.id === id,
          ),
      )
    )
      fail(
        "protocol_violation",
        "Repairs must preserve previously returned candidate finding IDs",
        raw,
      );
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
    if (page.page_kind === "findings") retainedPageFindingIds.clear();
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
    // Bytes and digests describe a representation, not evidence. Core computes
    // these from accepted content; declared item counts still detect omissions.
    if (fragments.length !== header.payload.narrative_fragment_count) {
      fail("invalid_result", "narrative fragment count declaration is false");
    }
    if (findings.length !== header.payload.actionable_finding_count) {
      fail("invalid_result", "actionable finding count declaration is false");
    }
    if (
      findings.length < preservation.findingCount ||
      [...preservation.candidateIds].some(
        (id) => !findings.some((finding) => finding.id === id),
      )
    )
      fail(
        "invalid_result",
        "Repairs must preserve every previously returned candidate and declared finding count",
      );
    let coverage_attestation: CoverageAttestation | undefined;
    const declaration = header.payload.coverage_attestation;
    if (declaration !== null && declaration !== undefined) {
      if (entries.length !== declaration.entry_count) {
        fail(
          "invalid_result",
          "coverage attestation entry count declaration is false",
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
      // Validate the known result kind first so a semantic reviewer error is
      // not obscured by unrelated alternatives in the sanitization union.
      providerReviewerResultV4Schema.parse(output);
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
    draft,
    restart() {
      return createResultPageCollector(options, preservation);
    },
    repairAssembly() {
      const header = accepted[0]?.page;
      const last = accepted.at(-1)?.page;
      if (
        header?.result_kind !== "reviewer" ||
        header.page_kind !== "header" ||
        last?.result_kind !== "reviewer" ||
        last.page_kind !== "findings"
      )
        return undefined;
      const missingCount =
        header.payload.actionable_finding_count - seenFindingIds.size;
      if (
        missingCount <= 0 ||
        missingCount + last.payload.actionable_findings.length > 2
      )
        return undefined;
      const repaired = createResultPageCollector(options, preservation);
      for (const page of accepted.slice(0, -1)) repaired.addPage(page.raw);
      return repaired;
    },
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
