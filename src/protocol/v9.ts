import { z } from "zod";

const utf8Bytes = (value: string): number => Buffer.byteLength(value, "utf8");

function utf8String(
  maximumBytes: number,
  options: { minimumBytes?: number } = {},
) {
  const minimumBytes = options.minimumBytes ?? 0;
  return z
    .string()
    .min(minimumBytes)
    .max(maximumBytes)
    .meta({
      description: `${minimumBytes}-${maximumBytes} UTF-8 bytes`,
      "x-review-mesh-min-utf8-bytes": minimumBytes,
      "x-review-mesh-max-utf8-bytes": maximumBytes,
    })
    .superRefine((value, ctx) => {
      const bytes = utf8Bytes(value);
      if (bytes < minimumBytes) {
        ctx.addIssue({
          code: "custom",
          message: `must contain at least ${minimumBytes} UTF-8 byte`,
        });
      }
      if (bytes > maximumBytes) {
        ctx.addIssue({
          code: "custom",
          message: `must contain at most ${maximumBytes} UTF-8 bytes`,
        });
      }
    });
}

const nonEmpty = (maximumBytes: number) =>
  utf8String(maximumBytes, { minimumBytes: 1 });
const nonNegativeInteger = z.number().int().nonnegative();
const positiveInteger = z.number().int().positive();
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const timestampSchema = z.iso.datetime({ offset: true });

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0)!);
  const rightPoints = Array.from(right, (value) => value.codePointAt(0)!);
  for (
    let index = 0;
    index < Math.min(leftPoints.length, rightPoints.length);
    index += 1
  ) {
    const difference = leftPoints[index]! - rightPoints[index]!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

export const v9RunOutcomeSchema = z.enum([
  "clear",
  "gate_findings",
  "inconclusive",
  "cancelled",
]);
export const v9GateOutcomeSchema = z.enum([
  "no_gate_findings",
  "gate_findings",
]);
export const v9CoverageOutcomeSchema = z.enum(["complete", "partial"]);
export const v9IncompleteReasonSchema = z.enum([
  "adapter_unavailable",
  "authentication_failed",
  "model_unavailable",
  "read_failure",
  "queue_deadline_exceeded",
  "probe_deadline_exceeded",
  "attempt_deadline_exceeded",
  "model_candidate_deadline_exceeded",
  "no_progress_timeout",
  "lens_deadline_exceeded",
  "run_deadline_exceeded",
  "structured_page_limit_exceeded",
  "result_page_too_large",
  "output_truncated",
  "provider_response_invalid",
  "process_crashed",
  "protocol_violation",
  "invalid_result",
  "result_too_large",
  "persistence_failed",
  "change_coverage_incomplete",
  "cancelled",
  "unknown",
]);
export const v9FindingSeveritySchema = z.enum([
  "critical",
  "high",
  "medium",
  "low",
]);
export const v9FindingConfidenceSchema = z.enum(["high", "medium", "low"]);
export const v9FindingClassificationSchema = z.enum([
  "confirmed_defect",
  "needs_verification",
  "advisory",
]);
export const v9FindingCategorySchema = z.enum([
  "correctness",
  "security",
  "reliability",
  "concurrency",
  "lifecycle",
  "cleanup",
  "compatibility",
  "deployment",
  "performance",
  "other",
]);
export const v9CoverageProofKindSchema = z.enum(["observed", "attested"]);
export const v9CoverageStatusSchema = z.enum([
  "complete",
  "incomplete",
  "not_applicable",
  "legacy_unknown",
]);
export const resultKindSchema = z.enum(["reviewer", "adjudication"]);
export const resultPageKindSchema = z.enum([
  "header",
  "coverage",
  "narrative",
  "findings",
  "decisions",
]);

const readinessString = (maximumBytes: number) => utf8String(maximumBytes);
const workspaceReferenceSchema = readinessString(2 * 1_024);

const workItemSchema = z.strictObject({
  id: readinessString(128),
  url: readinessString(2_048).optional(),
  title: readinessString(512).optional(),
});
const validationSchema = z.strictObject({
  name: readinessString(256),
  status: z.enum(["passed", "failed", "not_run"]),
  details: readinessString(2 * 1_024).optional(),
  url: readinessString(2_048).optional(),
});
const contractImpactSchema = z.strictObject({
  status: z.enum(["none", "changed", "unknown"]),
  summary: readinessString(8 * 1_024),
  references: z.array(workspaceReferenceSchema).max(32).optional(),
});
export const pullRequestV3Schema = z.strictObject({
  id: readinessString(128).optional(),
  url: readinessString(2_048).optional(),
  title: readinessString(512).optional(),
  description: readinessString(32 * 1_024).optional(),
  work_items: z.array(workItemSchema).max(100).optional(),
  validation: z.array(validationSchema).max(100).optional(),
  contract_impact: contractImpactSchema.optional(),
});

const gitRefSchema = nonEmpty(1_024).refine(
  (value) => !value.startsWith("-") && !/[\u0000-\u001f]/u.test(value),
  "Git refs must not start with '-' or contain control characters",
);
const reviewPathSchema = nonEmpty(4_096).refine(
  (value) =>
    !value.startsWith("/") &&
    !value.startsWith(":") &&
    !/^[A-Za-z]:/u.test(value) &&
    !value.includes("\\") &&
    !/[*?[\]]/u.test(value) &&
    !value.split("/").includes("..") &&
    !/[\u0000-\u001f]/u.test(value),
  "review paths must be literal workspace-relative paths",
);
const evidencePathSchema = nonEmpty(1_024).refine(
  (value) =>
    !value.startsWith("/") &&
    !value.startsWith(":") &&
    !/^[A-Za-z]:/u.test(value) &&
    !value.includes("\\") &&
    !value.split("/").includes("..") &&
    !/[\u0000-\u001f]/u.test(value),
  "evidence paths must be forward-slash workspace-relative paths",
);
const reviewPathsSchema = z.array(reviewPathSchema).min(1).optional();
const reviewScopeSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("changes"),
    base: gitRefSchema.optional(),
    head: gitRefSchema.optional(),
    branch: gitRefSchema.optional(),
    paths: reviewPathsSchema,
  }),
  z.strictObject({ mode: z.literal("full"), paths: reviewPathsSchema }),
]);
const projectNameSchema = nonEmpty(255).refine(
  (value) =>
    value !== "." &&
    value !== ".." &&
    value.trim() === value &&
    !/[\u0000-\u001f/\\]/u.test(value),
  "invalid project name",
);
export const reviewRequestV3Schema = z.strictObject({
  schema_version: z.literal("3"),
  request_id: nonEmpty(16 * 1_024).optional(),
  project_name: projectNameSchema,
  workspace: nonEmpty(16 * 1_024),
  instructions: nonEmpty(16 * 1_024),
  review_scope: reviewScopeSchema,
  context: z.json().optional(),
  pull_request: pullRequestV3Schema.optional(),
});

