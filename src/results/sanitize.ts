import {
  reviewerResultV3Schema,
  type ReviewerResultV3,
} from "../protocol/schemas.js";

export const MAX_REVIEWER_RESULT_BYTES = 16 * 1_024 * 1_024;

const REDACTED = "[redacted]";
const SENSITIVE_KEY = /token|secret|password|authorization|api[_-]?key/iu;

export class ResultSanitizationError extends Error {
  readonly code = "result_too_large" as const;
  readonly byteLength: number;
  readonly maximumBytes: number;

  constructor(byteLength: number, maximumBytes = MAX_REVIEWER_RESULT_BYTES) {
    super("The sanitized reviewer result exceeds the 16 MiB result limit.");
    this.name = "ResultSanitizationError";
    this.byteLength = byteLength;
    this.maximumBytes = maximumBytes;
  }
}

function redactString(value: string): string {
  return value
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu, "$1[redacted]@")
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gu,
      REDACTED,
    )
    .replace(
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
      REDACTED,
    )
    .replace(/\bauthorization\s*[:=]\s*bearer\s+[^\s,;]+/giu, REDACTED)
    .replace(
      /\b(?:authorization|api[_-]?key|access[_-]?token|client[_-]?secret|password|secret|accountkey)\s*[:=]\s*[^\s,;]+/giu,
      REDACTED,
    )
    .replace(
      /\b(?:DefaultEndpointsProtocol|AccountName|AccountKey|EndpointSuffix)=[^;\s]+(?:;[^\s]*)?/giu,
      REDACTED,
    )
    .replace(/\bBearer\s+[^\s,;]+/giu, REDACTED)
    .replace(/(https?:\/\/[^\s/?#]+\/[^\s?#]*)\?[^\s#]*/giu, "$1?[redacted]");
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (typeof value === "object") {
    const sanitized = Object.create(null) as Record<string, unknown>;
    for (const [key, child] of Object.entries(value)) {
      sanitized[key] = SENSITIVE_KEY.test(key) ? REDACTED : sanitizeValue(child);
    }
    return sanitized;
  }
  return null;
}

export function sanitizeReviewerResult(value: unknown): ReviewerResultV3 {
  const sanitized = reviewerResultV3Schema.parse(sanitizeValue(value));
  const byteLength = Buffer.byteLength(JSON.stringify(sanitized), "utf8");
  if (byteLength > MAX_REVIEWER_RESULT_BYTES) {
    throw new ResultSanitizationError(byteLength);
  }
  return sanitized;
}
