import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import {
  adapterFailureDiagnosticsSchema,
  findingEvidenceSchema,
  findingSeveritySchema,
  incompleteReasonSchema,
  isolationLevelSchema,
  isolationPolicySchema,
  publicEventSchema,
  adjudicationResultSchema,
  reviewerModeSchema,
  reviewerResultSchema,
  reviewerSkipReasonSchema,
  reviewRequestSchema,
} from "../protocol/schemas.js";
import {
  canonicalizeFindings,
  type CanonicalRawFinding,
} from "../findings/canonical.js";
import { validateAdjudication } from "../findings/adjudication.js";
import { reviewerResultDigest } from "../results/digest.js";

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const ACTIVE_SUFFIX = /^\.jsonl\.active(?:\..+)?$/u;
const MAX_REPORT_RECORD_BYTES = 64 * 1024 * 1024;
const MAX_RECORD_WARNINGS = 100;
const persistedString = z
  .string()
  .min(1)
  .max(16 * 1_024);
const persistedFindingText = z
  .string()
  .min(1)
  .max(8 * 1_024);
const nonNegativeIntegerSchema = z.number().int().nonnegative();
const positiveIntegerSchema = z.number().int().positive();
const timestampSchema = z.iso.datetime({ offset: true });
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

export const persistedReviewerResultRecordType = "reviewer.result" as const;
export const persistedReviewerTerminalRecordType = "reviewer.terminal" as const;

const legacyInformationalNoteSchema = z.strictObject({
  title: persistedString,
  description: persistedString,
});

const legacyActionableFindingSchema = z.strictObject({
  id: persistedString,
  severity: findingSeveritySchema,
  title: persistedFindingText,
  description: persistedFindingText,
  evidence: z.array(findingEvidenceSchema).min(1).max(256),
  suggested_direction: persistedFindingText,
});

/** v4 accepted schema_version=2 before the richer v2 finding shape existed. */
const legacyReviewerResultSchema = z
  .strictObject({
    schema_version: z.enum(["1", "2"]),
    verdict: z.enum(["pass", "fail"]),
    summary: persistedFindingText,
    actionable_findings: z.array(legacyActionableFindingSchema).max(256),
    informational_notes: z.array(legacyInformationalNoteSchema).max(256),
  })
  .superRefine((value, ctx) => {
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
  });

const persistedReviewerResultSchema = z.union([
  adjudicationResultSchema,
  reviewerResultSchema,
  legacyReviewerResultSchema,
]);
export type PersistedReviewerResult = z.infer<
  typeof persistedReviewerResultSchema
>;
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const legacyResultRecordFields = {
  digest: digestSchema.optional(),
  byte_count: nonNegativeIntegerSchema.optional(),
  result: persistedReviewerResultSchema,
};

const legacySuiteCountsSchema = z.strictObject({
  total: nonNegativeIntegerSchema,
  deferred: nonNegativeIntegerSchema,
  queued: nonNegativeIntegerSchema,
  running: nonNegativeIntegerSchema,
  completed: nonNegativeIntegerSchema,
  incomplete: nonNegativeIntegerSchema,
  skipped: nonNegativeIntegerSchema,
});

const legacyReviewerTerminalRecordSchema = z.discriminatedUnion("status", [
  z.strictObject({
    reviewer_id: persistedString,
    status: z.literal("completed"),
    adapter: persistedString,
    model: persistedString,
    isolation: isolationLevelSchema,
    elapsed_ms: nonNegativeIntegerSchema,
    result: legacyReviewerResultSchema,
  }),
  z.strictObject({
    reviewer_id: persistedString,
    status: z.literal("incomplete"),
    adapter: persistedString,
    model: persistedString,
    isolation: isolationLevelSchema.optional(),
    elapsed_ms: nonNegativeIntegerSchema,
    reason: incompleteReasonSchema,
    message: z.string().min(1).max(1_000),
    retryable: z.boolean(),
  }),
  z.strictObject({
    reviewer_id: persistedString,
    status: z.literal("skipped"),
    adapter: persistedString,
    model: persistedString,
    elapsed_ms: nonNegativeIntegerSchema,
    reason: z.enum(["prior_findings", "prior_incomplete"]),
    blocked_by_reviewer_id: persistedString,
  }),
]);

const legacyV4EnvelopeSchema = z.strictObject({
  schema_version: z.literal("4"),
  event: z.string(),
  run_id: persistedString,
  request_id: persistedString.optional(),
  seq: positiveIntegerSchema,
  timestamp: timestampSchema,
  reviewer_id: persistedString.optional(),
  data: z.unknown(),
});

const legacyV4SuiteReviewerSchema = z.strictObject({
  id: persistedString,
  agent_id: persistedString,
  model_index: nonNegativeIntegerSchema,
  model_count: positiveIntegerSchema,
  previous_reviewer_id: persistedString.optional(),
  activation: z.enum(["immediate", "after_clear_pass"]),
  purpose: persistedString,
  adapter: persistedString,
  adapter_type: z.enum([
    "copilot",
    "claude",
    "codex",
    "openai_compatible",
    "command",
  ]),
  model: persistedString,
  effort: reasoningEffortSchema.optional(),
  isolation_policy: isolationPolicySchema,
  timeout_ms: positiveIntegerSchema,
  instruction_sources: z.array(persistedString).max(256),
});

const legacyV4SelectionSchema = z.strictObject({
  source: z.enum(["legacy", "defaults", "project"]),
  project_name: persistedString.optional(),
  project_name_source: z
    .enum(["git_remote", "git_common_directory", "git_root", "workspace"])
    .optional(),
  matched_project_name: persistedString.optional(),
});

const legacyV4ExecutionSchema = z.strictObject({
  max_concurrency: positiveIntegerSchema,
  heartbeat_interval_ms: positiveIntegerSchema,
  shutdown_grace_period_ms: positiveIntegerSchema,
});

const legacyV4RunCompletedDataSchema = z.strictObject({
  status: z.enum(["passed", "findings", "incomplete"]),
  exit_code: nonNegativeIntegerSchema,
  consistency_mode: z.literal("live_worktree"),
  total_elapsed_ms: nonNegativeIntegerSchema,
  suite: legacySuiteCountsSchema,
  reviewers: z.array(legacyReviewerTerminalRecordSchema).max(1_024),
});

const legacyV4PublicEventSchema = z.discriminatedUnion("event", [
  legacyV4EnvelopeSchema.extend({
    event: z.literal("run.started"),
    data: z.strictObject({ consistency_mode: z.literal("live_worktree") }),
  }),
  legacyV4EnvelopeSchema.extend({
    event: z.literal("context.resolved"),
    data: z.strictObject({ context: z.json() }),
  }),
  legacyV4EnvelopeSchema.extend({
    event: z.literal("suite.resolved"),
    data: z.strictObject({
      total: nonNegativeIntegerSchema,
      execution: legacyV4ExecutionSchema,
      selection: legacyV4SelectionSchema.optional(),
      reviewers: z.array(legacyV4SuiteReviewerSchema).max(1_024),
    }),
  }),
  legacyV4EnvelopeSchema.extend({
    event: z.literal("reviewer.started"),
    data: z.strictObject({
      purpose: persistedString,
      adapter: persistedString,
      model: persistedString,
      effort: reasoningEffortSchema.optional(),
      isolation_policy: isolationPolicySchema,
      timeout_ms: positiveIntegerSchema,
    }),
  }),
  legacyV4EnvelopeSchema.extend({
    event: z.literal("reviewer.progress"),
    data: z.strictObject({
      phase: z.enum([
        "queued",
        "probing",
        "starting",
        "reviewing",
        "validating",
        "terminal",
      ]),
      message: z.string().min(1).max(1_000).optional(),
    }),
  }),
  legacyV4EnvelopeSchema.extend({
    event: z.literal("reviewer.heartbeat"),
    data: z.strictObject({
      phase: z.enum([
        "queued",
        "probing",
        "starting",
        "reviewing",
        "validating",
        "terminal",
      ]),
      elapsed_ms: nonNegativeIntegerSchema,
      last_activity_at: timestampSchema.optional(),
      last_activity_message: z.string().min(1).max(1_000).optional(),
      suite: legacySuiteCountsSchema,
      isolation: isolationLevelSchema.optional(),
    }),
  }),
  legacyV4EnvelopeSchema.extend({
    event: z.literal("reviewer.completed"),
    data: z.strictObject({
      adapter: persistedString,
      model: persistedString,
      isolation: isolationLevelSchema,
      elapsed_ms: nonNegativeIntegerSchema,
      result: legacyReviewerResultSchema,
    }),
  }),
  legacyV4EnvelopeSchema.extend({
    event: z.literal("reviewer.incomplete"),
    data: z.strictObject({
      adapter: persistedString,
      model: persistedString,
      isolation: isolationLevelSchema.optional(),
      elapsed_ms: nonNegativeIntegerSchema,
      reason: incompleteReasonSchema,
      message: z.string().min(1).max(1_000),
      retryable: z.boolean(),
    }),
  }),
  legacyV4EnvelopeSchema.extend({
    event: z.literal("reviewer.skipped"),
    data: z.strictObject({
      adapter: persistedString,
      model: persistedString,
      elapsed_ms: nonNegativeIntegerSchema,
      reason: z.enum(["prior_findings", "prior_incomplete"]),
      blocked_by_reviewer_id: persistedString,
    }),
  }),
  legacyV4EnvelopeSchema.extend({
    event: z.literal("run.completed"),
    data: legacyV4RunCompletedDataSchema,
  }),
]);