const findingEvidenceV4Schema = z
  .strictObject({
    path: evidencePathSchema.optional(),
    start_line: positiveInteger.optional(),
    end_line: positiveInteger.optional(),
    detail: nonEmpty(512),
  })
  .superRefine((value, ctx) => {
    const hasStart = value.start_line !== undefined;
    const hasEnd = value.end_line !== undefined;
    if ((hasStart || hasEnd) && value.path === undefined)
      ctx.addIssue({ code: "custom", message: "line ranges require a path" });
    if (hasStart !== hasEnd)
      ctx.addIssue({
        code: "custom",
        message: "line ranges require both start_line and end_line",
      });
    if (
      value.start_line !== undefined &&
      value.end_line !== undefined &&
      value.end_line < value.start_line
    ) {
      ctx.addIssue({
        code: "custom",
        message: "end_line must be greater than or equal to start_line",
      });
    }
  });
const findingClaimSchema = z.strictObject({
  trigger: nonEmpty(768),
  affected_behavior: nonEmpty(768),
  outcome: nonEmpty(768),
});
export const actionableFindingV4Schema = z.strictObject({
  id: nonEmpty(256),
  severity: v9FindingSeveritySchema,
  title: nonEmpty(256),
  description: nonEmpty(768),
  evidence: z.array(findingEvidenceV4Schema).min(1).max(3),
  suggested_direction: nonEmpty(768),
  confidence: v9FindingConfidenceSchema,
  classification: v9FindingClassificationSchema,
  external_assumptions: z.array(nonEmpty(256)).max(4),
  root_issue_id: nonEmpty(256).optional(),
  duplicate_of: nonEmpty(256).optional(),
  duplicate_finding_ids: z.array(nonEmpty(256)).max(8).optional(),
  category: v9FindingCategorySchema,
  verification: nonEmpty(768),
  change_impact: nonEmpty(768).optional(),
  claim: findingClaimSchema,
});
const informationalNoteV4Schema = z.strictObject({
  title: nonEmpty(256),
  description: nonEmpty(1_024),
});

