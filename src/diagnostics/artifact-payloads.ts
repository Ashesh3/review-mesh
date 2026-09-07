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
  deliveryFailureSchema,
  snapshotWorkloadSchema,
  actionableFindingV4Schema,
  nativeFindingEvidenceSchema,
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
export const runSnapshotIdentitySchema = z.strictObject({
  schema_version: z.literal("1"),
  sha256: digest,
  file_count: count,
  complete: z.boolean(),
});
export const artifactCoverageV1Schema = z.strictObject({
  index: count,
  entries: z.array(coverageEntry).max(256),
});
export const artifactCoverageV2Schema = artifactCoverageV1Schema.extend({
  snapshot_identity: runSnapshotIdentitySchema.optional(),
});
export const snapshotFileSchema = z.strictObject({
  path: z.string().min(1).max(1024),
  byte_count: count,
  sha256: digest,
});
export const snapshotManifestChunkSchema = z.strictObject({
  index: count,
  chunk_count: z.number().int().min(1).max(128),
  identity: runSnapshotIdentitySchema,
  files: z.array(snapshotFileSchema).max(256),
});
export const artifactCoverageV3Schema = z
  .strictObject({
    index: count,
    entries: z
      .array(
        coverageEntry.extend({
          kind: z.enum(["tracked", "deleted", "untracked", "supporting"]),
        }),
      )
      .max(256),
    snapshot_ref: digest.optional(),
    snapshot_identity: runSnapshotIdentitySchema.optional(),
  })
  .refine((value) => !(value.snapshot_ref && value.snapshot_identity), {
    message:
      "Coverage must reference a manifest or contain a legacy identity, not both.",
  });
const proof = z.strictObject({
  review_basis: z.literal("model").optional(),
  native_evidence: nativeFindingEvidenceSchema.optional(),
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
      "inspection_budget_exhausted",
      "inspection_acquisition_failed",
      "unexpected_adapter_exception",
      "context_length_exceeded",
    ])
    .optional(),
  failure_stage: z.string().min(1).max(64).optional(),
  exception_name: text.max(64).optional(),
  exception_message: text.max(512).optional(),
  stack_fingerprint: digest.optional(),
  last_operation: text.max(64).optional(),
  context_error_class: z.literal("context_too_large").optional(),
  input_tokens: count.optional(),
  limit_tokens: count.optional(),
  budget_source: z
    .enum([
      "configured",
      "model_metadata",
      "conservative_default",
      "provider_feedback",
    ])
    .optional(),
  token_estimation: z.literal("utf8_upper_bound").optional(),
  input_budget_tokens: count.optional(),
  output_reserve_tokens: count.optional(),
  estimated_input_tokens: count.optional(),
  context_window_tokens: count.optional(),
  segment_index: count.optional(),
  prompt_tokens: count.optional(),
  completion_tokens: count.optional(),
  total_tokens: count.optional(),
  reasoning_tokens: count.optional(),
  cached_tokens: count.optional(),
  cache_creation_tokens: count.optional(),
  cache_read_tokens: count.optional(),
  request_output_tokens: count.optional(),
  output_ceiling_tokens: count.optional(),
  output_recovery_attempts: count.optional(),
  response_sequence: z.number().int().positive().optional(),
  output_cap_source: z
    .enum(["configured", "model_metadata", "default", "adaptive"])
    .optional(),
  output_recovery_action: z
    .enum(["increase_output", "split_evidence", "compact_synthesis"])
    .optional(),
  response_body_truncated: z.boolean().optional(),
  model_output_truncated: z.boolean().optional(),
  model: z.string().min(1).max(256).optional(),
  operation_phase: z.string().min(1).max(64).optional(),
  inspection_turn: count.optional(),
  maximum_inspection_turns: count.optional(),
  remaining_inspection_turns: count.optional(),
  request_bytes: count.optional(),
  provider_error_code: z.string().max(128).optional(),
  provider_error_message: z.string().max(512).optional(),
  error_body_truncated: z.boolean().optional(),
  error_body_unavailable: z.boolean().optional(),
  circuit_cause: z
    .strictObject({
      reviewer_id: id,
      attempt: count,
      reason: text.max(128),
      at: z.iso.datetime({ offset: true }),
      failure_code: text.max(128).optional(),
    })
    .optional(),
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
        expected_max_bytes: count.optional(),
        actual_bytes: count.optional(),
        unknown_keys: z.array(z.string().max(128)).max(32).optional(),
      }),
    )
    .max(12)
    .optional(),
  truncated: z.boolean().optional(),
  repair_attempted: z.boolean().optional(),
  checkpoint_id: z.string().max(256).optional(),
  artifact_ref: z.string().max(4096).optional(),
  recommended_action: z.string().max(256).optional(),
  repair_outcome: z
    .enum(["not_attempted", "pending", "succeeded", "failed"])
    .optional(),
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
      proof: z.enum(["observed", "attested", "native_attested"]),
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
  review_profile: z.enum(["strict-evaluation", "routine-review"]).optional(),
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
      config_fingerprint: digest.optional(),
    }),
  ),
  warnings: z.array(warning).optional(),
  deadline: selectedDeadlineSchema.optional(),
  retry: z
    .strictObject({
      parent_run_id: id,
      inheritance: z.enum(["exact", "rerun_all"]),
      reused_reviewer_ids: z.array(id),
      evidence: z.enum([
        "reconstructed_and_verified",
        "snapshot_identity_verified",
        "snapshot_identity_unavailable",
        "scope_or_policy_changed",
      ]),
      narrative: z.literal("sanitized_parent_context"),
    })
    .optional(),
});

