import { z } from "zod";

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export const protocolVersionSchema = z.literal("1");
export const publicEventVersionSchema = z.literal("4");
export const runStatusSchema = z.enum(["passed", "findings", "incomplete"]);
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
  "cancelled",
  "unknown",
]);

const nonEmptyString = z.string().min(1);
const nonNegativeInteger = z.number().int().nonnegative();
const positiveInteger = z.number().int().positive();
const boundedMessage = z.string().min(1).max(1_000);
const timestampSchema = z.iso.datetime({ offset: true });
const consistencyModeSchema = z.literal("live_worktree");
const adapterTypeSchema = z.enum([
  "copilot",
  "claude",
  "codex",
  "openai_compatible",
  "command",
]);
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
  )
  .describe(
    "Project identity copied from review-mesh describe WORKSPACE --json at configuration.selection.project_name. This is an assertion, not a settings selector; runtime rejects a mismatch with the workspace's derived identity.",
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
const reviewPathsSchema = z
  .array(reviewPathSchema)
  .min(1)
  .describe(
    "Optional workspace-relative path filter. It only narrows the authorized changes/full scope and never broadens it.",
  )
  .optional();

export const reviewScopeSchema = z
  .discriminatedUnion("mode", [
    z.strictObject({
      mode: z
        .literal("changes")
        .describe(
          "Review only committed changes above the merge base plus staged, unstaged, and untracked work.",
        ),
      base: gitRefSchema
        .describe(
          "Optional comparison base ref, normally the PR base such as origin/main. When omitted, Review Mesh infers the remote/default main or master branch without fetching.",
        )
        .optional(),
      head: gitRefSchema
        .describe(
          "Optional head ref. Defaults to HEAD and must resolve to the checked-out workspace HEAD.",
        )
        .optional(),
      branch: gitRefSchema
        .describe(
          "Optional short checked-out branch-name assertion. A mismatch rejects the request before reviewers start.",
        )
        .optional(),
      paths: reviewPathsSchema,
    }),
    z.strictObject({
      mode: z
        .literal("full")
        .describe(
          "Explicitly authorize a whole-codebase review. Review Mesh never infers this mode from an ordinary branch or worktree request.",
        ),
      paths: reviewPathsSchema,
    }),
  ])
  .describe(
    "Required review boundary. Use changes by default; use full only when the caller explicitly requested the entire codebase.",
  );

export const reviewRequestV2Schema = z.strictObject({
  schema_version: z.literal("2").describe("The current review request schema."),
  request_id: nonEmptyString
    .describe("Optional caller correlation id copied into public events.")
    .optional(),
  project_name: projectNameSchema,
  workspace: nonEmptyString.describe(
    "Existing local worktree or clone to inspect. Review Mesh never checks out or fetches a branch.",
  ),
  instructions: nonEmptyString.describe(
    "Caller review focus applied within the authorized review_scope; it cannot broaden that scope or change the configured reviewer roster.",
  ),
  review_scope: reviewScopeSchema,
  context: z
    .json()
    .describe("Optional lower-priority caller metadata.")
    .optional(),
});

export const reviewRequestSchema = reviewRequestV2Schema;

const findingEvidenceSchema = z
  .strictObject({
    path: nonEmptyString.optional(),
    start_line: z.number().int().positive().optional(),
    end_line: z.number().int().positive().optional(),
    detail: nonEmptyString,
  })
  .superRefine((value, ctx) => {
    const hasStartLine = value.start_line !== undefined;
    const hasEndLine = value.end_line !== undefined;

    if ((hasStartLine || hasEndLine) && value.path === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "line ranges require a path",
      });
    }

    if (hasStartLine !== hasEndLine) {
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

const actionableFindingSchema = z.strictObject({
  id: nonEmptyString,
  severity: z.enum(["critical", "high", "medium", "low"]),
  title: nonEmptyString,
  description: nonEmptyString,
  evidence: z.array(findingEvidenceSchema).min(1),
  suggested_direction: nonEmptyString,
});

const informationalNoteSchema = z.strictObject({
  title: nonEmptyString,
  description: nonEmptyString,
});

export const reviewerResultSchema = z
  .strictObject({
    schema_version: protocolVersionSchema,
    verdict: z.enum(["pass", "fail"]),
    summary: nonEmptyString,
    actionable_findings: z.array(actionableFindingSchema),
    informational_notes: z.array(informationalNoteSchema),
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

export const reviewerPhaseSchema = z.enum([
  "queued",
  "probing",
  "starting",
  "reviewing",
  "validating",
  "terminal",
]);

const suiteSchema = z.strictObject({
  total: nonNegativeInteger,
  deferred: nonNegativeInteger,
  queued: nonNegativeInteger,
  running: nonNegativeInteger,
  completed: nonNegativeInteger,
  incomplete: nonNegativeInteger,
  skipped: nonNegativeInteger,
});

const reviewerTerminalRecordSchema = z.discriminatedUnion("status", [
  z.strictObject({
    reviewer_id: nonEmptyString,
    status: z.literal("completed"),
    adapter: nonEmptyString,
    model: nonEmptyString,
    isolation: isolationLevelSchema,
    elapsed_ms: nonNegativeInteger,
    result: reviewerResultSchema,
  }),
  z.strictObject({
    reviewer_id: nonEmptyString,
    status: z.literal("incomplete"),
    adapter: nonEmptyString,
    model: nonEmptyString,
    isolation: isolationLevelSchema.optional(),
    elapsed_ms: nonNegativeInteger,
    reason: incompleteReasonSchema,
    message: boundedMessage,
    retryable: z.boolean(),
  }),
  z.strictObject({
    reviewer_id: nonEmptyString,
    status: z.literal("skipped"),
    adapter: nonEmptyString,
    model: nonEmptyString,
    elapsed_ms: nonNegativeInteger,
    reason: z.enum(["prior_findings", "prior_incomplete"]),
    blocked_by_reviewer_id: nonEmptyString,
  }),
]);

const eventEnvelopeSchema = z.strictObject({
  schema_version: publicEventVersionSchema,
  event: z.string(),
  run_id: nonEmptyString,
  request_id: nonEmptyString.optional(),
  seq: z.number().int().positive(),
  timestamp: timestampSchema,
  reviewer_id: nonEmptyString.optional(),
  data: z.unknown(),
});

const suiteReviewerSchema = z.strictObject({
  id: nonEmptyString,
  agent_id: nonEmptyString,
  model_index: nonNegativeInteger,
  model_count: positiveInteger,
  previous_reviewer_id: nonEmptyString.optional(),
  activation: z.enum(["immediate", "after_clear_pass"]),
  purpose: nonEmptyString,
  adapter: nonEmptyString,
  adapter_type: adapterTypeSchema,
  model: nonEmptyString,
  effort: reasoningEffortSchema.optional(),
  isolation_policy: isolationPolicySchema,
  timeout_ms: positiveInteger,
  instruction_sources: z.array(nonEmptyString),
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
});

const runCompletedDataSchema = z
  .strictObject({
    status: runStatusSchema,
    exit_code: nonNegativeInteger,
    consistency_mode: consistencyModeSchema,
    total_elapsed_ms: nonNegativeInteger,
    suite: suiteSchema,
    reviewers: z.array(reviewerTerminalRecordSchema),
  })
  .superRefine((value, ctx) => {
    const hasIncomplete = value.reviewers.some(
      (reviewer) => reviewer.status === "incomplete",
    );
    const hasFindings = value.reviewers.some(
      (reviewer) =>
        reviewer.status === "completed" &&
        reviewer.result.actionable_findings.length > 0,
    );
    const expectedStatus = hasIncomplete
      ? "incomplete"
      : hasFindings
        ? "findings"
        : "passed";

    const terminalCounts = {
      completed: value.reviewers.filter(
        (reviewer) => reviewer.status === "completed",
      ).length,
      incomplete: value.reviewers.filter(
        (reviewer) => reviewer.status === "incomplete",
      ).length,
      skipped: value.reviewers.filter(
        (reviewer) => reviewer.status === "skipped",
      ).length,
    };

    if (
      value.suite.total !== value.reviewers.length ||
      value.suite.deferred !== 0 ||
      value.suite.queued !== 0 ||
      value.suite.running !== 0 ||
      value.suite.completed !== terminalCounts.completed ||
      value.suite.incomplete !== terminalCounts.incomplete ||
      value.suite.skipped !== terminalCounts.skipped
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "run.completed suite counts must match its terminal reviewer records",
      });
    }

    if (value.status !== expectedStatus) {
      ctx.addIssue({
        code: "custom",
        message: `run.completed status must be ${expectedStatus} for its reviewer terminal records`,
      });
    }
  });

const publicEventSchemas = [
  eventEnvelopeSchema.extend({
    event: z.literal("run.started"),
    data: z.strictObject({ consistency_mode: consistencyModeSchema }),
  }),
  eventEnvelopeSchema.extend({
    event: z.literal("context.resolved"),
    data: z.strictObject({ context: z.json() }),
  }),
  eventEnvelopeSchema.extend({
    event: z.literal("suite.resolved"),
    data: z.strictObject({
      total: nonNegativeInteger,
      execution: executionSchema,
      selection: suiteSelectionSchema.optional(),
      reviewers: z.array(suiteReviewerSchema),
    }),
  }),
  eventEnvelopeSchema.extend({
    event: z.literal("reviewer.started"),
    data: z.strictObject({
      purpose: nonEmptyString,
      adapter: nonEmptyString,
      model: nonEmptyString,
      effort: reasoningEffortSchema.optional(),
      isolation_policy: isolationPolicySchema,
      timeout_ms: positiveInteger,
    }),
  }),
  eventEnvelopeSchema.extend({
    event: z.literal("reviewer.progress"),
    data: z.strictObject({
      phase: reviewerPhaseSchema,
      message: boundedMessage.optional(),
    }),
  }),
  eventEnvelopeSchema.extend({
    event: z.literal("reviewer.heartbeat"),
    data: z.strictObject({
      phase: reviewerPhaseSchema,
      elapsed_ms: nonNegativeInteger,
      last_activity_at: timestampSchema.optional(),
      last_activity_message: boundedMessage.optional(),
      suite: suiteSchema,
      isolation: isolationLevelSchema.optional(),
    }),
  }),
  eventEnvelopeSchema.extend({
    event: z.literal("reviewer.completed"),
    data: z.strictObject({
      adapter: nonEmptyString,
      model: nonEmptyString,
      isolation: isolationLevelSchema,
      elapsed_ms: nonNegativeInteger,
      result: reviewerResultSchema,
    }),
  }),
  eventEnvelopeSchema.extend({
    event: z.literal("reviewer.incomplete"),
    data: z.strictObject({
      adapter: nonEmptyString,
      model: nonEmptyString,
      isolation: isolationLevelSchema.optional(),
      elapsed_ms: nonNegativeInteger,
      reason: incompleteReasonSchema,
      message: boundedMessage,
      retryable: z.boolean(),
    }),
  }),
  eventEnvelopeSchema.extend({
    event: z.literal("reviewer.skipped"),
    data: z.strictObject({
      adapter: nonEmptyString,
      model: nonEmptyString,
      elapsed_ms: nonNegativeInteger,
      reason: z.enum(["prior_findings", "prior_incomplete"]),
      blocked_by_reviewer_id: nonEmptyString,
    }),
  }),
  eventEnvelopeSchema.extend({
    event: z.literal("run.completed"),
    data: runCompletedDataSchema,
  }),
] as const;

export const publicEventSchema = z.discriminatedUnion(
  "event",
  publicEventSchemas,
);

export type ReviewRequest = z.infer<typeof reviewRequestSchema>;
export type ReviewerResult = z.infer<typeof reviewerResultSchema>;
export type PublicEvent = z.infer<typeof publicEventSchema>;
export type ReviewerPhase = z.infer<typeof reviewerPhaseSchema>;
export type ReviewerTerminalRecord = z.infer<
  typeof reviewerTerminalRecordSchema
>;
export type RunStatus = z.infer<typeof runStatusSchema>;
export type IsolationPolicy = z.infer<typeof isolationPolicySchema>;
export type IsolationLevel = z.infer<typeof isolationLevelSchema>;
export type IncompleteReason = z.infer<typeof incompleteReasonSchema>;
