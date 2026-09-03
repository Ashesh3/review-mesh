import { z } from "zod";

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export const protocolVersionSchema = z.enum(["1", "2"]);
export const publicEventVersionSchema = z.enum(["4", "5"]);
export const reviewOutputModeSchema = z.enum(["full-jsonl", "compact-jsonl"]);
export const runStatusSchema = z.enum(["passed", "findings", "incomplete"]);
export const gateOutcomeSchema = z.enum(["no_findings", "findings"]);
export const coverageOutcomeSchema = z.enum(["complete", "partial"]);
export const isolationPolicySchema = z.enum([
  "prefer_enforced",
  "require_enforced",
]);
export const isolationLevelSchema = z.enum([
  "enforced_read_only",
  "runtime_read_only",
  "prompt_only",
]);
export const incompleteReasonSchema = z.enum([
  "adapter_unavailable",
  "authentication_failed",
  "model_unavailable",
  "read_failure",
  "timeout",
  "process_crashed",
  "protocol_violation",
  "invalid_result",
  "result_too_large",
  "persistence_failed",
  "cancelled",
  "unknown",
]);
export const findingSeveritySchema = z.enum([
  "critical",
  "high",
  "medium",
  "low",
]);
export const findingConfidenceSchema = z.enum(["high", "medium", "low"]);
export const findingClassificationSchema = z.enum([
  "confirmed_defect",
  "needs_verification",
  "advisory",
]);
export const findingCategorySchema = z.enum([
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
export const reviewerModeSchema = z.enum(["full_review", "adjudication"]);
export const reviewerSkipReasonSchema = z.enum([
  "prior_findings",
  "prior_incomplete",
  "short_circuited_after_finding",
  "not_needed_after_quorum",
  "not_selected_for_retry",
  "not_applicable",
  "not_evaluated_missing_input",
  "blocked_by_infrastructure_failure",
  "circuit_open",
]);

const nonEmptyString = z
  .string()
  .min(1)
  .max(16 * 1_024);
const findingText = z
  .string()
  .min(1)
  .max(8 * 1_024);
const completeResultText = z.string().min(1);
const nonNegativeInteger = z.number().int().nonnegative();
const positiveInteger = z.number().int().positive();
const boundedMessage = z.string().min(1).max(1_000);
const timestampSchema = z.iso.datetime({ offset: true });
const consistencyModeSchema = z.literal("live_worktree");
const reasoningEffortSchema = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "persistent",
]);

const projectNameSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(
    /^(?!\.{1,2}$)(?!\s)(?!.*\s$)[^\u0000-\u001f/\\]+$/u,
    "project name must be trimmed and contain no path separators or control characters",
  );
const gitRefSchema = nonEmptyString
  .max(1_024)
  .refine(
    (value) => !value.startsWith("-") && !/[\u0000-\u001f]/u.test(value),
    "Git refs must not start with '-' or contain control characters",
  );
const reviewPathSchema = nonEmptyString
  .max(4_096)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.startsWith(":") &&
      !/^[A-Za-z]:/u.test(value) &&
      !value.includes("\\") &&
      !/[*?[\]]/u.test(value) &&
      !value.split("/").includes("..") &&
      !/[\u0000-\u001f]/u.test(value),
    "review paths must be literal forward-slash workspace-relative paths without '..' or pathspec magic",
  );
const reviewPathsSchema = z.array(reviewPathSchema).min(1).optional();

export const reviewScopeSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("changes"),
    base: gitRefSchema.optional(),
    head: gitRefSchema.optional(),
    branch: gitRefSchema.optional(),
    paths: reviewPathsSchema,
  }),
  z.strictObject({ mode: z.literal("full"), paths: reviewPathsSchema }),
]);

export const reviewRequestV2Schema = z.strictObject({
  schema_version: z.literal("2"),
  request_id: nonEmptyString.optional(),
  project_name: projectNameSchema,
  workspace: nonEmptyString,
  instructions: nonEmptyString,
  review_scope: reviewScopeSchema,
  context: z.json().optional(),
});
export const reviewRequestSchema = reviewRequestV2Schema;

