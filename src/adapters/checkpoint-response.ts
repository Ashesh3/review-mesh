import { createHash } from "node:crypto";
import { z } from "zod";
import {
  sanitizeAdapterFailure,
  type AdapterFailure,
  type AdapterFailureDiagnostics,
  type AdapterValidationIssue,
} from "./errors.js";

const MAX_CHECKPOINT_BYTES = 256 * 1024;
const ISSUE_FIELDS = new Set(
  "summary findings unresolved_questions resolved_question_ids follow_up_reads scenario_checks id question path kind offset byte_count start_line end_line input expected observed reasoning finding_id severity title description evidence detail suggested_direction confidence classification external_assumptions root_issue_id duplicate_of duplicate_finding_ids category verification change_impact claim trigger affected_behavior outcome".split(
    " ",
  ),
);

function checkpointIssueMessage(issue: z.core.$ZodIssue): string {
  if (issue.code === "too_small" || issue.code === "too_big") {
    const limit = issue.code === "too_small" ? issue.minimum : issue.maximum;
    const relation =
      issue.code === "too_small"
        ? issue.inclusive === false
          ? "more than"
          : "at least"
        : issue.inclusive === false
          ? "fewer than"
          : "at most";
    // These are schema constants, never rejected user/model values.
    if (
      typeof limit === "number" &&
      Number.isSafeInteger(limit) &&
      limit >= 0 &&
      limit <= 1_000_000_000
    ) {
      if (issue.origin === "string")
        return `Must contain ${relation} ${limit} ${limit === 1 ? "character" : "characters"}.`;
      if (issue.origin === "array")
        return `Must contain ${relation} ${limit} ${limit === 1 ? "item" : "items"}.`;
      return `Must be ${relation} ${limit}.`;
    }
    return issue.code === "too_small"
      ? "Required field or collection is below its minimum."
      : "Field or collection exceeds its maximum.";
  }
  return issue.code === "invalid_type"
    ? "Field has an invalid or missing type."
    : issue.code === "unrecognized_keys"
      ? "Object contains unsupported fields."
      : "Field does not satisfy the checkpoint schema.";
}

export function checkpointIssues(error: z.ZodError): AdapterValidationIssue[] {
  return error.issues.slice(0, 12).map((issue) => ({
    path:
      "$" +
      issue.path
        .map((part) =>
          typeof part === "number"
            ? `[${part}]`
            : `.${ISSUE_FIELDS.has(String(part)) ? String(part) : "field"}`,
        )
        .join(""),
    code: issue.code,
    message: checkpointIssueMessage(issue),
  }));
}

export function checkpointFailure(
  stage: string,
  message: string,
  diagnostics: AdapterFailureDiagnostics,
  issues?: AdapterValidationIssue[],
): AdapterFailure {
  const code =
    stage === "checkpoint_truncation"
      ? "output_truncated"
      : "provider_response_invalid";
  return sanitizeAdapterFailure(code, message, false, {
    fallback_eligible: true,
    circuit_qualifying: false,
    diagnostics: {
      ...diagnostics,
      failure_code: code,
      failure_stage: stage,
      scope: "model",
      ...(issues === undefined ? {} : { validation_issues: issues }),
    },
  });
}

/** Normalize only supported text representations. Diagnostics never include
 * raw model text, schema values, quoted source, or parser exception messages. */
export function parseCheckpointResponse(
  content: unknown,
  diagnostics: AdapterFailureDiagnostics,
): {
  value?: unknown;
  diagnostics: AdapterFailureDiagnostics;
  failure?: AdapterFailure;
} {
  const validParts =
    Array.isArray(content) &&
    content.length <= 1024 &&
    content.every(
      (part) =>
        part !== null &&
        typeof part === "object" &&
        typeof part.text === "string" &&
        (part.type === undefined || part.type === "text"),
    );
  const text =
    typeof content === "string"
      ? content
      : validParts
        ? content.map((part) => part.text).join("")
        : undefined;
  const serialized = text ?? JSON.stringify(content ?? null);
  const details: AdapterFailureDiagnostics = {
    ...diagnostics,
    model_output_truncated: diagnostics.finish_reason === "length",
    response_bytes: Buffer.byteLength(serialized, "utf8"),
    response_fingerprint: createHash("sha256").update(serialized).digest("hex"),
    content_types: [
      text === undefined
        ? content === null || content === undefined
          ? "assistant:empty"
          : "assistant:unsupported_content"
        : validParts
          ? "assistant:text_parts"
          : "assistant:text",
    ],
  };
  const failure = (stage: string, message: string) => ({
    diagnostics: details,
    failure: checkpointFailure(stage, message, details),
  });
  if (diagnostics.finish_reason === "content_filter")
    return failure(
      "checkpoint_filter",
      "The provider filtered the segment checkpoint.",
    );
  if (details.response_bytes! > MAX_CHECKPOINT_BYTES)
    return failure(
      "checkpoint_schema",
      "The segment checkpoint exceeds its response byte limit.",
    );
  const truncated =
    diagnostics.finish_reason === "length"
      ? failure(
          "checkpoint_truncation",
          "The provider truncated the segment checkpoint at its output limit.",
        )
      : undefined;
  if (text === undefined || text.trim() === "")
    return (
      truncated ??
      failure(
        "checkpoint_content",
        "The segment checkpoint contains no supported text content.",
      )
    );
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/iu.exec(trimmed);
  try {
    return {
      value: JSON.parse(fenced?.[1] ?? trimmed),
      diagnostics: details,
      ...(truncated?.failure ? { failure: truncated.failure } : {}),
    };
  } catch {
    return (
      truncated ??
      failure("checkpoint_json", "The segment checkpoint is not valid JSON.")
    );
  }
}
