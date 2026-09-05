import { z } from "zod";
import {
  actionableFindingV4Schema,
  adjudicationDecisionV2Schema,
  v9FindingClassificationSchema,
  v9FindingConfidenceSchema,
  v9FindingSeveritySchema,
} from "../protocol/v9.js";
import {
  adjudicationDecisionSchema,
  findingCategorySchema,
  findingClassificationSchema,
  findingConfidenceSchema,
  findingSeveritySchema,
} from "../protocol/schemas.js";

const id = z.string().min(1).max(256);
const text = z.string();
const count = z.number().int().nonnegative();

const canonicalEvidenceSchema = z
  .strictObject({
    path: text.optional(),
    start_line: z.number().int().positive().optional(),
    end_line: z.number().int().positive().optional(),
    detail: text,
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
    )
      ctx.addIssue({
        code: "custom",
        message: "end_line must be greater than or equal to start_line",
      });
  });

const canonicalClaimSchema = z.strictObject({
  trigger: text,
  affected_behavior: text,
  outcome: text,
});

const canonicalEffectiveFindingSchema = z.strictObject({
  severity: v9FindingSeveritySchema,
  title: text,
  description: text,
  evidence: z.array(canonicalEvidenceSchema).max(256),
  suggested_direction: text,
  confidence: v9FindingConfidenceSchema,
  classification: v9FindingClassificationSchema,
  root_issue_id: text.optional(),
  external_assumptions: z.array(text).max(256),
  category: text.optional(),
  verification: text.optional(),
  change_impact: text.optional(),
  claim: canonicalClaimSchema.optional(),
});

export const canonicalRawFindingSchema = z.strictObject({
  provenance: z.literal("reviewer_result_v4").optional(),
  source_ref: id,
  reviewer_id: id,
  lens_id: id,
  finding_id: id,
  severity: v9FindingSeveritySchema,
  title: text,
  description: text,
  evidence: z.array(canonicalEvidenceSchema).max(256),
  suggested_direction: text,
  confidence: v9FindingConfidenceSchema,
  classification: v9FindingClassificationSchema,
  external_assumptions: z.array(text).max(256),
  source_findings: z
    .array(z.strictObject({ reviewer_id: id, finding_id: id }))
    .max(256),
  duplicate_finding_ids: z.array(id).max(256),
  root_issue_id: text.optional(),
  deduplication_key: text.optional(),
  duplicate_of: text.optional(),
  confirmed_duplicate_of: text.optional(),
  gate_eligible: z.boolean().optional(),
  adjudication: z
    .enum([
      "unadjudicated",
      "confirmed",
      "adjusted",
      "rejected",
      "needs_verification",
    ])
    .optional(),
  category: text.optional(),
  verification: text.optional(),
  change_impact: text.optional(),
  claim: canonicalClaimSchema.optional(),
  effective_finding: canonicalEffectiveFindingSchema.optional(),
});

export const canonicalFindingCoreProofSchema = z.strictObject({
  evidence_verified: z.boolean().optional(),
  source_coverage_verified: z.boolean().optional(),
  ordered_proof_required: z.boolean().optional(),
  ordered_proof_verified: z.boolean().optional(),
  change_impact_required: z.boolean().optional(),
  change_impact_verified: z.boolean().optional(),
  adjudication_required: z.boolean().optional(),
  out_of_scope: z.boolean().optional(),
  policy_non_gating: z.boolean().optional(),
  unrelated_coverage_deficits: z.array(text).max(256).optional(),
});

const legacyEffectiveFindingSchema = z.strictObject({
  id,
  severity: findingSeveritySchema,
  title: text,
  description: text,
  evidence: z.array(canonicalEvidenceSchema).max(256),
  suggested_direction: text,
  confidence: findingConfidenceSchema,
  classification: findingClassificationSchema,
  external_assumptions: z.array(text).max(256),
  root_issue_id: text.optional(),
  duplicate_of: text.optional(),
  duplicate_finding_ids: z.array(text).max(256).optional(),
  category: findingCategorySchema.optional(),
  verification: text.optional(),
  change_impact: text.optional(),
  claim: canonicalClaimSchema.optional(),
});

const v2EffectiveFindingSchema = actionableFindingV4Schema;
const decisionSchema = z.union([
  adjudicationDecisionV2Schema,
  adjudicationDecisionSchema,
]);
const effectiveFindingSchema = z.union([
  v2EffectiveFindingSchema,
  legacyEffectiveFindingSchema,
]);

export const effectiveAdjudicationDecisionSchema = z.strictObject({
  source_finding_id: id,
  requested_decision: z.enum(["confirmed", "rejected", "adjusted", "missing"]),
  effective_decision: z.enum([
    "confirmed",
    "rejected",
    "adjusted",
    "needs_verification",
  ]),
  gate_eligible: z.boolean(),
  issues: z
    .array(
      z.enum([
        "decision_required",
        "duplicate_decision",
        "unknown_source_finding_id",
        "cited_evidence_required",
        "cited_evidence_location_required",
        "cited_evidence_context_required",
        "adjusted_finding_required",
        "ordered_execution_proof_required",
        "ordered_execution_steps_invalid",
        "ordered_execution_citation_required",
        "ordered_execution_context_required",
        "failure_point_invalid",
        "failure_point_citation_required",
        "failure_point_context_required",
        "base_head_comparison_required",
        "base_head_citation_required",
        "base_head_context_required",
        "core_evidence_verification_required",
        "validation_attestation_required",
      ]),
    )
    .max(64),
  decision: decisionSchema.optional(),
  effective_finding: effectiveFindingSchema.optional(),
});

export const persistedAdjudicationOutcomeSchema = z.strictObject({
  adjudicator_reviewer_id: id,
  source_reviewer_id: id,
  complete: z.boolean(),
  decisions: z.array(effectiveAdjudicationDecisionSchema).max(256),
  unknown_source_finding_ids: z.array(id).max(256),
});

export const canonicalRawFindingArraySchema = z
  .array(canonicalRawFindingSchema)
  .max(16384);
export const canonicalFindingProofMapSchema = z.record(
  id,
  canonicalFindingCoreProofSchema,
);
export const adjudicationOutcomeArraySchema = z
  .array(persistedAdjudicationOutcomeSchema)
  .max(1024);

export const runFindingsPayloadSchema = z.strictObject({
  raw: canonicalRawFindingArraySchema,
  proof_by_source_ref: canonicalFindingProofMapSchema,
  adjudication_outcomes: adjudicationOutcomeArraySchema,
  gate_policies: z.record(
    id,
    z.strictObject({
      minimumSeverity: v9FindingSeveritySchema,
      minimumConfidence: v9FindingConfidenceSchema,
    }),
  ),
  canonical_counts: z.strictObject({
    raw_source_findings: count,
    atomic_subfindings: count,
    canonical_roots: count,
    gate_eligible_subfindings: count,
    advisory_subfindings: count,
    rejected_subfindings: count,
    needs_verification_subfindings: count,
    out_of_scope_subfindings: count,
    policy_non_gating_subfindings: count,
    non_gating_subfindings: count,
  }),
});

export const runFindingsRecordSchema = z.strictObject({
  record: z.literal("run.findings"),
  schema_version: z.literal("1"),
  run_id: z.string().min(1).max(128),
  data: runFindingsPayloadSchema,
});
