import {
  reviewerResultV3Schema,
  type ReviewerResultV3,
} from "../protocol/schemas.js";

export const MAX_REVIEWER_RESULT_BYTES = 16 * 1_024 * 1_024;

const REDACTED = "[redacted]";
const SENSITIVE_KEY = /token|secret|password|authorization|api[_-]?key/iu;
const SENSITIVE_QUERY_KEY =
  /^(?:api[_-]?key|access[_-]?token|authorization|auth|client[_-]?secret|password|secret|accountkey)$/iu;
const SENSITIVE_QUERY_VALUE =
  /^(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|Bearer\s+\S+)$/iu;

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
  const urls: string[] = [];
  const withoutUrls = value.replace(/https?:\/\/[^\s]+/giu, (candidate) => {
    const queryStart = candidate.indexOf("?");
    const fragmentStart = candidate.indexOf("#");
    const queryEnd = fragmentStart < 0 ? candidate.length : fragmentStart;
    const prefix = queryStart < 0 ? candidate : candidate.slice(0, queryStart);
    const query =
      queryStart < 0 ? undefined : candidate.slice(queryStart + 1, queryEnd);
    const fragment = fragmentStart < 0 ? "" : candidate.slice(fragmentStart);
    const redactedPrefix = prefix.replace(
      /^(https?:\/\/)[^\s/@:]+:[^\s/@]+@/iu,
      "$1[redacted]@",
    );
    const redactedQuery =
      query === undefined
        ? ""
        : `?${query
            .split("&")
            .map((part) => {
              const separator = part.indexOf("=");
              const rawKey = separator < 0 ? part : part.slice(0, separator);
              let key = rawKey;
              try {
                key = decodeURIComponent(rawKey.replaceAll("+", " "));
              } catch {
                // Malformed untrusted query keys remain unchanged.
              }
              const rawValue = separator < 0 ? "" : part.slice(separator + 1);
              let queryValue = rawValue;
              try {
                queryValue = decodeURIComponent(rawValue.replaceAll("+", " "));
              } catch {
                // Malformed untrusted query values remain unchanged.
              }
              if (
                !SENSITIVE_QUERY_KEY.test(key) &&
                !SENSITIVE_QUERY_VALUE.test(queryValue)
              ) {
                return part;
              }
              return `${rawKey}=${REDACTED}`;
            })
            .join("&")}`;
    const redactedUrl = `${redactedPrefix}${redactedQuery}${fragment}`;
    const index = urls.push(redactedUrl) - 1;
    return `\uE000${index}\uE001`;
  });
  const redacted = withoutUrls
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
    .replace(/\bBearer\s+[^\s,;]+/giu, REDACTED);
  return redacted.replace(/\uE000(\d+)\uE001/gu, (_marker, index: string) => {
    return urls[Number(index)] ?? _marker;
  });
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
      sanitized[key] = SENSITIVE_KEY.test(key)
        ? REDACTED
        : sanitizeValue(child);
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