const coverageDeficitSchema = z.strictObject({
  path: nonEmpty(1_024),
  reason: nonEmpty(128),
});
export const changeCoverageResultSchema = z
  .strictObject({
    status: v9CoverageStatusSchema,
    proof_kind: v9CoverageProofKindSchema.optional(),
    scope_digest: digestSchema.optional(),
    inspected_count: nonNegativeInteger,
    deficit_count: nonNegativeInteger,
    deficit_sample: z.array(coverageDeficitSchema).max(8),
  })
  .superRefine((value, ctx) => {
    if (
      (value.status === "complete" || value.status === "incomplete") &&
      (value.proof_kind === undefined || value.scope_digest === undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "evaluated change coverage requires proof_kind and scope_digest",
      });
    }
    if (value.status === "complete" && value.deficit_count !== 0)
      ctx.addIssue({
        code: "custom",
        message: "complete change coverage requires zero deficits",
      });
    if (value.deficit_sample.length > value.deficit_count)
      ctx.addIssue({
        code: "custom",
        message: "deficit sample cannot exceed deficit count",
      });
  });

export const coverageAttestationEntrySchema = z
  .strictObject({
    path: evidencePathSchema.refine(
      (value) => value === value.normalize("NFC"),
      "coverage attestation paths must be NFC normalized",
    ),
    method: z.enum(["full_file", "diff", "deleted_diff"]),
    snapshot_digest: digestSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.method === "full_file" && value.snapshot_digest === undefined)
      ctx.addIssue({
        code: "custom",
        message: "full_file attestation requires snapshot_digest",
      });
    if (
      (value.method === "diff" || value.method === "deleted_diff") &&
      value.snapshot_digest !== undefined
    )
      ctx.addIssue({
        code: "custom",
        message: "diff-only attestation must omit snapshot_digest",
      });
  });
export const coverageAttestationSchema = z
  .strictObject({
    scope_digest: digestSchema,
    entries: z.array(coverageAttestationEntrySchema).max(256),
  })
  .superRefine((value, ctx) => {
    const paths = value.entries.map((entry) => entry.path);
    if (new Set(paths).size !== paths.length) {
      ctx.addIssue({
        code: "custom",
        message: "coverage attestation paths must be unique",
      });
    }
    for (let index = 1; index < paths.length; index += 1) {
      if (compareCodePoints(paths[index - 1]!, paths[index]!) >= 0) {
        ctx.addIssue({
          code: "custom",
          message: "coverage attestation entries must be sorted by path",
        });
        break;
      }
    }
  });

const providerReviewerShape = {
  schema_version: z.literal("4"),
  verdict: z.enum(["pass", "fail"]),
  review_markdown: z.string(),
  summary: nonEmpty(1_024),
  actionable_findings: z.array(actionableFindingV4Schema).max(16),
  informational_notes: z.array(informationalNoteV4Schema).max(4),
  coverage_attestation: coverageAttestationSchema.optional(),
};
function validateVerdict(
  value: { verdict: "pass" | "fail"; actionable_findings: unknown[] },
  ctx: z.RefinementCtx,
): void {
  if (value.verdict === "pass" && value.actionable_findings.length !== 0)
    ctx.addIssue({
      code: "custom",
      message: "pass requires no actionable findings",
    });
  if (value.verdict === "fail" && value.actionable_findings.length === 0)
    ctx.addIssue({
      code: "custom",
      message: "fail requires an actionable finding",
    });
}
export const providerReviewerResultV4Schema = z
  .strictObject(providerReviewerShape)
  .superRefine(validateVerdict);
export const reviewerResultV4Schema = z
  .strictObject({
    ...providerReviewerShape,
    change_coverage: changeCoverageResultSchema,
  })
  .superRefine(validateVerdict);

