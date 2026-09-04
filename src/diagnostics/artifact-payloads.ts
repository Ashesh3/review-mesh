import { z } from "zod";
import { createHash } from "node:crypto";
import {
  reviewRequestV3Schema,
  resultPageSchema,
  selectedDeadlineSchema,
  v9IncompleteReasonSchema,
  v9FindingSeveritySchema,
  v9FindingConfidenceSchema,
} from "../protocol/v9.js";

const id = z.string().min(1).max(128),
  count = z.number().int().nonnegative(),
  text = z.string(),
  digest = z.string().regex(/^[a-f0-9]{64}$/u);
const phase = z.enum([
  "deferred",
  "queued",
  "probing",
  "starting",
  "reviewing",
  "validating",
  "continuing",
  "retry_backoff",
  "finalizing",
  "terminal",
]);
const material = z.enum([
  "file_access",
  "request",
  "response",
  "page",
  "failure",
  "terminal",
]);
const coverageEntry = z.strictObject({
  path: text,
  kind: z.enum(["tracked", "deleted", "untracked"]),
  required_method: z.enum(["full_file", "diff", "deleted_diff"]),
  proof_kind: z.enum(["observed", "attested"]),
  relevant: z.boolean(),
  snapshot_digest: digest.optional(),
  snapshot_byte_count: count.optional(),
  snapshot_read: z.enum([
    "satisfied",
    "not_required",
    "unavailable",
    "oversize",
    "binary",
    "not_inspected",
  ]),
  diff_delivery: z.enum([
    "satisfied",
    "not_required",
    "context_truncated",
    "unavailable",
    "binary",
    "not_inspected",
  ]),
  disposition: z.enum(["satisfied", "deficit"]),
  reason: text.optional(),
});
const proof = z.strictObject({
  evidence_verified: z.boolean().optional(),
  source_coverage_verified: z.boolean().optional(),
  ordered_proof_required: z.boolean().optional(),
  ordered_proof_verified: z.boolean().optional(),
  change_impact_required: z.boolean().optional(),
  change_impact_verified: z.boolean().optional(),
  adjudication_required: z.boolean().optional(),
  out_of_scope: z.boolean().optional(),
  policy_non_gating: z.boolean().optional(),
  unrelated_coverage_deficits: z.array(text).optional(),
});
const failure = z.strictObject({
  reason: v9IncompleteReasonSchema.or(z.literal("timeout")),
  message: text.max(1000),
  retryable: z.boolean(),
  fallback_eligible: z.boolean().optional(),
  circuit_qualifying: z.boolean().optional(),
  diagnostics: z.record(text, z.unknown()).optional(),
});
const policy = z.strictObject({
  kind: z.enum(["generic", "change_readiness"]).optional(),
  lensDeadlineMs: count.optional(),
  requiredInput: z.array(text).optional(),
  changeCoverage: z
    .strictObject({
      relevantPaths: z.array(text),
      minimumInspection: z.enum(["full_file", "diff"]),
      proof: z.enum(["observed", "attested"]),
    })
    .optional(),
  applicability: z
    .union([
      z.strictObject({ mode: z.literal("always") }),
      z.strictObject({
        mode: z.literal("changed_paths"),
        anyChangedPaths: z.array(text),
        caseSensitive: z.boolean().optional(),
      }),
    ])
    .optional(),
  requiredCallerContext: z.array(text).optional(),
  passQuorum: count,
  minimumProviderGroups: count,
  allowZeroOutageTolerance: z.boolean().optional(),
  adjudication: z.enum(["off", "required"]),
  gateMinimumSeverity: v9FindingSeveritySchema,
  gateMinimumConfidence: v9FindingConfidenceSchema,
  mode: z.enum(["full_review", "adjudication"]).optional(),
  adjudicatesReviewerId: id.optional(),
  candidateFindings: z.json().optional(),
});
const execution = z.strictObject({
  max_concurrency: count,
  heartbeat_interval_ms: count,
  shutdown_grace_period_ms: count,
  distribute_primaries: z.boolean(),
  allow_provider_concentration: z.boolean(),
  default_provider_concurrency: count,
  provider_limits: z.record(text, count),
  circuit_breaker_threshold: count,
  circuit_breaker_cooldown_ms: count,
  retry_attempts: count,
  continuation_attempts: count,
  retry_backoff_ms: count,
  deadline_mode: z.enum(["adaptive", "fixed"]).optional(),
  run_deadline_ms: count.optional(),
  no_progress_timeout_ms: count.optional(),
});
const warning = z.strictObject({
  code: id,
  message: text,
  acknowledged: z.boolean().optional(),
  lens_ids: z.array(id),
  provider_groups: z.array(id).optional(),
});