const persistedExecutionSchema = z.looseObject({
  max_concurrency: positiveIntegerSchema,
  heartbeat_interval_ms: positiveIntegerSchema,
  shutdown_grace_period_ms: positiveIntegerSchema,
  distribute_primaries: z.boolean().optional(),
  default_provider_concurrency: positiveIntegerSchema.optional(),
  provider_limits: z.record(persistedString, positiveIntegerSchema).optional(),
  circuit_breaker_threshold: positiveIntegerSchema.optional(),
  retry_attempts: positiveIntegerSchema.optional(),
  retry_backoff_ms: nonNegativeIntegerSchema.optional(),
});

const persistedReviewerPolicySchema = z.looseObject({
  applicability: z
    .looseObject({
      anyChangedPaths: z.array(persistedString).min(1).max(256),
      caseSensitive: z.boolean().optional(),
    })
    .optional(),
  requiredCallerContext: z.array(persistedString).max(256).optional(),
  passQuorum: positiveIntegerSchema,
  minimumProviderGroups: positiveIntegerSchema,
  adjudication: z.enum(["off", "required"]),
  gateMinimumSeverity: findingSeveritySchema,
  gateMinimumConfidence: z.enum(["high", "medium", "low"]),
  mode: reviewerModeSchema.optional(),
  adjudicatesReviewerId: persistedString.optional(),
  candidateFindings: z.json().optional(),
});

const persistedResolutionReviewerSchema = z.strictObject({
  id: persistedString,
  agent_id: persistedString.optional(),
  model_index: nonNegativeIntegerSchema.optional(),
  configured_model_index: nonNegativeIntegerSchema.optional(),
  model_count: positiveIntegerSchema.optional(),
  previous_reviewer_id: persistedString.optional(),
  purpose: persistedString.optional(),
  adapter: persistedString.optional(),
  model: persistedString.optional(),
  effort: reasoningEffortSchema.optional(),
  isolation_policy: isolationPolicySchema.optional(),
  timeout_ms: positiveIntegerSchema.optional(),
  runtime: z.record(z.string(), z.json()).optional(),
  instruction_sources: z
    .array(z.enum(["trusted", "project"]))
    .max(256)
    .optional(),
  provider_group: persistedString.optional(),
  attempt_timeout_ms: positiveIntegerSchema.optional(),
  policy: persistedReviewerPolicySchema.optional(),
});

const persistedResolutionLensSchema = z.strictObject({
  id: persistedString.optional(),
  lens_id: persistedString.optional(),
  reviewers: z
    .array(
      z.strictObject({
        id: persistedString.optional(),
        reviewer_id: persistedString.optional(),
      }),
    )
    .max(1_024),
});

const persistedResolutionSchema = z.looseObject({
  execution: persistedExecutionSchema.optional(),
  diagnostics: z
    .looseObject({
      persist_runs: z.boolean(),
      max_runs: positiveIntegerSchema,
    })
    .optional(),
  reviewers: z.array(persistedResolutionReviewerSchema).max(1_024),
  logical_lenses: z.array(persistedResolutionLensSchema).max(1_024).optional(),
});

const persistedFailureSchema = z.looseObject({
  reason: incompleteReasonSchema,
  message: z.string().min(1).max(1_000),
  retryable: z.boolean(),
  fallback_eligible: z.boolean().optional(),
  diagnostics: adapterFailureDiagnosticsSchema.loose().optional(),
});

const persistedReviewerTerminalSchema = z.discriminatedUnion("status", [
  z.looseObject({
    reviewer_id: persistedString,
    lens_id: persistedString.optional(),
    status: z.literal("completed"),
    mode: reviewerModeSchema.optional(),
    adapter: persistedString,
    model: persistedString,
    provider_group: persistedString.optional(),
    isolation: isolationLevelSchema,
    elapsed_ms: nonNegativeIntegerSchema,
    result: persistedReviewerResultSchema,
  }),
  z.looseObject({
    reviewer_id: persistedString,
    lens_id: persistedString.optional(),
    status: z.literal("incomplete"),
    mode: reviewerModeSchema.optional(),
    adapter: persistedString,
    model: persistedString,
    provider_group: persistedString.optional(),
    isolation: isolationLevelSchema.optional(),
    elapsed_ms: nonNegativeIntegerSchema,
    reason: incompleteReasonSchema,
    message: z.string().min(1).max(1_000),
    retryable: z.boolean(),
    fallback_eligible: z.boolean().optional(),
    diagnostics: adapterFailureDiagnosticsSchema.loose().optional(),
  }),
  z.looseObject({
    reviewer_id: persistedString,
    lens_id: persistedString.optional(),
    status: z.literal("skipped"),
    mode: reviewerModeSchema.optional(),
    adapter: persistedString,
    model: persistedString,
    provider_group: persistedString.optional(),
    elapsed_ms: nonNegativeIntegerSchema,
    reason: reviewerSkipReasonSchema,
    blocked_by_reviewer_id: persistedString.optional(),
    missing_inputs: z.array(persistedString).optional(),
  }),
]);

const persistedLogicalLensCountsSchema = z.looseObject({
  total: nonNegativeIntegerSchema,
  pending: nonNegativeIntegerSchema.optional(),
  findings: nonNegativeIntegerSchema,
  passed: nonNegativeIntegerSchema,
  incomplete: nonNegativeIntegerSchema,
  not_applicable: nonNegativeIntegerSchema.optional(),
  not_evaluated: nonNegativeIntegerSchema.optional(),
  not_selected: nonNegativeIntegerSchema.optional(),
  incomplete_lenses: z.array(persistedString).max(1_024).optional(),
});

const persistedModelRunCountsSchema = z.looseObject({
  total: nonNegativeIntegerSchema,
  deferred: nonNegativeIntegerSchema.optional(),
  queued: nonNegativeIntegerSchema.optional(),
  running: nonNegativeIntegerSchema.optional(),
  completed: nonNegativeIntegerSchema,
  incomplete: nonNegativeIntegerSchema,
  skipped: nonNegativeIntegerSchema,
  skip_reasons: z.record(persistedString, nonNegativeIntegerSchema).optional(),
});

const persistedRunSummaryDataSchema = z.looseObject({
  status: z.enum(["passed", "findings", "incomplete"]).optional(),
  gate_outcome: z
    .enum([
      "no_findings",
      "findings",
      "passed",
      "clear",
      "unknown_future_value",
    ])
    .optional(),
  coverage_outcome: z.enum(["complete", "partial", "incomplete"]).optional(),
  exit_code: nonNegativeIntegerSchema.optional(),
  consistency_mode: z.literal("live_worktree").optional(),
  total_elapsed_ms: nonNegativeIntegerSchema.optional(),
  logical_lenses: persistedLogicalLensCountsSchema.optional(),
  model_runs: persistedModelRunCountsSchema.optional(),
  suite: persistedModelRunCountsSchema.optional(),
  unique_findings: nonNegativeIntegerSchema.optional(),
  advisory_findings: nonNegativeIntegerSchema.optional(),
  incomplete_lenses: z.array(persistedString).max(1_024).optional(),
  not_evaluated_lenses: z.array(persistedString).max(1_024).optional(),
  report_path: persistedString.optional(),
  result_manifest: z.array(z.record(z.string(), z.unknown())).optional(),
  results_complete: z.boolean().optional(),
  reviewers: z.array(persistedReviewerTerminalSchema).max(1_024).optional(),
});