const adjustedFindingV2Schema = actionableFindingV4Schema.omit({
  id: true,
  duplicate_of: true,
  duplicate_finding_ids: true,
});
const orderedExecutionProofV2Schema = z.strictObject({
  steps: z
    .array(
      z.strictObject({
        order: positiveInteger,
        description: nonEmpty(768),
        citation: findingEvidenceV4Schema,
      }),
    )
    .min(2)
    .max(32),
  failure_point: z.strictObject({
    step_order: positiveInteger,
    citation: findingEvidenceV4Schema.optional(),
    detail: nonEmpty(768),
  }),
});
const baseHeadComparisonV2Schema = z.strictObject({
  base: z.strictObject({
    behavior: nonEmpty(768),
    citation: findingEvidenceV4Schema,
  }),
  head: z.strictObject({
    behavior: nonEmpty(768),
    citation: findingEvidenceV4Schema,
  }),
  impact: nonEmpty(768),
});
export const adjudicationDecisionV2Schema = z.strictObject({
  source_finding_id: nonEmpty(256),
  decision: z.enum(["confirmed", "rejected", "adjusted"]),
  rationale: nonEmpty(768),
  cited_evidence: z.array(findingEvidenceV4Schema).max(3),
  adjusted_finding: adjustedFindingV2Schema.optional(),
  ordered_execution_proof: orderedExecutionProofV2Schema.optional(),
  base_head_comparison: baseHeadComparisonV2Schema.optional(),
  unverified_assumptions: z.array(nonEmpty(256)).max(4),
  duplicate_of: nonEmpty(256).optional(),
});
export const adjudicationResultV2Schema = z.strictObject({
  schema_version: z.literal("2"),
  kind: z.literal("review-mesh.adjudication-result"),
  verdict: z.enum(["pass", "fail"]),
  review_markdown: utf8String(16 * 1_024),
  summary: nonEmpty(1_024),
  actionable_findings: z.tuple([]),
  decisions: z.array(adjudicationDecisionV2Schema).max(256),
  informational_notes: z.array(informationalNoteV4Schema).max(4),
});

const pageEnvelope = {
  schema_version: z.literal("1"),
  kind: z.literal("review-mesh.result-page"),
  result_id: nonEmpty(256),
  page_index: nonNegativeInteger,
  previous_page_digest: digestSchema.nullable(),
};
const reviewerPageEnvelope = {
  ...pageEnvelope,
  result_kind: z.literal("reviewer"),
  result_schema_version: z.literal("4"),
  page_count: z.number().int().min(1).max(951),
};
const adjudicationPageEnvelope = {
  ...pageEnvelope,
  result_kind: z.literal("adjudication"),
  result_schema_version: z.literal("2"),
  page_count: z.number().int().min(1).max(65),
};
const reviewerHeaderPageSchema = z.strictObject({
  ...reviewerPageEnvelope,
  page_kind: z.literal("header"),
  payload: z.strictObject({
    verdict: z.enum(["pass", "fail"]),
    summary: nonEmpty(1_024),
    informational_notes: z.array(informationalNoteV4Schema).max(4),
    narrative_byte_count: nonNegativeInteger,
    narrative_fragment_count: z.number().int().min(0).max(686),
    actionable_finding_count: z.number().int().min(0).max(16),
    coverage_attestation: z
      .strictObject({
        scope_digest: digestSchema,
        entry_count: z.number().int().min(0).max(256),
        entries_digest: digestSchema,
      })
      .nullable()
      .optional(),
  }),
});
const reviewerCoveragePageSchema = z.strictObject({
  ...reviewerPageEnvelope,
  page_kind: z.literal("coverage"),
  payload: z.strictObject({
    entries: z.array(coverageAttestationEntrySchema).min(1).max(16),
  }),
});
const reviewerNarrativePageSchema = z.strictObject({
  ...reviewerPageEnvelope,
  page_kind: z.literal("narrative"),
  payload: z.strictObject({
    text_fragment: utf8String(24 * 1_024, { minimumBytes: 1 }),
  }),
});
const reviewerFindingsPageSchema = z.strictObject({
  ...reviewerPageEnvelope,
  page_kind: z.literal("findings"),
  payload: z.strictObject({
    actionable_findings: z.array(actionableFindingV4Schema).min(1).max(2),
  }),
});
const adjudicationHeaderPageSchema = z.strictObject({
  ...adjudicationPageEnvelope,
  page_kind: z.literal("header"),
  payload: z.strictObject({
    verdict: z.enum(["pass", "fail"]),
    review_markdown: utf8String(16 * 1_024),
    summary: nonEmpty(1_024),
    informational_notes: z.array(informationalNoteV4Schema).max(4),
    candidate_count: z.number().int().min(0).max(256),
    candidate_ids_digest: digestSchema,
  }),
});
const adjudicationDecisionsPageSchema = z.strictObject({
  ...adjudicationPageEnvelope,
  page_kind: z.literal("decisions"),
  payload: z.strictObject({
    decisions: z.array(adjudicationDecisionV2Schema).min(1).max(4),
  }),
});
export const resultPageSchema = z.union([
  reviewerHeaderPageSchema,
  reviewerCoveragePageSchema,
  reviewerNarrativePageSchema,
  reviewerFindingsPageSchema,
  adjudicationHeaderPageSchema,
  adjudicationDecisionsPageSchema,
]);

