import { z } from "zod";
import { createHash } from "node:crypto";
import {
  pullRequestV3Schema,
  reviewRequestV3Schema,
  resultPageSchema,
  selectedDeadlineSchema,
  v9IncompleteReasonSchema,
  v9FindingSeveritySchema,
  v9FindingConfidenceSchema,
} from "../protocol/v9.js";
import { runFindingsPayloadSchema } from "./artifact-record-schemas.js";

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
export const failureDiagnosticsSchema = z.strictObject({
  failure_code: z
    .enum([
      "rate_limited",
      "provider_unavailable",
      "gateway_timeout",
      "provider_response_invalid",
      "output_truncated",
      "request_timeout",
      "transport_error",
      "response_too_large",
      "streaming_unsupported",
      "result_page_too_large",
      "structured_page_limit_exceeded",
    ])
    .optional(),
  failure_stage: z.string().min(1).max(64).optional(),
  scope: z.enum(["run_input", "adapter", "provider", "model"]).optional(),
  http_status: z.number().int().min(100).max(599).optional(),
  provider_request_id: z.string().min(1).max(256).optional(),
  retry_after_ms: z.number().int().min(0).max(60_000).optional(),
  correlation_headers: z
    .strictObject({
      "x-request-id": z.string().min(1).max(256).optional(),
      "request-id": z.string().min(1).max(256).optional(),
      "x-correlation-id": z.string().min(1).max(256).optional(),
      "trace-id": z.string().min(1).max(256).optional(),
      "cf-ray": z.string().min(1).max(256).optional(),
      traceparent: z.string().min(1).max(256).optional(),
    })
    .optional(),
  retry_blocked_by_circuit: z.boolean().optional(),
  circuit_caused_by_reviewer_id: z.string().min(1).max(256).optional(),
  finish_reason: z.string().min(1).max(128).optional(),
  content_types: z.array(z.string().min(1).max(128)).max(32).optional(),
  response_bytes: count.optional(),
  response_fingerprint: digest.optional(),
  response_structure: z
    .strictObject({
      root_type: z.string().min(1).max(128),
      top_level_keys: z.array(z.string().min(1).max(128)).max(32).optional(),
      choices_count: count.optional(),
      first_choice_type: z.string().min(1).max(128).optional(),
      first_choice_keys: z.array(z.string().min(1).max(128)).max(32).optional(),
      message_type: z.string().min(1).max(128).optional(),
      message_keys: z.array(z.string().min(1).max(128)).max(32).optional(),
    })
    .optional(),
  validation_issues: z
    .array(
      z.strictObject({
        path: z.string().max(256),
        code: z.string().min(1).max(64),
        message: z.string().min(1).max(256),
      }),
    )
    .max(12)
    .optional(),
  truncated: z.boolean().optional(),
  repair_attempted: z.boolean().optional(),
  repair_outcome: z.enum(["not_attempted", "succeeded", "failed"]).optional(),
  attempt_count: z.number().int().min(1).max(100).optional(),
  retry_outcome: z.enum(["not_attempted", "succeeded", "exhausted"]).optional(),
});
export const persistedFailureSchema = z.strictObject({
  reason: v9IncompleteReasonSchema.or(z.literal("timeout")),
  message: text.max(1000),
  retryable: z.boolean(),
  fallback_eligible: z.boolean().optional(),
  circuit_qualifying: z.boolean().optional(),
  diagnostics: failureDiagnosticsSchema.optional(),
});
export const normalizedRequestMetadataSchema = z.strictObject({
  schema_version: z.enum(["1", "2", "3"]),
  request_id: z
    .string()
    .min(1)
    .max(16 * 1024)
    .optional(),
  pull_request: pullRequestV3Schema.optional(),
});
export const capturedGitContextSchema = z.union([
  z.strictObject({ is_repository: z.literal(false) }),
  z.strictObject({
    is_repository: z.literal(true),
    root: text,
    branch: text.nullable(),
    head: text.nullable(),
    base: z
      .strictObject({
        requested: text,
        resolved: text.nullable(),
        error: text.optional(),
      })
      .optional(),
    requested_head: z
      .strictObject({
        requested: text,
        resolved: text.nullable(),
        error: text.optional(),
      })
      .optional(),
    merge_base: text.nullable(),
    status_entries: z.array(text).max(4096),
    changed_files: z.array(text).max(4096),
    changed_paths: z
      .array(
        z.strictObject({
          path: text,
          kind: z.enum(["tracked", "deleted", "untracked"]),
        }),
      )
      .max(4096)
      .optional(),
    diff_stat: text,
    diff: text,
    raw_diff: z.strictObject({ byte_count: count, sha256: digest }).optional(),
    shallow: z.boolean().optional(),
    truncated: z.strictObject({
      status_entries: z.boolean(),
      changed_files: z.boolean(),
      diff_stat: z.boolean(),
      diff: z.boolean(),
    }),
  }),
]);
export const artifactResolutionPolicySchema = z.strictObject({
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
  passQuorum: z.number().int().positive(),
  minimumProviderGroups: z.number().int().positive(),
  allowZeroOutageTolerance: z.boolean().optional(),
  adjudication: z.enum(["off", "required"]),
  gateMinimumSeverity: v9FindingSeveritySchema,
  gateMinimumConfidence: v9FindingConfidenceSchema,
  mode: z.enum(["full_review", "adjudication"]).optional(),
  adjudicatesReviewerId: id.optional(),
  candidateFindings: z.json().optional(),
});
export const artifactResolutionExecutionSchema = z.strictObject({
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

export const artifactResolutionSchema = z.strictObject({
  execution: artifactResolutionExecutionSchema.optional(),
  reviewers: z.array(
    z.strictObject({
      id,
      agent_id: id.optional(),
      adapter: text.optional(),
      model: text.optional(),
      effort: text.optional(),
      provider_group: text.optional(),
      purpose: text.optional(),
      model_index: count.optional(),
      configured_model_index: count.optional(),
      model_count: count.optional(),
      isolation: text.optional(),
      timeout_ms: count.optional(),
      policy: artifactResolutionPolicySchema.optional(),
    }),
  ),
  warnings: z.array(warning).optional(),
  deadline: selectedDeadlineSchema.optional(),
});

export const artifactResolutionV1Schema = artifactResolutionSchema.extend({
  reviewers: z.array(
    z.strictObject({
      id,
      agent_id: id.optional(),
      policy: artifactResolutionPolicySchema.optional(),
    }),
  ),
});

export const privatePayloadSchemas: Record<string, z.ZodType> = {
  request: reviewRequestV3Schema,
  resolution: artifactResolutionSchema,
  context: z.strictObject({
    consistency_mode: z.literal("live_worktree").optional(),
    workspace: text.optional(),
    project_name: text.optional(),
    instructions: text.optional(),
    caller_context: z.json().optional(),
    request: normalizedRequestMetadataSchema.optional(),
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
    git: capturedGitContextSchema.optional(),
  }),
  "reviewer.attempt": z.strictObject({
    attempt: count,
    started_at: z.iso.datetime({ offset: true }),
    elapsed_ms: count,
    failure: persistedFailureSchema,
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
      serialization_boundary: z
        .enum(["provider_raw", "sdk_canonical_json"])
        .optional(),
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
  "run.findings": runFindingsPayloadSchema,
};