const privateRecordSchema = z.union([
  z.looseObject({
    record: z.literal("resolution"),
    run_id: persistedString,
    resolution: persistedResolutionSchema,
  }),
  z.strictObject({
    record: z.literal("request"),
    run_id: persistedString,
    request: reviewRequestSchema,
  }),
  z.strictObject({
    record: z.literal("context"),
    run_id: persistedString,
    context: z.json(),
  }),
  z
    .looseObject({
      record: z.literal(persistedReviewerResultRecordType),
      run_id: persistedString,
      reviewer_id: persistedString,
      lens_id: persistedString.optional(),
      agent_id: persistedString.optional(),
      mode: reviewerModeSchema.optional(),
      adjudicates_reviewer_id: persistedString.optional(),
      ...legacyResultRecordFields,
    })
    .superRefine((value, ctx) => {
      if (
        value.result.schema_version !== "3" &&
        !("kind" in value.result)
      )
        return;
      if (value.digest === undefined) {
        ctx.addIssue({
          code: "custom",
          message: "v3 reviewer result records require a digest",
          path: ["digest"],
        });
      }
      if (value.byte_count === undefined) {
        ctx.addIssue({
          code: "custom",
          message: "v3 reviewer result records require a byte count",
          path: ["byte_count"],
        });
      }
    }),
  z
    .looseObject({
      record: z.literal(persistedReviewerResultRecordType),
      run_id: persistedString,
      reviewer_id: persistedString,
      lens_id: persistedString.optional(),
      agent_id: persistedString.optional(),
      mode: reviewerModeSchema.optional(),
      adjudicates_reviewer_id: persistedString.optional(),
      data: z.strictObject({
        ...legacyResultRecordFields,
      }),
    })
    .superRefine((value, ctx) => {
      if (
        value.data.result.schema_version !== "3" &&
        !("kind" in value.data.result)
      )
        return;
      if (value.data.digest === undefined) {
        ctx.addIssue({
          code: "custom",
          message: "v3 reviewer result records require a digest",
          path: ["data", "digest"],
        });
      }
      if (value.data.byte_count === undefined) {
        ctx.addIssue({
          code: "custom",
          message: "v3 reviewer result records require a byte count",
          path: ["data", "byte_count"],
        });
      }
    }),
  z.looseObject({
    record: z.literal(persistedReviewerTerminalRecordType),
    run_id: persistedString,
    terminal: persistedReviewerTerminalSchema,
  }),
  z.looseObject({
    record: z.literal(persistedReviewerTerminalRecordType),
    run_id: persistedString,
    data: persistedReviewerTerminalSchema,
  }),
  z.looseObject({
    record: z.literal("reviewer.attempt"),
    run_id: persistedString,
    reviewer_id: persistedString,
    lens_id: persistedString.optional(),
    attempt: positiveIntegerSchema,
    startedAt: timestampSchema,
    elapsedMs: nonNegativeIntegerSchema,
    failure: persistedFailureSchema,
  }),
  z.looseObject({
    record: z.literal("reviewer.activity"),
    run_id: persistedString,
    reviewer_id: persistedString,
    lens_id: persistedString.optional(),
    phase: z
      .enum([
        "queued",
        "probing",
        "starting",
        "reviewing",
        "validating",
        "terminal",
      ])
      .optional(),
    type: z.enum(["activity", "progress"]),
    timestamp: timestampSchema,
    message: z
      .string()
      .min(1)
      .max(64 * 1_024),
  }),
  z.looseObject({
    record: z.literal("reviewer.attempt"),
    run_id: persistedString,
    reviewer_id: persistedString,
    lens_id: persistedString.optional(),
    attempt: positiveIntegerSchema,
    started_at: timestampSchema,
    elapsed_ms: nonNegativeIntegerSchema,
    failure: persistedFailureSchema,
  }),
  z.looseObject({
    record: z.literal("run.summary"),
    run_id: persistedString,
    summary: persistedRunSummaryDataSchema,
  }),
  z.looseObject({
    record: z.literal("run.summary"),
    run_id: persistedString,
    data: persistedRunSummaryDataSchema,
  }),
]);
type PrivateRecord = z.infer<typeof privateRecordSchema>;

export type FindingSeverity = "critical" | "high" | "medium" | "low";
export type FindingConfidence = "high" | "medium" | "low";
export type FindingClassification =
  "confirmed_defect" | "needs_verification" | "advisory";

export interface RunFindingEvidence {
  path?: string;
  start_line?: number;
  end_line?: number;
  detail: string;
}

export interface FindingSource {
  reviewer_id: string;
  finding_id: string;
}

export interface RawRunFinding {
  source_ref: string;
  reviewer_id: string;
  lens_id: string;
  finding_id: string;
  severity: FindingSeverity;
  title: string;
  description: string;
  evidence: RunFindingEvidence[];
  suggested_direction: string;
  confidence: FindingConfidence;
  classification: FindingClassification;
  external_assumptions: string[];
  source_findings: FindingSource[];
  duplicate_finding_ids: string[];
  deduplication_key?: string;
  duplicate_of?: string;
  gate_eligible?: boolean;
  adjudication?:
    | "unadjudicated"
    | "confirmed"
    | "adjusted"
    | "rejected"
    | "needs_verification";
  effective_finding?: CanonicalRawFinding["effective_finding"];
}

export interface ConsolidatedRunFinding {
  id: string;
  severity: FindingSeverity;
  title: string;
  description: string;
  evidence: RunFindingEvidence[];
  suggested_direction: string;
  confidence: FindingConfidence;
  classification: FindingClassification;
  external_assumptions: string[];
  source_findings: FindingSource[];
  duplicate_finding_ids: string[];
  descriptions?: string[];
  suggested_directions?: string[];
  gate_eligible?: boolean;
}

export interface RunReport {
  schema_version: "1";
  kind: "review-mesh.run-report";
  run_id: string;
  active: boolean;
  status: "running" | "passed" | "findings" | "incomplete";
  gate_outcome: "passed" | "findings";
  coverage_outcome: "complete" | "partial";
  exit_code?: number;
  total_elapsed_ms?: number;
  report_path: string;
  logical_lenses: {
    total: number;
    findings: number;
    passed: number;
    incomplete: number;
    not_applicable: number;
    not_evaluated: number;
    not_selected?: number;
    unknown: number;
  };
  model_runs: {
    total: number;
    completed: number;
    incomplete: number;
    skipped: number;
  };
  reviewers: Array<{
    reviewer_id: string;
    lens_id: string;
    status: "completed" | "incomplete" | "skipped";
    reason?: string;
    result?: PersistedReviewerResult;
  }>;
  incomplete_lenses: string[];
  raw_findings: RawRunFinding[];
  findings: ConsolidatedRunFinding[];
  finding_counts: {
    raw: number;
    unique: number;
    gate: number;
    advisory: number;
  };
  attempts: Array<{
    reviewer_id: string;
    lens_id?: string;
    attempt: number;
    started_at?: string;
    elapsed_ms: number;
    failure: Record<string, unknown>;
  }>;
  record_warnings?: RunRecordWarning[];
  omitted_record_warnings?: number;
}

export interface RunFindings {
  run_id: string;
  raw: RawRunFinding[];
  deduplicated: ConsolidatedRunFinding[];
  record_warnings?: RunRecordWarning[];
  omitted_record_warnings?: number;
}

export interface ReadRunReportOptions {
  runsDirectory: string;
  runId: string;
  /** Recover validated data around incompatible records without changing strict defaults. */
  bestEffort?: boolean;
}

export interface RunRecordWarning {
  line: number;
  record_type: string;
  message: string;
  schema_paths?: string[];
}

export interface RetryRunPlan {
  schema_version: "1";
  kind: "review-mesh.retry-plan";
  parent_run_id: string;
  request: Record<string, unknown>;
  incomplete_lenses: string[];
}

export class RunReportError extends Error {
  constructor(
    readonly code: "invalid_run_id" | "run_not_found" | "invalid_run_record",
    message: string,
    readonly line?: number,
    readonly recordType?: string,
    readonly schemaPaths?: string[],
  ) {
    super(message);
    this.name = "RunReportError";
  }

  get diagnosticDetails(): Record<string, unknown> {
    return {
      ...(this.line === undefined ? {} : { line: this.line }),
      ...(this.recordType === undefined
        ? {}
        : { record_type: this.recordType }),
      ...(this.schemaPaths === undefined || this.schemaPaths.length === 0
        ? {}
        : { schema_paths: [...this.schemaPaths] }),
    };
  }
}

interface RunRecordPath {
  path: string;
  active: boolean;
  root: string;
  name: string;
}

interface ReviewerMetadata {
  reviewerId: string;
  lensId: string;
  mode?: "full_review" | "adjudication";
  adjudicatesReviewerId?: string;
  gateMinimumSeverity?: FindingSeverity;
  gateMinimumConfidence?: FindingConfidence;
}

interface ReviewerTerminal {
  reviewerId: string;
  status: "completed" | "incomplete" | "skipped";
  reason?: string;
  result?: PersistedReviewerResult;
  resultPriority: number;
}

interface ParsedReportRecord {
  terminalEventSeen: boolean;
  reportedStatus?: string;
  reportedGateOutcome?: string;
  reportedCoverageOutcome?: string;
  reportedExitCode?: number;
  reportedElapsedMs?: number;
  reportedPath?: string;
  reportedIncompleteLenses?: string[];
  reportedModelTotal?: number;
  reportedLogicalLenses?: RunReport["logical_lenses"];
  reviewers: Map<string, ReviewerMetadata>;
  terminals: Map<string, ReviewerTerminal>;
  request?: Record<string, unknown>;
  context?: Record<string, unknown>;
  attempts: RunReport["attempts"];
  recordWarnings: RunRecordWarning[];
  omittedRecordWarnings: number;
}

interface ParsedFinding extends RawRunFinding {
  legacyDeduplicationKey: string;
}

const severityRank: Readonly<Record<FindingSeverity, number>> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