const boundedId = nonEmpty(128);
const artifactReferenceSchema = z.strictObject({
  path: nonEmpty(4_096),
  sha256: digestSchema,
  byte_count: nonNegativeInteger,
  completed_results: nonNegativeInteger,
});
const resultDeliverySchema = z.strictObject({
  completed_results: nonNegativeInteger,
  artifact: z.enum(["complete", "not_requested", "failed"]),
  planned_public_stream: z.enum(["complete", "references_only"]),
});
const v6LensSummarySchema = z.strictObject({
  lens_id: boundedId,
  outcome: z.enum([
    "passed",
    "findings",
    "incomplete",
    "not_applicable",
    "not_evaluated",
  ]),
  message: utf8String(128).optional(),
});
export const selectedDeadlineSchema = z.strictObject({
  mode: z.enum(["adaptive", "fixed"]),
  tier: z.enum(["tiny", "small", "medium", "large", "fixed"]),
  duration_ms: positiveInteger,
  started_at: timestampSchema,
  deadline_at: timestampSchema,
  inputs: z.strictObject({
    review_scope: z.enum(["changes", "full"]),
    changed_file_count: nonNegativeInteger,
    raw_diff_byte_count: nonNegativeInteger,
    changed_files_truncated: z.boolean(),
    diff_truncated: z.boolean(),
  }),
});
const countDimension = z.strictObject({
  status: z.enum(["complete", "partial"]),
});
const modelCounts = z.strictObject({
  total: nonNegativeInteger,
  completed: nonNegativeInteger,
  incomplete: nonNegativeInteger,
  skipped: nonNegativeInteger,
  running: nonNegativeInteger,
  queued: nonNegativeInteger,
});
const v6RunCompletedDataSchema = z
  .strictObject({
    run_outcome: v9RunOutcomeSchema,
    gate_outcome: v9GateOutcomeSchema,
    coverage_outcome: v9CoverageOutcomeSchema,
    exit_code: z.number().int().min(0).max(4),
    raw_source_findings: nonNegativeInteger,
    atomic_subfindings: nonNegativeInteger,
    canonical_roots: nonNegativeInteger,
    gate_eligible_subfindings: nonNegativeInteger,
    advisory_subfindings: nonNegativeInteger,
    rejected_subfindings: nonNegativeInteger,
    needs_verification_subfindings: nonNegativeInteger,
    out_of_scope_subfindings: nonNegativeInteger.optional(),
    policy_non_gating_subfindings: nonNegativeInteger.optional(),
    non_gating_subfindings: nonNegativeInteger,
    incomplete_lenses: nonNegativeInteger,
    result_delivery: resultDeliverySchema,
    execution_coverage: countDimension.optional(),
    change_coverage: z
      .strictObject({ status: v9CoverageStatusSchema })
      .optional(),
    deadline: selectedDeadlineSchema.optional(),
    total_elapsed_ms: nonNegativeInteger.optional(),
    model_runs: modelCounts.optional(),
    artifact: artifactReferenceSchema,
    lens_summaries: z.array(v6LensSummarySchema).max(8),
    total_lens_summaries: nonNegativeInteger.optional(),
    total_exclusions: nonNegativeInteger.optional(),
    total_warnings: nonNegativeInteger.optional(),
    total_deficit_samples: nonNegativeInteger.optional(),
    exclusions: z.array(boundedId).max(8),
    warnings: z.array(boundedId).max(8),
    deficit_samples: z.array(boundedId).max(8),
    omitted_lens_summaries_count: nonNegativeInteger.optional(),
    omitted_exclusions_count: nonNegativeInteger.optional(),
    omitted_warnings_count: nonNegativeInteger.optional(),
    omitted_deficit_samples_count: nonNegativeInteger.optional(),
    lens_summaries_digest: digestSchema.optional(),
    exclusions_digest: digestSchema.optional(),
    warnings_digest: digestSchema.optional(),
    deficit_samples_digest: digestSchema.optional(),
  })
  .superRefine((value, ctx) => {
    const expectedRunOutcome =
      value.run_outcome === "cancelled"
        ? "cancelled"
        : value.coverage_outcome === "partial"
          ? "inconclusive"
          : value.gate_outcome === "gate_findings"
            ? "gate_findings"
            : "clear";
    if (value.run_outcome !== expectedRunOutcome)
      ctx.addIssue({
        code: "custom",
        message: `run_outcome must be ${expectedRunOutcome}`,
      });
    const expectedExitCode =
      value.run_outcome === "cancelled"
        ? 4
        : value.coverage_outcome === "partial"
          ? 3
          : value.gate_outcome === "gate_findings"
            ? 1
            : 0;
    if (value.exit_code !== expectedExitCode)
      ctx.addIssue({
        code: "custom",
        message: `exit_code must be ${expectedExitCode}`,
      });
    const expectedNonGating =
      value.atomic_subfindings - value.gate_eligible_subfindings;
    const componentNonGating =
      value.advisory_subfindings +
      value.rejected_subfindings +
      value.needs_verification_subfindings +
      (value.out_of_scope_subfindings ?? 0) +
      (value.policy_non_gating_subfindings ?? 0);
    if (value.non_gating_subfindings !== expectedNonGating)
      ctx.addIssue({
        code: "custom",
        message:
          "non_gating_subfindings must equal atomic minus gate-eligible subfindings",
      });
    if (value.non_gating_subfindings !== componentNonGating)
      ctx.addIssue({
        code: "custom",
        message:
          "non_gating_subfindings must equal the five named non-gating components",
      });
    if (
      value.raw_source_findings < value.atomic_subfindings ||
      value.gate_eligible_subfindings > value.atomic_subfindings ||
      value.non_gating_subfindings > value.atomic_subfindings ||
      value.advisory_subfindings > value.atomic_subfindings ||
      value.rejected_subfindings > value.atomic_subfindings ||
      value.needs_verification_subfindings > value.atomic_subfindings ||
      (value.out_of_scope_subfindings ?? 0) > value.atomic_subfindings ||
      (value.policy_non_gating_subfindings ?? 0) > value.atomic_subfindings
    )
      ctx.addIssue({
        code: "custom",
        message: "derived finding counts cannot exceed atomic_subfindings",
      });
    if (
      (value.gate_outcome === "gate_findings") !==
      value.gate_eligible_subfindings > 0
    ) {
      ctx.addIssue({
        code: "custom",
        message: "gate_outcome must match gate_eligible_subfindings",
      });
    }
    if (
      value.result_delivery.completed_results !==
      value.artifact.completed_results
    )
      ctx.addIssue({
        code: "custom",
        message: "artifact completed_results must match result delivery",
      });
  });