export const artifactResolutionV2Schema = artifactResolutionSchema
  .omit({ retry: true })
  .extend({
    reviewers: z.array(
      artifactResolutionSchema.shape.reviewers.element.omit({
        config_fingerprint: true,
      }),
    ),
  });

export const artifactResolutionV1Schema = artifactResolutionV2Schema.extend({
  reviewers: z.array(
    z.strictObject({
      id,
      agent_id: id.optional(),
      policy: artifactResolutionPolicySchema.optional(),
    }),
  ),
});

export const artifactAttemptV1Schema = z.strictObject({
  attempt: count,
  started_at: z.iso.datetime({ offset: true }),
  elapsed_ms: count,
  failure: persistedFailureSchema,
  causes: z.array(v9IncompleteReasonSchema).optional(),
});

const followUpKind = z.enum(["snapshot", "diff", "context"]);
const followUpRequest = z.strictObject({
  question_id: id.optional(),
  purpose: text.max(512).optional(),
  kind: followUpKind.optional(),
  path: text.max(1024).optional(),
  offset: count,
  byte_count: z.number().int().min(1).max(32768),
});
const followUpResult = z.strictObject({
  already_delivered: z.boolean().optional(),
  prior_delivery: z.enum(["complete", "partial", "none"]).optional(),
  request: followUpRequest,
  status: z.enum(["queued", "rejected"]),
  kind: followUpKind.optional(),
  path: text.max(1024).optional(),
  offset: count.optional(),
  byte_count: count.optional(),
  reason: z
    .enum([
      "invalid_path",
      "not_in_snapshot",
      "invalid_range",
      "kind_path_mismatch",
    ])
    .optional(),
  retryable: z.boolean().optional(),
  error_id: id.optional(),
});