const confidenceRank: Readonly<Record<FindingConfidence, number>> = {
  high: 3,
  medium: 2,
  low: 1,
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const MAX_SCHEMA_PATHS = 8;
const MAX_SCHEMA_PATH_LENGTH = 256;

function recordType(value: unknown): string {
  const record = asRecord(value);
  const type = nonEmptyString(record?.record) ?? nonEmptyString(record?.event);
  return type === undefined ? "unknown" : type.slice(0, 128);
}

function schemaPaths(error: z.ZodError): string[] {
  return uniqueSorted(
    error.issues
      .map((issue) => {
        const path = issue.path
          .map((part) =>
            typeof part === "number" ? `[${part}]` : String(part),
          )
          .reduce(
            (current, part) =>
              part.startsWith("[")
                ? `${current}${part}`
                : current.length === 0
                  ? part
                  : `${current}.${part}`,
            "",
          );
        return (path.length === 0 ? "$" : path).slice(
          0,
          MAX_SCHEMA_PATH_LENGTH,
        );
      })
      .filter((path) => path.length > 0),
  ).slice(0, MAX_SCHEMA_PATHS);
}

function invalidRecordError(
  line: number,
  type: string,
  description: string,
  paths?: string[],
): RunReportError {
  const pathSuffix =
    paths === undefined || paths.length === 0
      ? ""
      : ` Schema paths: ${paths.join(", ")}.`;
  return new RunReportError(
    "invalid_run_record",
    `The persisted run record contains ${description} at JSONL line ${line} (${type}).${pathSuffix}`,
    line,
    type,
    paths,
  );
}

function addRecordWarning(
  parsed: ParsedReportRecord,
  error: RunReportError,
): void {
  if (parsed.recordWarnings.length >= MAX_RECORD_WARNINGS) {
    parsed.omittedRecordWarnings += 1;
    return;
  }
  parsed.recordWarnings.push({
    line: error.line ?? 1,
    record_type: error.recordType ?? "unknown",
    message: error.message,
    ...(error.schemaPaths === undefined || error.schemaPaths.length === 0
      ? {}
      : { schema_paths: [...error.schemaPaths] }),
  });
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueSorted(
    value
      .map(nonEmptyString)
      .filter((item): item is string => item !== undefined),
  );
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function normalizedText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function sourceReference(reviewerId: string, findingId: string): string {
  return `${reviewerId}#${findingId}`;
}

function inferredLensId(reviewerId: string): string {
  const separator = reviewerId.indexOf("::");
  return separator > 0 ? reviewerId.slice(0, separator) : reviewerId;
}

function requireSafeRunId(runId: string): void {
  if (!SAFE_RUN_ID.test(runId) || runId === "." || runId === "..") {
    throw new RunReportError(
      "invalid_run_id",
      "Run id must be a safe single filename component.",
    );
  }
}

function isWithinDirectory(directory: string, target: string): boolean {
  const path = relative(directory, target);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function resolveRunRecordPath(
  runsDirectory: string,
  runId: string,
): Promise<RunRecordPath> {
  const root = await realpath(resolve(runsDirectory)).catch(() => undefined);
  if (root === undefined) {
    throw new RunReportError("run_not_found", `Run ${runId} was not found.`);
  }
  const names = await readdir(root);
  const finalName = `${runId}.jsonl`;
  const activePrefix = `${runId}.jsonl.active`;
  const candidates = names.filter(
    (name) =>
      name === finalName ||
      (name.startsWith(activePrefix) &&
        ACTIVE_SUFFIX.test(name.slice(runId.length))),
  );
  const selected = candidates.includes(finalName)
    ? finalName
    : candidates.sort().at(-1);
  if (selected === undefined) {
    throw new RunReportError("run_not_found", `Run ${runId} was not found.`);
  }
  const path = join(root, selected);
  const canonical = await realpath(path).catch(() => undefined);
  if (
    canonical === undefined ||
    !isWithinDirectory(root, canonical) ||
    basename(canonical) !== selected
  ) {
    throw new RunReportError(
      "invalid_run_record",
      "The persisted run record path is unsafe.",
    );
  }
  return {
    path: canonical,
    active: selected !== finalName,
    root,
    name: selected,
  };
}

async function readBoundedFile(
  path: string,
  active: boolean,
  root?: string,
  expectedName?: string,
): Promise<string> {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(path, flags).catch(() => undefined);
  if (handle === undefined) {
    throw new RunReportError(
      "invalid_run_record",
      "The persisted run record could not be opened safely.",
    );
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > MAX_REPORT_RECORD_BYTES) {
      throw new RunReportError(
        "invalid_run_record",
        "The persisted run record is unavailable or exceeds the report limit.",
      );
    }
    const text = await handle.readFile("utf8");
    const current = await handle.stat();
    if (root !== undefined && expectedName !== undefined) {
      const canonical = await realpath(path).catch(() => undefined);
      const pathMetadata = await lstat(path, { bigint: true }).catch(
        () => undefined,
      );
      if (
        canonical === undefined ||
        pathMetadata === undefined ||
        pathMetadata.isSymbolicLink() ||
        !isWithinDirectory(root, canonical) ||
        basename(canonical) !== expectedName ||
        (process.platform !== "win32" &&
          metadata.dev !== 0 &&
          pathMetadata.dev !== 0n &&
          BigInt(metadata.dev) !== pathMetadata.dev) ||
        (process.platform !== "win32" &&
          metadata.ino !== 0 &&
          pathMetadata.ino !== 0n &&
          BigInt(metadata.ino) !== pathMetadata.ino)
      ) {
        throw new RunReportError(
          "invalid_run_record",
          "The persisted run record identity changed while being read.",
        );
      }
    }
    if (
      !active &&
      (current.size !== metadata.size || current.mtimeMs !== metadata.mtimeMs)
    ) {
      throw new RunReportError(
        "invalid_run_record",
        "The completed run record changed while the report was being read.",
      );
    }
    return text;
  } finally {
    await handle.close();
  }
}

function reviewerMetadata(
  value: unknown,
  fallbackReviewerId?: string,
): ReviewerMetadata | undefined {
  const record = asRecord(value);
  const reviewerId =
    nonEmptyString(record?.id) ??
    nonEmptyString(record?.reviewer_id) ??
    fallbackReviewerId;
  if (reviewerId === undefined) return undefined;
  const lensId =
    nonEmptyString(record?.agent_id) ??
    nonEmptyString(record?.lens_id) ??
    nonEmptyString(record?.logical_lens_id) ??
    inferredLensId(reviewerId);
  const mode = record?.mode === "adjudication" ? "adjudication" : undefined;
  const adjudicatesReviewerId = nonEmptyString(record?.adjudicates_reviewer_id);
  const policy = asRecord(record?.policy);
  const gateMinimumSeverity = findingSeveritySchema.safeParse(
    policy?.gateMinimumSeverity,
  );
  const gateMinimumConfidence = z
    .enum(["high", "medium", "low"])
    .safeParse(policy?.gateMinimumConfidence);
  return {
    reviewerId,
    lensId,
    ...(mode === undefined ? {} : { mode }),
    ...(adjudicatesReviewerId === undefined ? {} : { adjudicatesReviewerId }),
    ...(gateMinimumSeverity.success
      ? { gateMinimumSeverity: gateMinimumSeverity.data }
      : {}),
    ...(gateMinimumConfidence.success
      ? { gateMinimumConfidence: gateMinimumConfidence.data }
      : {}),
  };
}

function addReviewer(
  parsed: ParsedReportRecord,
  value: unknown,
  fallbackReviewerId?: string,
): void {
  const metadata = reviewerMetadata(value, fallbackReviewerId);
  if (metadata === undefined) return;
  const current = parsed.reviewers.get(metadata.reviewerId);
  parsed.reviewers.set(metadata.reviewerId, {
    reviewerId: metadata.reviewerId,
    lensId:
      metadata.lensId === metadata.reviewerId && current !== undefined
        ? current.lensId
        : metadata.lensId,
    ...(metadata.mode === undefined
      ? current?.mode === undefined
        ? {}
        : { mode: current.mode }
      : { mode: metadata.mode }),
    ...(metadata.adjudicatesReviewerId === undefined
      ? current?.adjudicatesReviewerId === undefined
        ? {}
        : { adjudicatesReviewerId: current.adjudicatesReviewerId }
      : { adjudicatesReviewerId: metadata.adjudicatesReviewerId }),
    ...(metadata.gateMinimumSeverity === undefined
      ? current?.gateMinimumSeverity === undefined
        ? {}
        : { gateMinimumSeverity: current.gateMinimumSeverity }
      : { gateMinimumSeverity: metadata.gateMinimumSeverity }),
    ...(metadata.gateMinimumConfidence === undefined
      ? current?.gateMinimumConfidence === undefined
        ? {}
        : { gateMinimumConfidence: current.gateMinimumConfidence }
      : { gateMinimumConfidence: metadata.gateMinimumConfidence }),
  });
}

function terminalResult(value: unknown): PersistedReviewerResult | undefined {
  const record = asRecord(value);
  const candidate = record?.result ?? record?.detailed_result;
  const result = persistedReviewerResultSchema.safeParse(candidate);
  return result.success ? structuredClone(result.data) : undefined;
}

function upsertTerminal(
  parsed: ParsedReportRecord,
  reviewerId: string,
  status: ReviewerTerminal["status"],
  value: unknown,
  resultPriority: number,
): void {
  addReviewer(parsed, value, reviewerId);
  const record = asRecord(value) ?? {};
  const result = terminalResult(record);
  const current = parsed.terminals.get(reviewerId);
  const reason = nonEmptyString(record.reason) ?? current?.reason;
  const resultFields =
    result !== undefined && resultPriority > (current?.resultPriority ?? -1)
      ? { result, resultPriority }
      : current?.result === undefined
        ? {
            resultPriority: Math.max(
              resultPriority,
              current?.resultPriority ?? 0,
            ),
          }
        : { result: current.result, resultPriority: current.resultPriority };
  const terminal: ReviewerTerminal = {
    reviewerId,
    status,
    ...(reason === undefined ? {} : { reason }),
    ...resultFields,
  };
  parsed.terminals.set(reviewerId, terminal);
}

function parseTerminalRecord(
  parsed: ParsedReportRecord,
  value: unknown,
  resultPriority: number,
): void {
  const record = asRecord(value);
  const reviewerId = nonEmptyString(record?.reviewer_id);
  const status = nonEmptyString(record?.status);
  if (
    reviewerId === undefined ||
    (status !== "completed" && status !== "incomplete" && status !== "skipped")
  ) {
    return;
  }
  upsertTerminal(parsed, reviewerId, status, record, resultPriority);
}

function parseReportedSummary(
  parsed: ParsedReportRecord,
  value: unknown,
): void {
  const data = asRecord(value);
  if (data === undefined) return;
  const status = nonEmptyString(data.status);
  if (status !== undefined) parsed.reportedStatus = status;
  const gateOutcome = nonEmptyString(data.gate_outcome);
  if (gateOutcome !== undefined) parsed.reportedGateOutcome = gateOutcome;
  const coverageOutcome = nonEmptyString(data.coverage_outcome);
  if (coverageOutcome !== undefined) {
    parsed.reportedCoverageOutcome = coverageOutcome;
  }
  const exitCode = nonNegativeInteger(data.exit_code);
  if (exitCode !== undefined) parsed.reportedExitCode = exitCode;
  const elapsedMs = nonNegativeInteger(data.total_elapsed_ms);
  if (elapsedMs !== undefined) parsed.reportedElapsedMs = elapsedMs;
  const reportPath = nonEmptyString(data.report_path);
  if (reportPath !== undefined) parsed.reportedPath = reportPath;
  const logicalLenses = asRecord(data.logical_lenses);
  if (logicalLenses !== undefined) {
    const total = nonNegativeInteger(logicalLenses.total);
    const findings = nonNegativeInteger(logicalLenses.findings);
    const passed = nonNegativeInteger(logicalLenses.passed);
    const incomplete = nonNegativeInteger(logicalLenses.incomplete);
    const notApplicable = nonNegativeInteger(logicalLenses.not_applicable);
    const notEvaluated = nonNegativeInteger(logicalLenses.not_evaluated);
    if (
      total !== undefined &&
      findings !== undefined &&
      passed !== undefined &&
      incomplete !== undefined &&
      notApplicable !== undefined &&
      notEvaluated !== undefined
    ) {
      parsed.reportedLogicalLenses = {
        total,
        findings,
        passed,
        incomplete,
        not_applicable: notApplicable,
        not_evaluated: notEvaluated,
        ...(nonNegativeInteger(logicalLenses.not_selected) === undefined
          ? {}
          : {
              not_selected: nonNegativeInteger(logicalLenses.not_selected)!,
            }),
        unknown: nonNegativeInteger(logicalLenses.pending) ?? 0,
      };
    }
  }
  const incompleteLenses =
    Array.isArray(data.incomplete_lenses) && data.incomplete_lenses.length >= 0
      ? stringArray(data.incomplete_lenses)
      : Array.isArray(logicalLenses?.incomplete_lenses)
        ? stringArray(logicalLenses.incomplete_lenses)
        : undefined;
  if (incompleteLenses !== undefined) {
    parsed.reportedIncompleteLenses = incompleteLenses;
  }
  const modelRuns = asRecord(data.model_runs);
  const modelTotal =
    nonNegativeInteger(modelRuns?.total) ??
    nonNegativeInteger(asRecord(data.suite)?.total);
  if (modelTotal !== undefined) parsed.reportedModelTotal = modelTotal;
  if (Array.isArray(data.reviewers)) {
    for (const reviewer of data.reviewers) {
      parseTerminalRecord(parsed, reviewer, 1);
    }
  }
}

function parseResolution(
  parsed: ParsedReportRecord,
  resolution: z.infer<typeof persistedResolutionSchema>,
): void {
  for (const reviewer of resolution.reviewers) {
    addReviewer(parsed, reviewer);
  }
  if (resolution.logical_lenses !== undefined) {
    for (const lensValue of resolution.logical_lenses) {
      const lensId = lensValue.id ?? lensValue.lens_id;
      if (lensId === undefined) continue;
      for (const reviewerValue of lensValue.reviewers) {
        const reviewerId = reviewerValue.id ?? reviewerValue.reviewer_id;
        if (reviewerId === undefined) continue;
        parsed.reviewers.set(reviewerId, { reviewerId, lensId });
      }
    }
  }
}

function parsePublicEvent(
  parsed: ParsedReportRecord,
  value: Record<string, unknown>,
): void {
  const event = nonEmptyString(value.event);
  const reviewerId = nonEmptyString(value.reviewer_id);
  const data = asRecord(value.data);
  if (event === undefined || data === undefined) return;
  if (event === "suite.resolved") {
    if (Array.isArray(data.reviewers)) {
      for (const reviewer of data.reviewers) addReviewer(parsed, reviewer);
    }
    const total =
      nonNegativeInteger(data.model_runs) ?? nonNegativeInteger(data.total);
    if (total !== undefined) parsed.reportedModelTotal = total;
    return;
  }
  if (reviewerId !== undefined && event === "reviewer.completed") {
    upsertTerminal(parsed, reviewerId, "completed", data, 1);
    return;
  }
  if (reviewerId !== undefined && event === "reviewer.incomplete") {
    upsertTerminal(parsed, reviewerId, "incomplete", data, 1);
    return;
  }
  if (reviewerId !== undefined && event === "reviewer.skipped") {
    upsertTerminal(parsed, reviewerId, "skipped", data, 1);
    return;
  }
  if (event === "run.completed") {
    parsed.terminalEventSeen = true;
    parseReportedSummary(parsed, data);
  }
}

function parsePrivateRecord(
  parsed: ParsedReportRecord,
  value: PrivateRecord,
): void {
  if (value.record === "resolution") {
    parseResolution(parsed, value.resolution);
    return;
  }
  if (value.record === "request") {
    parsed.request = structuredClone(value.request) as unknown as Record<
      string,
      unknown
    >;
    return;
  }
  if (value.record === "context") {
    parsed.context = structuredClone(value.context) as unknown as Record<
      string,
      unknown
    >;
    return;
  }
  if (value.record === "reviewer.activity") return;
  if (value.record === "reviewer.attempt") {
    const startedAt =
      nonEmptyString(value.startedAt) ?? nonEmptyString(value.started_at);
    const elapsedMs =
      nonNegativeInteger(value.elapsedMs) ??
      nonNegativeInteger(value.elapsed_ms);
    parsed.attempts.push({
      reviewer_id: value.reviewer_id,
      ...(value.lens_id === undefined ? {} : { lens_id: value.lens_id }),
      attempt: value.attempt,
      ...(startedAt === undefined ? {} : { started_at: startedAt }),
      elapsed_ms: elapsedMs ?? 0,
      failure: structuredClone(value.failure) as unknown as Record<
        string,
        unknown
      >,
    });
    return;
  }
  if (value.record === persistedReviewerResultRecordType) {
    const result = persistedReviewerResultSchema.parse(
      value.result ?? asRecord(value.data)?.result,
    );
    if (result.schema_version === "3" || "kind" in result) {
      const container = asRecord(value.data) ?? value;
      const digest = nonEmptyString(container.digest);
      const byteCount = nonNegativeInteger(container.byte_count);
      const expectedByteCount = Buffer.byteLength(
        JSON.stringify(result),
        "utf8",
      );
      if (digest !== reviewerResultDigest(result)) {
        throw invalidRecordError(
          0,
          persistedReviewerResultRecordType,
          "a reviewer result with a mismatched digest",
          ["digest"],
        );
      }
      if (byteCount !== expectedByteCount) {
        throw invalidRecordError(
          0,
          persistedReviewerResultRecordType,
          "a reviewer result with a mismatched byte count",
          ["byte_count"],
        );
      }
    }
    addReviewer(parsed, value, value.reviewer_id);
    const current = parsed.terminals.get(value.reviewer_id);
    parsed.terminals.set(value.reviewer_id, {
      reviewerId: value.reviewer_id,
      status: current?.status ?? "completed",
      ...(current?.reason === undefined ? {} : { reason: current.reason }),
      result: structuredClone(result),
      resultPriority: 3,
    });
    return;
  }
  if (value.record === persistedReviewerTerminalRecordType) {
    parseTerminalRecord(
      parsed,
      "terminal" in value ? value.terminal : value.data,
      2,
    );
    return;
  }
  if (value.record === "run.summary") {
    parsed.terminalEventSeen = true;
    parseReportedSummary(
      parsed,
      "summary" in value ? value.summary : value.data,
    );
  }
}

function parseRunRecord(
  text: string,
  expectedRunId: string,
  allowPartialTail: boolean,
  bestEffort = false,
): ParsedReportRecord {
  const parsed: ParsedReportRecord = {
    terminalEventSeen: false,
    reviewers: new Map(),
    terminals: new Map(),
    attempts: [],
    recordWarnings: [],
    omittedRecordWarnings: 0,
  };
  const lines = text.split(/\r?\n/u);
  for (const [index, encoded] of lines.entries()) {
    if (encoded.trim().length === 0) continue;
    const line = index + 1;
    let value: unknown;
    try {
      value = JSON.parse(encoded);
    } catch {
      if (allowPartialTail && index === lines.length - 1) break;
      const error = invalidRecordError(line, "invalid_json", "invalid JSON");
      if (!bestEffort) throw error;
      addRecordWarning(parsed, error);
      continue;
    }
    const record = asRecord(value);
    if (record === undefined) {
      const error = invalidRecordError(line, "unknown", "a non-object record");
      if (!bestEffort) throw error;
      addRecordWarning(parsed, error);
      continue;
    }
    if (typeof record.event === "string") {
      const event =
        record.schema_version === "4"
          ? legacyV4PublicEventSchema.safeParse(record)
          : publicEventSchema.safeParse(record);
      if (!event.success) {
        const paths = schemaPaths(event.error);
        const error = invalidRecordError(
          line,
          recordType(record),
          "an invalid public event",
          paths,
        );
        if (!bestEffort) throw error;
        addRecordWarning(parsed, error);
        continue;
      }
      if (event.data.run_id !== expectedRunId) {
        throw invalidRecordError(
          line,
          recordType(record),
          `a mismatched run id`,
          ["run_id"],
        );
      }
      parsePublicEvent(
        parsed,
        event.data as unknown as Record<string, unknown>,
      );
      continue;
    }
    if (typeof record.record === "string") {
      const privateRecord = privateRecordSchema.safeParse(record);
      if (!privateRecord.success) {
        const paths = schemaPaths(privateRecord.error);
        const error = invalidRecordError(
          line,
          recordType(record),
          "an invalid private record",
          paths,
        );
        if (!bestEffort) throw error;
        addRecordWarning(parsed, error);
        continue;
      }
      if (privateRecord.data.run_id !== expectedRunId) {
        throw invalidRecordError(
          line,
          recordType(record),
          "a mismatched run id",
          ["run_id"],
        );
      }
      try {
        parsePrivateRecord(parsed, privateRecord.data);
      } catch (error) {
        if (error instanceof RunReportError) {
          const normalized = invalidRecordError(
            line,
            error.recordType ?? recordType(record),
            "an invalid private record",
            error.schemaPaths,
          );
          if (!bestEffort) throw normalized;
          addRecordWarning(parsed, normalized);
          continue;
        }
        throw error;
      }
      continue;
    }
    const error = invalidRecordError(
      line,
      recordType(record),
      "an unknown record type",
    );
    if (!bestEffort) throw error;
    addRecordWarning(parsed, error);
  }
  return parsed;
}

function evidenceKey(value: RunFindingEvidence): string {
  return [
    value.path ?? "",
    String(value.start_line ?? 0),
    String(value.end_line ?? 0),
    normalizedText(value.detail),
  ].join("\u0000");
}

function runFindingEvidence(
  values: readonly z.infer<typeof findingEvidenceSchema>[],
): RunFindingEvidence[] {
  return values.map((value) => ({
    ...(value.path === undefined ? {} : { path: value.path }),
    ...(value.start_line === undefined ? {} : { start_line: value.start_line }),
    ...(value.end_line === undefined ? {} : { end_line: value.end_line }),
    detail: value.detail,
  }));
}

function compareEvidence(
  left: RunFindingEvidence,
  right: RunFindingEvidence,
): number {
  return (
    (left.path ?? "\uffff").localeCompare(right.path ?? "\uffff") ||
    (left.start_line ?? Number.MAX_SAFE_INTEGER) -
      (right.start_line ?? Number.MAX_SAFE_INTEGER) ||
    (left.end_line ?? Number.MAX_SAFE_INTEGER) -
      (right.end_line ?? Number.MAX_SAFE_INTEGER) ||
    left.detail.localeCompare(right.detail)
  );
}

function uniqueEvidence(
  values: readonly RunFindingEvidence[],
): RunFindingEvidence[] {
  const byKey = new Map<string, RunFindingEvidence>();
  for (const value of values) byKey.set(evidenceKey(value), value);
  return [...byKey.values()].sort(compareEvidence);
}

function sourceKey(value: FindingSource): string {
  return `${value.reviewer_id}\u0000${value.finding_id}`;
}

function compareSources(left: FindingSource, right: FindingSource): number {
  return (
    left.reviewer_id.localeCompare(right.reviewer_id) ||
    left.finding_id.localeCompare(right.finding_id)
  );
}

function uniqueSources(values: readonly FindingSource[]): FindingSource[] {
  const byKey = new Map<string, FindingSource>();
  for (const value of values) byKey.set(sourceKey(value), value);
  return [...byKey.values()].sort(compareSources);
}

function parseRawFindings(parsed: ParsedReportRecord): ParsedFinding[] {
  const findings: ParsedFinding[] = [];
  const adjudicationDecisions = new Map<
    string,
    Map<
      string,
      ReturnType<typeof validateAdjudication>["decisions"][number]
    >
  >();
  for (const metadata of parsed.reviewers.values()) {
    if (
      metadata.mode !== "adjudication" ||
      metadata.adjudicatesReviewerId === undefined
    ) {
      continue;
    }
    const result = parsed.terminals.get(metadata.reviewerId)?.result;
    const sourceResult = parsed.terminals.get(
      metadata.adjudicatesReviewerId,
    )?.result;
    if (
      result === undefined ||
      !("decisions" in result) ||
      sourceResult === undefined ||
      sourceResult.schema_version !== "3" ||
      !("actionable_findings" in sourceResult)
    )
      continue;
    const reviewScope =
      asRecord(parsed.request?.review_scope)?.mode === "changes"
        ? "changes"
        : "full";
    const git = asRecord(parsed.context?.git);
    const outcome = validateAdjudication(sourceResult, result, {
      reviewScope,
      git: {
        changedFiles: stringArray(git?.changed_files),
        diff: typeof git?.diff === "string" ? git.diff : "",
      },
    });
    adjudicationDecisions.set(
      metadata.adjudicatesReviewerId,
      new Map(
        outcome.decisions.map((decision) => [
          decision.source_finding_id,
          decision,
        ]),
      ),
    );
  }
  for (const terminal of parsed.terminals.values()) {
    if (terminal.result === undefined) continue;
    if (!("actionable_findings" in terminal.result)) continue;
    const candidates = terminal.result.actionable_findings;
    const metadata = parsed.reviewers.get(terminal.reviewerId) ?? {
      reviewerId: terminal.reviewerId,
      lensId: inferredLensId(terminal.reviewerId),
    };
    for (const finding of candidates) {
      const findingId = finding.id;
      const currentSource = {
        reviewer_id: terminal.reviewerId,
        finding_id: findingId,
      };
      const richer = "confidence" in finding ? finding : undefined;
      const deduplicationKey = richer?.root_issue_id;
      const duplicateOf = richer?.duplicate_of;
      const duplicateFindingIds = richer?.duplicate_finding_ids ?? [];
      const adjudicationDecision =
        adjudicationDecisions.get(terminal.reviewerId)?.get(findingId) ??
        undefined;
      const adjudication =
        adjudicationDecision?.effective_decision ?? "unadjudicated";
      const adjusted = adjudicationDecision?.effective_finding;
      const effectiveSeverity = adjusted?.severity ?? finding.severity;
      const effectiveConfidence = adjusted?.confidence ?? richer?.confidence ?? "medium";
      const effectiveClassification =
        adjudication === "needs_verification"
          ? "needs_verification"
          : (adjusted?.classification ??
            richer?.classification ??
            "needs_verification");
      findings.push({
        source_ref: sourceReference(terminal.reviewerId, findingId),
        reviewer_id: terminal.reviewerId,
        lens_id: metadata.lensId,
        finding_id: findingId,
        severity: effectiveSeverity,
        title: adjusted?.title ?? finding.title,
        description: adjusted?.description ?? finding.description,
        evidence: uniqueEvidence(
          runFindingEvidence(adjusted?.evidence ?? finding.evidence),
        ),
        suggested_direction:
          adjusted?.suggested_direction ?? finding.suggested_direction,
        confidence: effectiveConfidence,
        classification: effectiveClassification,
        external_assumptions: uniqueSorted(
          adjusted?.external_assumptions ?? richer?.external_assumptions ?? [],
        ),
        source_findings: [currentSource],
        duplicate_finding_ids: uniqueSorted(duplicateFindingIds),
        ...((adjusted?.root_issue_id ?? deduplicationKey) === undefined
          ? {}
          : {
              deduplication_key:
                adjusted?.root_issue_id ?? deduplicationKey!,
            }),
        ...(duplicateOf === undefined ? {} : { duplicate_of: duplicateOf }),
        gate_eligible:
          effectiveSeverity !== "low" &&
          effectiveClassification !== "advisory" &&
          adjudication !== "rejected" &&
          adjudication !== "needs_verification",
        adjudication,
        ...(adjusted === undefined
          ? {}
          : {
              effective_finding: {
                severity: adjusted.severity,
                title: adjusted.title,
                description: adjusted.description,
                evidence: runFindingEvidence(adjusted.evidence),
                suggested_direction: adjusted.suggested_direction,
                confidence: adjusted.confidence,
                classification: adjusted.classification,
                ...(adjusted.root_issue_id === undefined
                  ? {}
                  : { root_issue_id: adjusted.root_issue_id }),
                external_assumptions: [...adjusted.external_assumptions],
              },
            }),
        legacyDeduplicationKey: `${normalizedText(finding.title)}\u0000${normalizedText(finding.description)}`,
      });
    }
  }
  return findings.sort(compareRawFindings);
}

function compareRawFindings(
  left: Pick<RawRunFinding, "lens_id" | "reviewer_id" | "finding_id" | "title">,
  right: Pick<
    RawRunFinding,
    "lens_id" | "reviewer_id" | "finding_id" | "title"
  >,
): number {
  return (
    left.lens_id.localeCompare(right.lens_id) ||
    left.reviewer_id.localeCompare(right.reviewer_id) ||
    left.finding_id.localeCompare(right.finding_id) ||
    left.title.localeCompare(right.title)
  );
}

class DisjointSet {
  private readonly parents: number[];

  constructor(size: number) {
    this.parents = Array.from({ length: size }, (_, index) => index);
  }

  find(index: number): number {
    const parent = this.parents[index]!;
    if (parent === index) return index;
    const root = this.find(parent);
    this.parents[index] = root;
    return root;
  }

  union(left: number, right: number): void {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot === rightRoot) return;
    if (leftRoot < rightRoot) this.parents[rightRoot] = leftRoot;
    else this.parents[leftRoot] = rightRoot;
  }
}

function compareCanonicalCandidates(
  left: RawRunFinding,
  right: RawRunFinding,
): number {
  return (
    severityRank[right.severity] - severityRank[left.severity] ||
    confidenceRank[right.confidence] - confidenceRank[left.confidence] ||
    (left.classification === "confirmed_defect" ? 0 : 1) -
      (right.classification === "confirmed_defect" ? 0 : 1) ||
    compareRawFindings(left, right)
  );
}

function consolidatedConfidence(
  findings: readonly RawRunFinding[],
): FindingConfidence {
  return findings.reduce<FindingConfidence>(
    (lowest, finding) =>
      confidenceRank[finding.confidence] < confidenceRank[lowest]
        ? finding.confidence
        : lowest,
    "high",
  );
}

function consolidatedClassification(
  findings: readonly RawRunFinding[],
): FindingClassification {
  const classifications = new Set(
    findings.map((finding) => finding.classification),
  );
  if (classifications.size === 1) return findings[0]!.classification;
  return "needs_verification";
}

/**
 * Consolidates explicit duplicate groups and conservative exact legacy matches.
 * Legacy findings merge only when their normalized title and description match;
 * semantic similarity is deliberately left to an adjudication/consolidation stage.
 */
export function consolidateFindings(
  values: readonly RawRunFinding[],
): ConsolidatedRunFinding[] {
  return canonicalizeFindings(values as readonly CanonicalRawFinding[])
    .consolidated;
}

type LensState =
  | "findings"
  | "passed"
  | "incomplete"
  | "not_applicable"
  | "not_evaluated"
  | "unknown";

function logicalLensStates(
  parsed: ParsedReportRecord,
  rawFindings: readonly RawRunFinding[],
): Map<string, LensState> {
  const reviewersByLens = new Map<string, string[]>();
  for (const reviewer of parsed.reviewers.values()) {
    reviewersByLens.set(reviewer.lensId, [
      ...(reviewersByLens.get(reviewer.lensId) ?? []),
      reviewer.reviewerId,
    ]);
  }
  for (const terminal of parsed.terminals.values()) {
    if (parsed.reviewers.has(terminal.reviewerId)) continue;
    const lensId = inferredLensId(terminal.reviewerId);
    reviewersByLens.set(lensId, [
      ...(reviewersByLens.get(lensId) ?? []),
      terminal.reviewerId,
    ]);
  }
  const findingsByLens = new Set(rawFindings.map((finding) => finding.lens_id));
  const states = new Map<string, LensState>();
  for (const [lensId, reviewerIds] of reviewersByLens) {
    const terminals = reviewerIds
      .map((reviewerId) => parsed.terminals.get(reviewerId))
      .filter(
        (terminal): terminal is ReviewerTerminal => terminal !== undefined,
      );
    if (findingsByLens.has(lensId)) {
      states.set(lensId, "findings");
      continue;
    }
    if (terminals.some((terminal) => terminal.result !== undefined)) {
      states.set(lensId, "passed");
      continue;
    }
    const reasons = terminals.map((terminal) => terminal.reason);
    if (
      terminals.length > 0 &&
      terminals.every(
        (terminal) =>
          terminal.status === "skipped" && terminal.reason === "not_applicable",
      )
    ) {
      states.set(lensId, "not_applicable");
      continue;
    }
    if (
      terminals.length > 0 &&
      terminals.every(
        (terminal) =>
          terminal.status === "skipped" &&
          terminal.reason === "not_evaluated_missing_input",
      )
    ) {
      states.set(lensId, "not_evaluated");
      continue;
    }
    if (
      terminals.some((terminal) => terminal.status === "incomplete") ||
      reasons.includes("blocked_by_infrastructure_failure") ||
      reasons.includes("prior_incomplete") ||
      (parsed.terminalEventSeen && terminals.length === 0)
    ) {
      states.set(lensId, "incomplete");
      continue;
    }
    states.set(lensId, "unknown");
  }
  return states;
}

function recognizedGateOutcome(
  value: string | undefined,
): "passed" | "findings" | undefined {
  if (value === "findings") return "findings";
  if (value === "passed" || value === "no_findings" || value === "clear") {
    return "passed";
  }
  return undefined;
}

function recognizedCoverageOutcome(
  value: string | undefined,
): "complete" | "partial" | undefined {
  if (value === "complete") return "complete";
  if (value === "partial" || value === "incomplete") return "partial";
  return undefined;
}

export async function readRunReport({
  runsDirectory,
  runId,
  bestEffort = false,
}: ReadRunReportOptions): Promise<RunReport> {
  requireSafeRunId(runId);
  const recordPath = await resolveRunRecordPath(runsDirectory, runId);
  const parsed = parseRunRecord(
    await readBoundedFile(
      recordPath.path,
      recordPath.active,
      recordPath.root,
      recordPath.name,
    ),
    runId,
    recordPath.active,
    bestEffort,
  );
  const rawFindings = parseRawFindings(parsed).map<RawRunFinding>(
    ({ legacyDeduplicationKey: _legacyKey, ...finding }) => finding,
  );
  const gatePolicies = Object.fromEntries(
    [...parsed.reviewers.values()].map((reviewer) => [
      reviewer.lensId,
      {
        minimumSeverity: reviewer.gateMinimumSeverity ?? "medium",
        minimumConfidence: reviewer.gateMinimumConfidence ?? "medium",
      },
    ]),
  );
  const canonical = canonicalizeFindings(
    rawFindings as readonly CanonicalRawFinding[],
    { gatePolicies },
  );
  const findings = canonical.consolidated;
  const lensStates = logicalLensStates(parsed, rawFindings);
  const derivedIncompleteLenses = [...lensStates]
    .filter(([, state]) => state === "incomplete")
    .map(([lensId]) => lensId)
    .sort((left, right) => left.localeCompare(right));
  const incompleteLenses =
    parsed.reportedIncompleteLenses ?? derivedIncompleteLenses;
  const gateOutcome =
    recognizedGateOutcome(parsed.reportedGateOutcome) ??
    (canonical.counts.gate > 0
      ? "findings"
      : "passed");
  const coverageOutcome =
    parsed.recordWarnings.length > 0
      ? "partial"
      : (recognizedCoverageOutcome(parsed.reportedCoverageOutcome) ??
        (incompleteLenses.length > 0 ? "partial" : "complete"));
  const active = recordPath.active && !parsed.terminalEventSeen;
  const status: RunReport["status"] = active
    ? "running"
    : coverageOutcome === "partial"
      ? "incomplete"
      : gateOutcome;
  const lensCount = (state: LensState): number =>
    [...lensStates.values()].filter((value) => value === state).length;
  const completedRuns = [...parsed.terminals.values()].filter(
    (terminal) =>
      terminal.status === "completed" || terminal.result !== undefined,
  ).length;
  const incompleteRuns = [...parsed.terminals.values()].filter(
    (terminal) => terminal.status === "incomplete",
  ).length;
  const skippedRuns = [...parsed.terminals.values()].filter(
    (terminal) => terminal.status === "skipped",
  ).length;

  return {
    schema_version: "1",
    kind: "review-mesh.run-report",
    run_id: runId,
    active,
    status,
    gate_outcome: gateOutcome,
    coverage_outcome: coverageOutcome,
    ...(parsed.reportedExitCode === undefined
      ? {}
      : { exit_code: parsed.reportedExitCode }),
    ...(parsed.reportedElapsedMs === undefined
      ? {}
      : { total_elapsed_ms: parsed.reportedElapsedMs }),
    report_path: parsed.reportedPath ?? recordPath.path,
    logical_lenses: parsed.reportedLogicalLenses ?? {
      total: lensStates.size,
      findings: lensCount("findings"),
      passed: lensCount("passed"),
      incomplete: incompleteLenses.length,
      not_applicable: lensCount("not_applicable"),
      not_evaluated: lensCount("not_evaluated"),
      unknown: lensCount("unknown"),
    },
    model_runs: {
      total: Math.max(
        parsed.reportedModelTotal ?? 0,
        parsed.reviewers.size,
        parsed.terminals.size,
      ),
      completed: completedRuns,
      incomplete: incompleteRuns,
      skipped: skippedRuns,
    },
    reviewers: [...parsed.terminals.values()].map((terminal) => {
      const metadata = parsed.reviewers.get(terminal.reviewerId);
      return {
        reviewer_id: terminal.reviewerId,
        lens_id: metadata?.lensId ?? terminal.reviewerId,
        status: terminal.status,
        ...(terminal.reason === undefined ? {} : { reason: terminal.reason }),
        ...(terminal.result === undefined
          ? {}
          : { result: structuredClone(terminal.result) }),
      };
    }),
    incomplete_lenses: [...incompleteLenses],
    raw_findings: rawFindings,
    findings,
    finding_counts: canonical.counts,
    attempts: [...parsed.attempts],
    ...(parsed.recordWarnings.length === 0
      ? {}
      : { record_warnings: structuredClone(parsed.recordWarnings) }),
    ...(parsed.omittedRecordWarnings === 0
      ? {}
      : { omitted_record_warnings: parsed.omittedRecordWarnings }),
  };
}

export async function readRunFindings(
  options: ReadRunReportOptions,
): Promise<RunFindings> {
  const report = await readRunReport(options);
  return {
    run_id: report.run_id,
    raw: report.raw_findings,
    deduplicated: report.findings,
    ...(report.record_warnings === undefined
      ? {}
      : { record_warnings: structuredClone(report.record_warnings) }),
    ...(report.omitted_record_warnings === undefined
      ? {}
      : { omitted_record_warnings: report.omitted_record_warnings }),
  };
}

export async function readRetryRunPlan(
  options: ReadRunReportOptions,
): Promise<RetryRunPlan> {
  requireSafeRunId(options.runId);
  const recordPath = await resolveRunRecordPath(
    options.runsDirectory,
    options.runId,
  );
  const parsed = parseRunRecord(
    await readBoundedFile(
      recordPath.path,
      recordPath.active,
      recordPath.root,
      recordPath.name,
    ),
    options.runId,
    recordPath.active,
    false,
  );
  if (parsed.request === undefined) {
    throw new RunReportError(
      "invalid_run_record",
      "The persisted run does not contain a retryable normalized request.",
    );
  }
  if (recordPath.active || !parsed.terminalEventSeen) {
    throw new RunReportError(
      "invalid_run_record",
      "Only a completed immutable run can be retried.",
    );
  }
  const request = reviewRequestSchema.safeParse(parsed.request);
  if (!request.success) {
    throw new RunReportError(
      "invalid_run_record",
      "The persisted run request does not satisfy the current request schema.",
    );
  }
  const report = await readRunReport(options);
  return {
    schema_version: "1",
    kind: "review-mesh.retry-plan",
    parent_run_id: options.runId,
    request: structuredClone(request.data),
    incomplete_lenses: [...report.incomplete_lenses],
  };
}

export function renderRunReportJson(report: RunReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

function markdownInline(value: string): string {
  return value.replace(/[\\`*_[\]<>#]/gu, (character) => `\\${character}`);
}

function markdownCode(value: string): string {
  return `\`${value.replaceAll("`", "\\`")}\``;
}

function uppercaseLabel(value: string): string {
  return value.replaceAll("_", " ").toLocaleUpperCase("en-US");
}

export function renderRunReportMarkdown(report: RunReport): string {
  const lines = [
    "# Review Mesh Report",
    "",
    `Run: ${markdownCode(report.run_id)}`,
    "",
    `Gate outcome: **${uppercaseLabel(report.gate_outcome)}**`,
    "",
    `Coverage outcome: **${uppercaseLabel(report.coverage_outcome)}**`,
    "",
    `Logical lenses: ${report.logical_lenses.findings} findings, ${report.logical_lenses.passed} passed, ${report.logical_lenses.incomplete} incomplete, ${report.logical_lenses.not_applicable} not applicable, ${report.logical_lenses.not_evaluated} not evaluated, ${report.logical_lenses.not_selected ?? 0} not selected for retry (${report.logical_lenses.total} total).`,
    "",
    `Model runs: ${report.model_runs.completed} completed, ${report.model_runs.incomplete} incomplete, ${report.model_runs.skipped} skipped (${report.model_runs.total} total).`,
  ];
  if (report.incomplete_lenses.length > 0) {
    lines.push(
      "",
      "## Incomplete lenses",
      "",
      ...report.incomplete_lenses.map((lens) => `- ${markdownCode(lens)}`),
    );
  }
  if (report.attempts.length > 0) {
    lines.push(
      "",
      "## Failed attempts",
      "",
      ...report.attempts.map(
        (attempt) =>
          `- ${markdownCode(attempt.reviewer_id)} attempt ${attempt.attempt}: ${markdownInline(String(attempt.failure.reason ?? "unknown"))} after ${attempt.elapsed_ms} ms`,
      ),
    );
  }
  if (
    report.record_warnings !== undefined &&
    report.record_warnings.length > 0
  ) {
    lines.push(
      "",
      "## Artifact warnings",
      "",
      "This report was salvaged from a partially incompatible artifact; coverage is partial.",
      "",
      ...report.record_warnings.map(
        (warning) =>
          `- Line ${warning.line} (${markdownCode(warning.record_type)}): ${markdownInline(warning.message)}`,
      ),
      ...(report.omitted_record_warnings === undefined
        ? []
        : [
            `- ${report.omitted_record_warnings} additional incompatible records were omitted from this bounded warning list.`,
          ]),
    );
  }
  lines.push("", "## Findings", "");
  const gateFindings = report.findings.filter(
    (finding) =>
      finding.severity !== "low" && finding.classification !== "advisory",
  );
  const advisories = report.findings.filter(
    (finding) =>
      finding.severity === "low" || finding.classification === "advisory",
  );
  if (gateFindings.length === 0) {
    lines.push("No findings were available in the persisted report.");
  } else {
    for (const finding of gateFindings) {
      lines.push(
        `### ${uppercaseLabel(finding.severity)} — ${markdownInline(finding.title)}`,
        "",
        `${markdownInline(finding.description)}`,
        "",
        `Classification: ${markdownCode(finding.classification)}  `,
        `Confidence: ${markdownCode(finding.confidence)}  `,
        `Sources: ${finding.source_findings
          .map((source) =>
            markdownCode(`${source.reviewer_id}#${source.finding_id}`),
          )
          .join(", ")}`,
      );
      if (finding.duplicate_finding_ids.length > 0) {
        lines.push(
          `Duplicate finding IDs: ${finding.duplicate_finding_ids
            .map(markdownCode)
            .join(", ")}`,
        );
      }
      if (finding.external_assumptions.length > 0) {
        lines.push(
          "",
          "External assumptions:",
          "",
          ...finding.external_assumptions.map(
            (assumption) => `- ${markdownInline(assumption)}`,
          ),
        );
      }
      if (finding.evidence.length > 0) {
        lines.push("", "Evidence:", "");
        for (const evidence of finding.evidence) {
          const location =
            evidence.path === undefined
              ? ""
              : evidence.start_line === undefined
                ? `${markdownCode(evidence.path)}: `
                : `${markdownCode(
                    `${evidence.path}:${evidence.start_line}${
                      evidence.end_line === undefined ||
                      evidence.end_line === evidence.start_line
                        ? ""
                        : `-${evidence.end_line}`
                    }`,
                  )}: `;
          lines.push(`- ${location}${markdownInline(evidence.detail)}`);
        }
      }
      lines.push(
        "",
        `Suggested direction: ${markdownInline(finding.suggested_direction)}`,
        "",
      );
    }
  }
  if (advisories.length > 0) {
    lines.push("", "## Advisories", "");
    for (const finding of advisories) {
      lines.push(
        `- **${uppercaseLabel(finding.severity)}** ${markdownInline(finding.title)} (${markdownCode(finding.classification)}, ${markdownCode(finding.confidence)})`,
      );
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