export const privatePayloadSchemas: Record<string, z.ZodType> = {
  request: reviewRequestV3Schema,
  resolution: z.strictObject({
    execution: execution.optional(),
    reviewers: z.array(
      z.strictObject({
        id,
        agent_id: id.optional(),
        policy: policy.optional(),
      }),
    ),
    warnings: z.array(warning).optional(),
    deadline: selectedDeadlineSchema.optional(),
  }),
  context: z.strictObject({
    consistency_mode: z.literal("live_worktree").optional(),
    workspace: text.optional(),
    project_name: text.optional(),
    instructions: text.optional(),
    caller_context: z.json().optional(),
    request: z.record(text, z.unknown()).optional(),
    review_scope: z
      .strictObject({
        mode: z.enum(["changes", "full"]),
        source: z.literal("request").optional(),
        base: text.optional(),
        head: text.optional(),
        branch: text.optional(),
        paths: z.array(text).optional(),
      })
      .optional(),
    git: z.record(text, z.unknown()).optional(),
  }),
  "reviewer.attempt": z.strictObject({
    attempt: count,
    started_at: z.iso.datetime({ offset: true }),
    elapsed_ms: count,
    failure,
    causes: z.array(v9IncompleteReasonSchema).optional(),
  }),
  "reviewer.activity": z.strictObject({
    reviewer_id: id,
    phase,
    at: count,
    message: text.max(1000).optional(),
    material: material.optional(),
    meaningful_progress: z.boolean(),
  }),
  "reviewer.activity_summary": z.strictObject({
    reviewer_id: id,
    first_at: count,
    last_at: count,
    last_progress_at: count,
    suppressed_count: count,
    overflow: z.boolean(),
    identity_overflow: z.boolean(),
    material_counts: z.partialRecord(material, count),
    phases: z
      .array(
        z.strictObject({
          phase,
          first_at: count,
          last_at: count,
          events: count,
        }),
      )
      .max(10),
  }),
  "reviewer.coverage": z.strictObject({
    index: count,
    entries: z.array(coverageEntry).max(256),
  }),
  "reviewer.result_page": z
    .strictObject({
      index: count,
      raw: text.refine((value) => Buffer.byteLength(value, "utf8") <= 32768),
      sha256: digest,
    })
    .superRefine((value, ctx) => {
      if (
        createHash("sha256").update(value.raw, "utf8").digest("hex") !==
        value.sha256
      )
        ctx.addIssue({ code: "custom", message: "page digest mismatch" });
      try {
        const page = resultPageSchema.parse(JSON.parse(value.raw));
        if (page.page_index !== value.index)
          ctx.addIssue({ code: "custom", message: "page index mismatch" });
      } catch {
        ctx.addIssue({ code: "custom", message: "invalid result page" });
      }
    }),
  "reviewer.terminal": z.strictObject({
    status: z.enum(["completed", "incomplete", "skipped"]),
    lens_id: id,
    mode: z.enum(["full_review", "adjudication"]).optional(),
    reason: text.optional(),
    finding_proofs: z.record(text, proof).optional(),
    missing_inputs: z
      .array(
        z.strictObject({
          selector: text,
          code: z.enum(["missing_required_input", "invalid_required_input"]),
        }),
      )
      .optional(),
  }),
};