export const privatePayloadSchemas: Record<string, z.ZodType> = {
  "reviewer.native_execution": z.strictObject({
    contract: z.literal("native_review_v1"),
    harness: z.enum(["codex", "claude", "copilot"]),
    model: text.min(1).max(256),
    sdk_version: text.min(1).max(128),
    runtime_version: text.min(1).max(128).optional(),
    execution_mode: z.literal("managed_process"),
    consistency_mode: z.literal("live_worktree"),
    coverage_basis: z.enum([
      "agent_selected",
      "model_attested",
      "native_observed",
      "unknown",
    ]),
    sdk_completed: z.boolean(),
    execution_fingerprint: digest.optional(),
    scope_digest: digest.optional(),
    observed_paths: z.array(text.max(4096)).max(10_000).optional(),
  }),
  "run.native_consistency": z.strictObject({
    contract: z.literal("native_review_v1"),
    consistency_mode: z.literal("live_worktree"),
    initial: z.strictObject({
      sha256: digest,
      file_count: count,
      complete: z.boolean(),
    }),
    final: z.strictObject({
      sha256: digest,
      file_count: count,
      complete: z.boolean(),
    }),
    changed: z.boolean(),
  }),
  "reviewer.response": z.strictObject({
    attempt: count,
    diagnostics: failureDiagnosticsSchema,
  }),
  "reviewer.exception": z.strictObject({
    attempt: count,
    diagnostics: failureDiagnosticsSchema,
  }),
  "reviewer.segment": z
    .strictObject({
      attempt: count,
      segment_id: id,
      index: count,
      phase: z.enum(["evidence", "synthesis"]),
      data: z.strictObject({
        provenance: z.literal("model_reasoning"),
        runtime_validation: z.literal("not_executed"),
        summary: text.max(512),
        findings: z.array(actionableFindingV4Schema).max(16),
        unresolved_questions: z
          .array(z.strictObject({ id: id, question: text.max(1024) }))
          .max(32),
        scenario_checks: z
          .array(
            z
              .strictObject({
                path: text.max(1024),
                start_line: count,
                end_line: count,
                input: z.json(),
                expected: z.json(),
                observed: z.json(),
                reasoning: text.min(1).max(1024),
                finding_id: text.max(256).optional(),
              })
              .refine(
                (value) =>
                  value.start_line > 0 && value.end_line >= value.start_line,
              ),
          )
          .min(1)
          .max(8),
        source_ranges: z
          .array(
            z.strictObject({
              kind: z.enum(["snapshot", "diff", "context"]),
              path: text.max(1024),
              offset: count,
              byte_count: count,
              sha256: digest,
              snapshot_digest: digest.optional(),
            }),
          )
          .max(8),
        budget: failureDiagnosticsSchema,
        follow_up_reads: z.array(followUpRequest).max(8).optional(),
        follow_up_results: z.array(followUpResult).max(8).optional(),
        resolved_question_ids: z.array(id).max(32).optional(),
      }),
    })
    .refine((value) => Buffer.byteLength(JSON.stringify(value)) <= 512 * 1024),
  "reviewer.preflight": snapshotWorkloadSchema.extend({
    lens_id: id,
    model_runs: count,
    required_passes: count,
    required_provider_groups: count,
    run_deadline_remaining_ms: count,
    estimated_minimum_tool_turns: count,
    limits_are_estimates: z.literal(true),
    warnings: z.array(text.max(128)).max(8),
  }),
  "run.error": deliveryFailureSchema.extend({
    reason: z.literal("output_failed"),
    scope: z.literal("public_delivery"),
    cancellation_initiator: z.literal("none"),
  }),
  "reviewer.draft": z
    .strictObject({
      diagnostics: failureDiagnosticsSchema.optional(),
      candidate_mutations: z
        .array(
          z.strictObject({
            candidate_id: text.max(256),
            original_sha256: digest,
            returned_sha256: digest,
            changed_fields: z.array(text.max(128)).max(32),
          }),
        )
        .max(16)
        .optional(),
      result_kind: z.enum(["reviewer", "adjudication"]).optional(),
      assigned_candidate_ids: z.array(text.max(256)).max(256).optional(),
      accepted_decision_ids: z.array(text.max(256)).max(256).optional(),
      missing_decision_ids: z.array(text.max(256)).max(256).optional(),
      decision: z.record(z.string(), z.unknown()).optional(),
      kind: z.literal("unverified_result_draft"),
      checkpoint_id: text.max(256),
      attempt: count,
      verified: z.literal(false),
      page_index: count.optional(),
      accepted_page_count: count,
      candidate_ids: z.array(text.max(256)).max(256),
      unresolved_obligations: z.array(text.max(1000)).max(256),
      candidate: z.record(z.string(), z.unknown()).optional(),
      validation_issues: failureDiagnosticsSchema.shape.validation_issues,
      raw_excerpt: text.max(4096).optional(),
    })
    .refine(
      (value) => Buffer.byteLength(JSON.stringify(value), "utf8") <= 256 * 1024,
    ),
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
    failure: persistedFailureSchema.optional(),
    ended_at: z.iso.datetime({ offset: true }).optional(),
    admitted_at: z.iso.datetime({ offset: true }).optional(),
    queued_at: z.iso.datetime({ offset: true }).optional(),
    probe_started_at: z.iso.datetime({ offset: true }).optional(),
    probe_elapsed_ms: count.optional(),
    queue_wait_ms: count.optional(),
    execution_elapsed_ms: count.optional(),
    expired_boundary: v9IncompleteReasonSchema.optional(),
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
  "reviewer.coverage": artifactCoverageV3Schema,
  "run.snapshot_manifest": snapshotManifestChunkSchema,
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
    failure_stage: phase.optional(),
    expired_boundary: v9IncompleteReasonSchema.optional(),
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

export const artifactTerminalV1Schema = z.strictObject({
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
});