const v6EventEnvelope = {
  schema_version: z.literal("6"),
  run_id: nonEmpty(128),
  request_id: nonEmpty(128).optional(),
  seq: positiveInteger,
  timestamp: timestampSchema,
  reviewer_id: nonEmpty(128).optional(),
};
const v6ReviewerPhaseSchema = z.enum([
  "probing",
  "queued",
  "reviewing",
  "validating",
  "continuing",
  "retry_backoff",
  "finalizing",
  "terminal",
]);
const v6ActiveHeartbeatEntrySchema = z.strictObject({
  reviewer_id: boundedId,
  lens_id: boundedId,
  mode: z.enum(["full_review", "adjudication"]),
  attempt: positiveInteger,
  maximum_attempts: positiveInteger,
  phase: v6ReviewerPhaseSchema,
  attempt_elapsed_ms: nonNegativeInteger,
  lens_elapsed_ms: nonNegativeInteger,
  run_deadline_remaining_ms: nonNegativeInteger,
  lens_deadline_remaining_ms: nonNegativeInteger,
  attempt_deadline_remaining_ms: nonNegativeInteger,
  last_progress_age_ms: nonNegativeInteger,
  coalesced_activity_count: nonNegativeInteger,
  admitted_at: timestampSchema.optional(),
  queue_reason: z.enum(["provider_limit", "execution_limit"]).optional(),
  queue_wait_ms: nonNegativeInteger.optional(),
  probe_elapsed_ms: nonNegativeInteger.optional(),
});
const v6GenericEventDataSchema = z.strictObject({
  detail_ref: boundedId.optional(),
  message: nonEmpty(1_000).optional(),
});
const reviewerLifecycleData = {
  lens_id: boundedId,
  mode: z.enum(["full_review", "adjudication"]),
};
const progressData = z.strictObject({
  ...reviewerLifecycleData,
  phase: v6ReviewerPhaseSchema,
  attempt: positiveInteger.optional(),
  maximum_attempts: positiveInteger.optional(),
  message: utf8String(1000).optional(),
  queue_reason: z.enum(["provider_limit", "execution_limit"]).optional(),
  queued_at: timestampSchema.optional(),
});
const publicEventV6BaseSchema = z.discriminatedUnion("event", [
  z.strictObject({
    ...v6EventEnvelope,
    event: z.literal("run.persistence_failed"),
    data: z.strictObject({
      terminal: z.literal(true),
      exit_code: z.literal(3),
      reason: boundedId,
      stage: boundedId,
      message: utf8String(1000),
      native_error_code: z
        .string()
        .regex(/^[A-Z][A-Z0-9_]{0,63}$/u)
        .optional(),
      path: utf8String(4096).optional(),
      recovery_command: utf8String(4096).optional(),
      recovery_artifact: artifactReferenceSchema.optional(),
    }),
  }),
  z.strictObject({
    ...v6EventEnvelope,
    event: z.literal("run.completed"),
    data: v6RunCompletedDataSchema,
  }),
  z.strictObject({
    ...v6EventEnvelope,
    event: z.literal("run.started"),
    data: z.strictObject({
      consistency_mode: z.literal("live_worktree"),
      parent_run_id: boundedId.optional(),
    }),
  }),
  z.strictObject({
    ...v6EventEnvelope,
    event: z.literal("reviewer.incomplete"),
    data: z.strictObject({
      lens_id: boundedId,
      reason: v9IncompleteReasonSchema,
      failure_stage: boundedId,
      attempt_count: positiveInteger,
      retryable: z.boolean(),
      fallback_eligible: z.boolean(),
      detail_ref: boundedId,
      mode: z.enum(["full_review", "adjudication"]).optional(),
      message: utf8String(1000).optional(),
      elapsed_ms: nonNegativeInteger.optional(),
      expired_boundary: v9IncompleteReasonSchema.optional(),
    }),
  }),
  z.strictObject({
    ...v6EventEnvelope,
    event: z.literal("reviewer.result"),
    data: z.strictObject({
      digest: digestSchema,
      byte_count: nonNegativeInteger,
      detail_ref: boundedId,
      result: z
        .union([reviewerResultV4Schema, adjudicationResultV2Schema])
        .optional(),
      lens_id: boundedId.optional(),
      mode: z.enum(["full_review", "adjudication"]).optional(),
    }),
  }),
  z.strictObject({
    ...v6EventEnvelope,
    event: z.literal("suite.heartbeat"),
    data: z.strictObject({
      elapsed_ms: nonNegativeInteger,
      active: z.array(v6ActiveHeartbeatEntrySchema).max(8),
      active_count: nonNegativeInteger.optional(),
      model_runs: modelCounts.optional(),
      run_deadline_remaining_ms: nonNegativeInteger.optional(),
      minimal: z.boolean().optional(),
      detail_ref: boundedId.optional(),
      omitted_active_count: nonNegativeInteger.optional(),
      active_digest: digestSchema.optional(),
      artifact: artifactReferenceSchema.optional(),
    }),
  }),
  z.strictObject({
    ...v6EventEnvelope,
    event: z.literal("context.resolved"),
    data: z.strictObject({
      project_name: nonEmpty(255),
      review_scope: z.enum(["changes", "full"]),
      changed_files_count: nonNegativeInteger,
      diff_byte_count: nonNegativeInteger,
      truncated: z.boolean(),
      detail_ref: boundedId,
    }),
  }),
  z.strictObject({
    ...v6EventEnvelope,
    event: z.literal("suite.resolved"),
    data: z.strictObject({
      logical_lenses: nonNegativeInteger,
      model_runs: nonNegativeInteger,
      deadline: selectedDeadlineSchema,
      warnings: z.array(boundedId).max(8),
      omitted_warnings_count: nonNegativeInteger.optional(),
      warnings_digest: digestSchema.optional(),
      detail_ref: boundedId,
    }),
  }),
  z.strictObject({
    ...v6EventEnvelope,
    event: z.literal("reviewer.started"),
    data: z.strictObject({
      ...reviewerLifecycleData,
      adapter: boundedId,
      model: nonEmpty(256),
      provider_group: boundedId,
      attempt: positiveInteger,
      maximum_attempts: positiveInteger,
      timeout_ms: nonNegativeInteger,
      run_deadline_remaining_ms: nonNegativeInteger,
      lens_deadline_remaining_ms: nonNegativeInteger,
      progress_observable: z.boolean(),
      proof: v9CoverageProofKindSchema,
      admitted_at: timestampSchema.optional(),
      queue_wait_ms: nonNegativeInteger.optional(),
      probe_elapsed_ms: nonNegativeInteger.optional(),
    }),
  }),
  z.strictObject({
    ...v6EventEnvelope,
    event: z.literal("reviewer.progress"),
    data: progressData,
  }),
  z.strictObject({
    ...v6EventEnvelope,
    event: z.literal("reviewer.heartbeat"),
    data: progressData,
  }),
  z.strictObject({
    ...v6EventEnvelope,
    event: z.literal("reviewer.completed"),
    data: z.strictObject({
      ...reviewerLifecycleData,
      verdict: z.enum(["pass", "fail"]),
      elapsed_ms: nonNegativeInteger,
      actionable_findings: nonNegativeInteger,
      summary: utf8String(1024),
      change_coverage: changeCoverageResultSchema.optional(),
      detail_ref: boundedId,
    }),
  }),
  z.strictObject({
    ...v6EventEnvelope,
    event: z.literal("reviewer.skipped"),
    data: z.strictObject({
      ...reviewerLifecycleData,
      reason: boundedId,
      missing_inputs: z
        .array(
          z.strictObject({
            selector: nonEmpty(1024),
            code: z.enum(["missing_required_input", "invalid_required_input"]),
          }),
        )
        .max(8)
        .optional(),
      omitted_missing_inputs_count: nonNegativeInteger.optional(),
      detail_ref: boundedId,
    }),
  }),
]);
export const publicEventV6Schema = publicEventV6BaseSchema.superRefine(
  (value, ctx) => {
    if (
      (value.event === "run.completed" ||
        value.event === "run.persistence_failed" ||
        value.event === "suite.heartbeat") &&
      Buffer.byteLength(JSON.stringify(value), "utf8") >= 16 * 1_024
    ) {
      ctx.addIssue({
        code: "custom",
        message: "run.completed must remain below 16 KiB",
      });
    }
  },
);

