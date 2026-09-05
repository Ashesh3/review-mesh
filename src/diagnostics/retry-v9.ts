import { createHash } from "node:crypto";
import type { ResolvedConfig } from "../config/schemas.js";
import type { ResolvedContext } from "../context/resolve.js";
import type {
  CanonicalFindingCoreProof,
  CanonicalRawFinding,
} from "../findings/canonical.js";
import type { AdjudicationResultV2, ReviewerResultV4 } from "../protocol/v9.js";
import { reviewerResultDigest } from "../results/digest.js";
import { loadV9Run } from "./v9-views.js";

export interface InheritedV9ReviewerResult {
  reviewerId: string;
  lensId: string;
  result: ReviewerResultV4 | AdjudicationResultV2;
  resultDigest: string;
  resultByteCount: number;
  coverageEntries: Record<string, unknown>[];
  terminal: Record<string, unknown>;
}

export interface PreparedV9Retry {
  parentRunId: string;
  runLensIds: string[];
  inherited: InheritedV9ReviewerResult[];
  inheritance: "exact" | "rerun_all";
  rawFindings: CanonicalRawFinding[];
  proofBySourceRef: Record<string, CanonicalFindingCoreProof>;
  adjudicationOutcomes: Record<string, unknown>[];
}

export class V9RetryError extends Error {
  constructor(
    readonly code:
      "invalid_retry_parent" | "unknown_retry_lens" | "retry_parent_unverified",
    message: string,
  ) {
    super(message);
    this.name = "V9RetryError";
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)]),
  );
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)), "utf8")
    .digest("hex");
}

function lensId(reviewer: ResolvedConfig["reviewers"][number]): string {
  return reviewer.agentId ?? reviewer.id;
}

function currentScope(context: ResolvedContext): unknown {
  return {
    consistency_mode: context.consistency_mode,
    workspace: context.workspace,
    project_name: context.project_name,
    instructions: context.instructions,
    caller_context: context.caller_context,
    request: context.request,
    review_scope: context.review_scope,
    git: context.git,
  };
}

function parentScope(context: Record<string, unknown>): unknown {
  return {
    consistency_mode: context.consistency_mode,
    workspace: context.workspace,
    project_name: context.project_name,
    instructions: context.instructions,
    caller_context: context.caller_context,
    request: context.request,
    review_scope: context.review_scope,
    git: context.git,
  };
}

function currentPolicies(config: ResolvedConfig): unknown {
  return config.reviewers.map((reviewer) => ({
    id: reviewer.id,
    agent_id: lensId(reviewer),
    policy: reviewer.policy,
  }));
}

function parentPolicies(resolution: Record<string, unknown>): unknown {
  return Array.isArray(resolution.reviewers) ? resolution.reviewers : [];
}