export const findingEvidenceSchema = z
  .strictObject({
    path: nonEmptyString.optional(),
    start_line: positiveInteger.optional(),
    end_line: positiveInteger.optional(),
    detail: findingText,
  })
  .superRefine((value, ctx) => {
    const hasStart = value.start_line !== undefined;
    const hasEnd = value.end_line !== undefined;
    if ((hasStart || hasEnd) && value.path === undefined) {
      ctx.addIssue({ code: "custom", message: "line ranges require a path" });
    }
    if (hasStart !== hasEnd) {
      ctx.addIssue({
        code: "custom",
        message: "line ranges require both start_line and end_line",
      });
    }
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

const actionableFindingBase = {
  id: nonEmptyString,
  severity: findingSeveritySchema,
  title: findingText,
  description: findingText,
  evidence: z.array(findingEvidenceSchema).min(1).max(256),
  suggested_direction: findingText,
};
export const actionableFindingV1Schema = z.strictObject(actionableFindingBase);
export const actionableFindingV2Schema = z.strictObject({
  ...actionableFindingBase,
  confidence: findingConfidenceSchema,
  classification: findingClassificationSchema,
  external_assumptions: z.array(findingText).max(128),
  root_issue_id: nonEmptyString.optional(),
  duplicate_of: nonEmptyString.optional(),
  duplicate_finding_ids: z.array(nonEmptyString).optional(),
});
const findingEvidenceV3Schema = z
  .strictObject({
    path: nonEmptyString.optional(),
    start_line: positiveInteger.optional(),
    end_line: positiveInteger.optional(),
    detail: completeResultText,
  })
  .superRefine((value, ctx) => {
    const hasStart = value.start_line !== undefined;
    const hasEnd = value.end_line !== undefined;
    if ((hasStart || hasEnd) && value.path === undefined) {
      ctx.addIssue({ code: "custom", message: "line ranges require a path" });
    }
    if (hasStart !== hasEnd) {
      ctx.addIssue({
        code: "custom",
        message: "line ranges require both start_line and end_line",
      });
    }
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
export const actionableFindingV3Schema = z.strictObject({
  id: nonEmptyString,
  severity: findingSeveritySchema,
  title: completeResultText,
  description: completeResultText,
  evidence: z.array(findingEvidenceV3Schema).min(1).max(256),
  suggested_direction: completeResultText,
  confidence: findingConfidenceSchema,
  classification: findingClassificationSchema,
  external_assumptions: z.array(completeResultText).max(128),
  root_issue_id: nonEmptyString.optional(),
  duplicate_of: nonEmptyString.optional(),
  duplicate_finding_ids: z.array(nonEmptyString).optional(),
  category: findingCategorySchema,
  verification: completeResultText,
  change_impact: completeResultText.optional(),
});
const informationalNoteSchema = z.strictObject({
  title: nonEmptyString,
  description: nonEmptyString,
});
const informationalNoteV3Schema = z.strictObject({
  title: completeResultText,
  description: completeResultText,
});
function validateVerdict(
  value: { verdict: "pass" | "fail"; actionable_findings: unknown[] },
  ctx: z.RefinementCtx,
): void {
  if (value.verdict === "pass" && value.actionable_findings.length !== 0) {
    ctx.addIssue({
      code: "custom",
      message: "pass requires an empty actionable_findings array",
    });
  }
  if (value.verdict === "fail" && value.actionable_findings.length === 0) {
    ctx.addIssue({
      code: "custom",
      message: "fail requires at least one actionable finding",
    });
  }
}
export const reviewerResultV1Schema = z
  .strictObject({
    schema_version: z.literal("1"),
    verdict: z.enum(["pass", "fail"]),
    summary: findingText,
    actionable_findings: z.array(actionableFindingV1Schema).max(256),
    informational_notes: z.array(informationalNoteSchema).max(256),
  })
  .superRefine(validateVerdict);
export const reviewerResultV2Schema = z
  .strictObject({
    schema_version: z.literal("2"),
    verdict: z.enum(["pass", "fail"]),
    summary: findingText,
    actionable_findings: z.array(actionableFindingV2Schema).max(256),
    informational_notes: z.array(informationalNoteSchema).max(256),
  })
  .superRefine(validateVerdict);
export const reviewerResultV3Schema = z
  .strictObject({
    schema_version: z.literal("3"),
    verdict: z.enum(["pass", "fail"]),
    review_markdown: completeResultText,
    summary: completeResultText,
    actionable_findings: z.array(actionableFindingV3Schema).max(256),
    informational_notes: z.array(informationalNoteV3Schema).max(256),
  })
  .superRefine(validateVerdict);
export const reviewerResultSchema = z.union([
  reviewerResultV3Schema,
  reviewerResultV2Schema,
  reviewerResultV1Schema,
]);

export const reviewerPhaseSchema = z.enum([
  "queued",
  "probing",
  "starting",
  "reviewing",
  "validating",
  "terminal",
]);
export const adapterFailureDiagnosticsSchema = z.strictObject({
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
    ])
    .optional(),
  failure_stage: z.string().min(1).max(64).optional(),
  scope: z.enum(["run_input", "adapter", "provider", "model"]).optional(),
  http_status: z.number().int().min(100).max(599).optional(),
  provider_request_id: nonEmptyString.max(256).optional(),
  retry_after_ms: nonNegativeInteger.optional(),
  correlation_headers: z
    .strictObject({
      "x-request-id": nonEmptyString.max(256).optional(),
      "request-id": nonEmptyString.max(256).optional(),
      "x-correlation-id": nonEmptyString.max(256).optional(),
      "trace-id": nonEmptyString.max(256).optional(),
      "cf-ray": nonEmptyString.max(256).optional(),
      traceparent: nonEmptyString.max(256).optional(),
    })
    .optional(),
  retry_blocked_by_circuit: z.boolean().optional(),
  circuit_caused_by_reviewer_id: nonEmptyString.max(256).optional(),
  finish_reason: nonEmptyString.max(128).optional(),
  content_types: z.array(nonEmptyString.max(128)).max(32).optional(),
  response_bytes: nonNegativeInteger.optional(),
  response_fingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  response_structure: z
    .strictObject({
      root_type: nonEmptyString.max(128),
      top_level_keys: z.array(nonEmptyString.max(128)).max(32).optional(),
      choices_count: nonNegativeInteger.optional(),
      first_choice_type: nonEmptyString.max(128).optional(),
      first_choice_keys: z.array(nonEmptyString.max(128)).max(32).optional(),
      message_type: nonEmptyString.max(128).optional(),
      message_keys: z.array(nonEmptyString.max(128)).max(32).optional(),
    })
    .optional(),
  validation_issues: z
    .array(
      z.strictObject({
        path: z.string().max(256),
        code: nonEmptyString.max(64),
        message: nonEmptyString.max(256),
      }),
    )
    .max(12)
    .optional(),
  truncated: z.boolean().optional(),
  repair_attempted: z.boolean().optional(),
  repair_outcome: z.enum(["not_attempted", "succeeded", "failed"]).optional(),
});
export const reviewerTerminalRecordSchema = z.discriminatedUnion("status", [
  z.strictObject({
    reviewer_id: nonEmptyString,
    lens_id: nonEmptyString.optional(),
    status: z.literal("completed"),
    mode: reviewerModeSchema.optional(),
    adapter: nonEmptyString,
    model: nonEmptyString,
    provider_group: nonEmptyString.optional(),
    isolation: isolationLevelSchema,
    elapsed_ms: nonNegativeInteger,
    result: reviewerResultSchema,
  }),
  z.strictObject({
    reviewer_id: nonEmptyString,
    lens_id: nonEmptyString.optional(),
    status: z.literal("incomplete"),
    mode: reviewerModeSchema.optional(),
    adapter: nonEmptyString,
    model: nonEmptyString,
    provider_group: nonEmptyString.optional(),
    isolation: isolationLevelSchema.optional(),
    elapsed_ms: nonNegativeInteger,
    reason: incompleteReasonSchema,
    message: boundedMessage,
    retryable: z.boolean(),
    fallback_eligible: z.boolean().optional(),
    circuit_qualifying: z.boolean().optional(),
    diagnostics: adapterFailureDiagnosticsSchema.optional(),
  }),
  z.strictObject({
    reviewer_id: nonEmptyString,
    lens_id: nonEmptyString.optional(),
    status: z.literal("skipped"),
    mode: reviewerModeSchema.optional(),
    adapter: nonEmptyString,
    model: nonEmptyString,
    provider_group: nonEmptyString.optional(),
    elapsed_ms: nonNegativeInteger,
    reason: reviewerSkipReasonSchema,
    blocked_by_reviewer_id: nonEmptyString.optional(),
    missing_inputs: z.array(nonEmptyString).optional(),
  }),
]);

export const modelRunCountsSchema = z.strictObject({
  total: nonNegativeInteger,
  deferred: nonNegativeInteger,
  queued: nonNegativeInteger,
  running: nonNegativeInteger,
  completed: nonNegativeInteger,
  incomplete: nonNegativeInteger,
  skipped: nonNegativeInteger,
  skip_reasons: z
    .partialRecord(reviewerSkipReasonSchema, nonNegativeInteger)
    .optional(),
});
export const logicalLensCountsSchema = z.strictObject({
  total: nonNegativeInteger,
  pending: nonNegativeInteger,
  findings: nonNegativeInteger,
  passed: nonNegativeInteger,
  incomplete: nonNegativeInteger,
  not_applicable: nonNegativeInteger,
  not_evaluated: nonNegativeInteger,
  not_selected: nonNegativeInteger.optional(),
});

const eventEnvelopeSchema = z.strictObject({
  schema_version: publicEventVersionSchema,
  event: z.string(),
  run_id: nonEmptyString,
  request_id: nonEmptyString.optional(),
  seq: positiveInteger,
  timestamp: timestampSchema,
  reviewer_id: nonEmptyString.optional(),
  data: z.unknown(),
});
const suiteSelectionSchema = z.strictObject({
  source: z.enum(["legacy", "defaults", "project"]),
  project_name: nonEmptyString.optional(),
  project_name_source: z
    .enum(["git_remote", "git_common_directory", "git_root", "workspace"])
    .optional(),
  matched_project_name: nonEmptyString.optional(),
});
const executionSchema = z.strictObject({
  max_concurrency: positiveInteger,
  heartbeat_interval_ms: positiveInteger,
  shutdown_grace_period_ms: positiveInteger,
  distribute_primaries: z.boolean().optional(),
  default_provider_concurrency: positiveInteger.optional(),
  provider_limits: z.record(nonEmptyString, positiveInteger).optional(),
  circuit_breaker_threshold: positiveInteger.optional(),
  circuit_breaker_cooldown_ms: positiveInteger.optional(),
  retry_attempts: positiveInteger.optional(),
  retry_backoff_ms: nonNegativeInteger.optional(),
});

const publicEventSchemas = [
  eventEnvelopeSchema.extend({
    event: z.literal("run.started"),
    data: z.strictObject({
      consistency_mode: consistencyModeSchema,
      parent_run_id: nonEmptyString.optional(),
    }),
  }),
  eventEnvelopeSchema.extend({
    event: z.literal("context.resolved"),
    data: z.strictObject({
      workspace: nonEmptyString,
      project_name: nonEmptyString,
      review_scope: z.strictObject({
        mode: z.enum(["changes", "full"]),
        paths: z.array(nonEmptyString).optional(),
      }),
      git: z.strictObject({
        is_repository: z.boolean(),
        branch: z.string().nullable().optional(),
        head: z.string().nullable().optional(),
        merge_base: z.string().nullable().optional(),
        changed_files_count: nonNegativeInteger,
        changed_files: z.array(nonEmptyString).max(25),
        diff_stat: z
          .string()
          .max(4 * 1_024)
          .optional(),
        truncated: z.boolean(),
      }),
      detail_ref: nonEmptyString.optional(),
    }),
  }),
  eventEnvelopeSchema.extend({
    event: z.literal("suite.resolved"),
    data: z.strictObject({
      logical_lenses: nonNegativeInteger.optional(),
      model_runs: nonNegativeInteger.optional(),
      execution: executionSchema,
      selection: suiteSelectionSchema.optional(),
      lenses: z
        .array(
          z.strictObject({
            id: nonEmptyString,
            purpose: nonEmptyString,
            model_runs: positiveInteger,
            pass_quorum: positiveInteger,
            minimum_provider_groups: positiveInteger,
            adjudication: z.enum(["off", "required"]),
          }),
        )
        .optional(),
    }),
  }),
  eventEnvelopeSchema.extend({
    event: z.literal("reviewer.started"),
    data: z.strictObject({
      lens_id: nonEmptyString.optional(),
      mode: reviewerModeSchema.optional(),
      attempt: positiveInteger.optional(),
      maximum_attempts: positiveInteger.optional(),
      purpose: nonEmptyString,
      adapter: nonEmptyString,
      model: nonEmptyString,
      provider_group: nonEmptyString.optional(),
      effort: reasoningEffortSchema.optional(),
      isolation_policy: isolationPolicySchema,
      attempt_timeout_ms: positiveInteger.optional(),
      lens_deadline_remaining_ms: nonNegativeInteger.optional(),
      timeout_ms: positiveInteger.optional(),
    }),
  }),
  eventEnvelopeSchema.extend({
    event: z.literal("reviewer.progress"),
    data: z.strictObject({
      lens_id: nonEmptyString.optional(),
      mode: reviewerModeSchema.optional(),
      phase: reviewerPhaseSchema,
      message: boundedMessage.optional(),
    }),
  }),
  eventEnvelopeSchema.extend({
    event: z.literal("suite.heartbeat"),
    data: z.strictObject({
      elapsed_ms: nonNegativeInteger,
      logical_lenses: logicalLensCountsSchema,
      model_runs: modelRunCountsSchema,
      active: z.array(
        z.strictObject({
          reviewer_id: nonEmptyString,
          lens_id: nonEmptyString,
          mode: reviewerModeSchema,
          phase: reviewerPhaseSchema,
          elapsed_ms: nonNegativeInteger,
          stale_ms: nonNegativeInteger,
          deadline_remaining_ms: nonNegativeInteger,
          last_activity_message: boundedMessage.optional(),
        }),
      ),
    }),
  }),
  eventEnvelopeSchema.extend({
    event: z.literal("reviewer.heartbeat"),
    data: z.strictObject({
      phase: reviewerPhaseSchema,
      elapsed_ms: nonNegativeInteger,
      last_activity_at: timestampSchema.optional(),
      last_activity_message: boundedMessage.optional(),
      suite: z.strictObject({
        total: nonNegativeInteger,
        deferred: nonNegativeInteger,
        queued: nonNegativeInteger,
        running: nonNegativeInteger,
        completed: nonNegativeInteger,
        incomplete: nonNegativeInteger,
        skipped: nonNegativeInteger,
      }),
      isolation: isolationLevelSchema.optional(),
    }),
  }),
  eventEnvelopeSchema.extend({
    event: z.literal("reviewer.completed"),
    data: z.strictObject({
      lens_id: nonEmptyString.optional(),
      mode: reviewerModeSchema.optional(),
      adapter: nonEmptyString,
      model: nonEmptyString,
      provider_group: nonEmptyString.optional(),
      isolation: isolationLevelSchema,
      elapsed_ms: nonNegativeInteger,
      verdict: z.enum(["pass", "fail"]).optional(),
      summary: boundedMessage.optional(),
      actionable_findings: nonNegativeInteger.optional(),
      gate_findings: nonNegativeInteger.optional(),
      informational_notes: nonNegativeInteger.optional(),
      detail_ref: nonEmptyString.optional(),
      result: reviewerResultSchema.optional(),
    }),
  }),
  eventEnvelopeSchema.extend({
    event: z.literal("reviewer.result"),
    data: z.strictObject({
      lens_id: nonEmptyString.optional(),
      mode: reviewerModeSchema.optional(),
      digest: z.string().regex(/^[a-f0-9]{64}$/u),
      byte_count: nonNegativeInteger,
      artifact_path: nonEmptyString.optional(),
      result: reviewerResultV3Schema,
    }),
  }),
  eventEnvelopeSchema.extend({
    event: z.literal("reviewer.incomplete"),
    data: z.strictObject({
      lens_id: nonEmptyString,
      mode: reviewerModeSchema,
      adapter: nonEmptyString,
      model: nonEmptyString,
      provider_group: nonEmptyString,
      isolation: isolationLevelSchema.optional(),
      elapsed_ms: nonNegativeInteger,
      reason: incompleteReasonSchema,
      message: boundedMessage,
      retryable: z.boolean(),
      fallback_eligible: z.boolean(),
      circuit_qualifying: z.boolean().optional(),
      diagnostics: adapterFailureDiagnosticsSchema.optional(),
      attempt_count: positiveInteger,
    }),
  }),
  eventEnvelopeSchema.extend({
    event: z.literal("reviewer.skipped"),
    data: z.strictObject({
      lens_id: nonEmptyString,
      mode: reviewerModeSchema,
      adapter: nonEmptyString,
      model: nonEmptyString,
      provider_group: nonEmptyString,
      elapsed_ms: nonNegativeInteger,
      reason: reviewerSkipReasonSchema,
      blocked_by_reviewer_id: nonEmptyString.optional(),
      missing_inputs: z.array(nonEmptyString).optional(),
    }),
  }),
  eventEnvelopeSchema.extend({
    event: z.literal("run.completed"),
    data: z
      .strictObject({
        gate_outcome: gateOutcomeSchema.optional(),
        coverage_outcome: coverageOutcomeSchema.optional(),
        exit_code: nonNegativeInteger,
        consistency_mode: consistencyModeSchema,
        total_elapsed_ms: nonNegativeInteger,
        logical_lenses: logicalLensCountsSchema.optional(),
        model_runs: modelRunCountsSchema.optional(),
        unique_findings: nonNegativeInteger.optional(),
        advisory_findings: nonNegativeInteger.optional(),
        incomplete_lenses: z.array(nonEmptyString).optional(),
        not_evaluated_lenses: z.array(nonEmptyString).optional(),
        report_path: nonEmptyString.optional(),
        result_manifest: z
          .array(
            z.strictObject({
              reviewer_id: nonEmptyString,
              lens_id: nonEmptyString.optional(),
              digest: z.string().regex(/^[a-f0-9]{64}$/u),
              byte_count: nonNegativeInteger,
              artifact_path: nonEmptyString.optional(),
            }),
          )
          .optional(),
        results_complete: z.boolean().optional(),
        status: runStatusSchema.optional(),
        suite: modelRunCountsSchema,
        reviewers: z.array(reviewerTerminalRecordSchema).optional(),
      })
      .superRefine((value, ctx) => {
        if (
          value.status === undefined ||
          value.gate_outcome !== undefined ||
          value.coverage_outcome !== undefined ||
          value.reviewers === undefined
        )
          return;
        const reviewers = value.reviewers;
        if (reviewers === undefined) return;
        const hasIncomplete = reviewers.some(
          (reviewer) => reviewer.status === "incomplete",
        );
        const hasFindings = reviewers.some(
          (reviewer) =>
            reviewer.status === "completed" &&
            reviewer.result.actionable_findings.length > 0,
        );
        const expected = hasIncomplete
          ? "incomplete"
          : hasFindings
            ? "findings"
            : "passed";
        if (value.status !== expected) {
          ctx.addIssue({
            code: "custom",
            message: `run.completed status must be ${expected}`,
          });
        }
      }),
  }),
] as const;
export const publicEventSchema = z.discriminatedUnion(
  "event",
  publicEventSchemas,
);

export type ReviewRequest = z.infer<typeof reviewRequestSchema>;
export type ReviewerResult = z.infer<typeof reviewerResultSchema>;
export type ReviewerResultV1 = z.infer<typeof reviewerResultV1Schema>;
export type ReviewerResultV2 = z.infer<typeof reviewerResultV2Schema>;
export type ReviewerResultV3 = z.infer<typeof reviewerResultV3Schema>;
export type PublicEvent = z.infer<typeof publicEventSchema>;
export type ReviewerPhase = z.infer<typeof reviewerPhaseSchema>;
export type ReviewerTerminalRecord = z.infer<
  typeof reviewerTerminalRecordSchema
>;
export type ReviewerSkipReason = z.infer<typeof reviewerSkipReasonSchema>;
export type RunStatus = z.infer<typeof runStatusSchema>;
export type GateOutcome = z.infer<typeof gateOutcomeSchema>;
export type CoverageOutcome = z.infer<typeof coverageOutcomeSchema>;
export type IsolationPolicy = z.infer<typeof isolationPolicySchema>;
export type IsolationLevel = z.infer<typeof isolationLevelSchema>;
export type IncompleteReason = z.infer<typeof incompleteReasonSchema>;
export type FindingSeverity = z.infer<typeof findingSeveritySchema>;
export type FindingConfidence = z.infer<typeof findingConfidenceSchema>;
export type FindingClassification = z.infer<typeof findingClassificationSchema>;
export type FindingCategory = z.infer<typeof findingCategorySchema>;
export type ReviewerMode = z.infer<typeof reviewerModeSchema>;
export type ReviewOutputMode = z.infer<typeof reviewOutputModeSchema>;