export type ReviewRequestV3 = z.infer<typeof reviewRequestV3Schema>;
export type PullRequestV3 = z.infer<typeof pullRequestV3Schema>;
export type ActionableFindingV4 = z.infer<typeof actionableFindingV4Schema>;
export type ProviderReviewerResultV4 = z.infer<
  typeof providerReviewerResultV4Schema
>;
export type ReviewerResultV4 = z.infer<typeof reviewerResultV4Schema>;
export type ChangeCoverageResult = z.infer<typeof changeCoverageResultSchema>;
export type CoverageAttestation = z.infer<typeof coverageAttestationSchema>;
export type AdjudicationDecisionV2 = z.infer<
  typeof adjudicationDecisionV2Schema
>;
export type AdjudicationResultV2 = z.infer<typeof adjudicationResultV2Schema>;
export type ResultPage = z.infer<typeof resultPageSchema>;
export type PublicEventV6 = z.infer<typeof publicEventV6Schema>;
export type V9RunOutcome = z.infer<typeof v9RunOutcomeSchema>;
export type V9GateOutcome = z.infer<typeof v9GateOutcomeSchema>;
export type V9CoverageOutcome = z.infer<typeof v9CoverageOutcomeSchema>;
export type V9IncompleteReason = z.infer<typeof v9IncompleteReasonSchema>;
export type V9FindingSeverity = z.infer<typeof v9FindingSeveritySchema>;
export type V9FindingConfidence = z.infer<typeof v9FindingConfidenceSchema>;
export type V9FindingClassification = z.infer<
  typeof v9FindingClassificationSchema
>;
export type V9FindingCategory = z.infer<typeof v9FindingCategorySchema>;
export type V9CoverageProofKind = z.infer<typeof v9CoverageProofKindSchema>;
export type V9CoverageStatus = z.infer<typeof v9CoverageStatusSchema>;
export type ResultKind = z.infer<typeof resultKindSchema>;
export type ResultPageKind = z.infer<typeof resultPageKindSchema>;