export async function prepareV9Retry(input: {
  runsDirectory: string;
  parentRunId: string;
  selectedLensIds: readonly string[];
  config: ResolvedConfig;
  context: ResolvedContext;
}): Promise<PreparedV9Retry> {
  const configuredLensIds = [
    ...new Set(input.config.reviewers.map((reviewer) => lensId(reviewer))),
  ];
  const selectedLensIds = [...new Set(input.selectedLensIds)];
  const unknown = selectedLensIds.filter(
    (selected) => !configuredLensIds.includes(selected),
  );
  if (selectedLensIds.length === 0 || unknown.length > 0)
    throw new V9RetryError(
      "unknown_retry_lens",
      `Unknown selected retry lens: ${unknown[0] ?? "none"}.`,
    );

  const parent = await loadV9Run(input.runsDirectory, input.parentRunId);
  if (!parent || parent.active || !parent.context || !parent.resolution)
    throw new V9RetryError(
      "invalid_retry_parent",
      "Retry requires a completed parent artifact with captured context and resolution.",
    );
  if (parent.digest_status !== "verified")
    throw new V9RetryError(
      "retry_parent_unverified",
      "Retry inheritance requires a run-index verified parent artifact.",
    );

  const exactScope =
    digest(currentScope(input.context)) === digest(parentScope(parent.context));
  const exactPolicies =
    digest(currentPolicies(input.config)) ===
    digest(parentPolicies(parent.resolution));
  if (!exactScope || !exactPolicies)
    return {
      parentRunId: input.parentRunId,
      runLensIds: configuredLensIds,
      inherited: [],
      inheritance: "rerun_all",
      rawFindings: [],
      proofBySourceRef: {},
      adjudicationOutcomes: [],
    };

  const selected = new Set(selectedLensIds);
  const parentIncompleteLenses = new Set(
    parent.reviewers
      .filter(
        (reviewer) =>
          reviewer.status === "incomplete" ||
          reviewer.reason === "not_evaluated_missing_input",
      )
      .map((reviewer) => reviewer.lens_id),
  );
  for (const incomplete of parentIncompleteLenses)
    if (!selected.has(incomplete))
      throw new V9RetryError(
        "unknown_retry_lens",
        `Parent incomplete lens was not selected for retry: ${incomplete}.`,
      );
  const currentReviewerIds = new Set(
    input.config.reviewers.map((reviewer) => reviewer.id),
  );
  const inherited = parent.reviewers.flatMap((reviewer) => {
    if (
      selected.has(reviewer.lens_id) ||
      parentIncompleteLenses.has(reviewer.lens_id) ||
      reviewer.status !== "completed" ||
      reviewer.result === undefined ||
      reviewer.digest === undefined ||
      reviewer.byte_count === undefined ||
      reviewer.terminal === undefined ||
      !currentReviewerIds.has(reviewer.reviewer_id) ||
      reviewerResultDigest(reviewer.result) !== reviewer.digest ||
      (reviewer.result.schema_version === "4" &&
        reviewer.result.change_coverage.status !== "complete" &&
        reviewer.result.change_coverage.status !== "not_applicable")
    )
      return [];
    return [
      {
        reviewerId: reviewer.reviewer_id,
        lensId: reviewer.lens_id,
        result: structuredClone(reviewer.result),
        resultDigest: reviewer.digest,
        resultByteCount: reviewer.byte_count,
        coverageEntries: structuredClone(reviewer.coverage ?? []),
        terminal: structuredClone(reviewer.terminal),
      },
    ];
  });

  const inheritedLenses = new Set(inherited.map((reviewer) => reviewer.lensId));
  const runLensIds = configuredLensIds.filter(
    (id) => selected.has(id) || !inheritedLenses.has(id),
  );
  const findingsRecord = parent.records.find(
    (record) => record.record === "run.findings",
  )?.data as Record<string, unknown> | undefined;
  const inheritedReviewerIds = new Set(
    inherited.map((reviewer) => reviewer.reviewerId),
  );
  const rawFindings = parent.canonical.raw.filter((finding) =>
    inheritedReviewerIds.has(finding.reviewer_id),
  );
  const allProofs =
    (findingsRecord?.proof_by_source_ref as
      Record<string, CanonicalFindingCoreProof> | undefined) ?? {};
  const proofBySourceRef = Object.fromEntries(
    rawFindings.flatMap((finding) =>
      allProofs[finding.source_ref] === undefined
        ? []
        : [[finding.source_ref, allProofs[finding.source_ref]!]],
    ),
  );
  return {
    parentRunId: input.parentRunId,
    runLensIds,
    inherited,
    inheritance: "exact",
    rawFindings: structuredClone(rawFindings),
    proofBySourceRef: structuredClone(proofBySourceRef),
    adjudicationOutcomes: Array.isArray(findingsRecord?.adjudication_outcomes)
      ? structuredClone(
          findingsRecord.adjudication_outcomes as Record<string, unknown>[],
        )
      : [],
  };
}
