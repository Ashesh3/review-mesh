import {
  adjudicationResultV2Schema,
  currentReviewerOutputSchema,
  providerReviewerResultV4Schema,
  reviewerResultV4Schema,
  reviewerResultV3Schema,
  type AdjudicationResultV2,
  type CurrentReviewerOutput,
  type ProviderReviewerResultV4,
  type ReviewerResultV4,
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
  const shielded = value.replace(/https?:\/\/[^\s]+/giu, (candidate) => {
    const queryStart = candidate.indexOf("?");
    const fragmentStart = candidate.indexOf("#");
    const pathEnd =
      queryStart < 0
        ? fragmentStart < 0
          ? candidate.length
          : fragmentStart
        : queryStart;
    const queryEnd = fragmentStart < 0 ? candidate.length : fragmentStart;
    const path = candidate.slice(0, pathEnd);
    const query =
      queryStart < 0 ? undefined : candidate.slice(queryStart + 1, queryEnd);
    const fragment =
      fragmentStart < 0 ? undefined : candidate.slice(fragmentStart + 1);
    const redactedQuery =
      query === undefined
        ? ""
        : `?${query
            .split("&")
            .map((part) => {
              const separator = part.indexOf("=");
              const rawKey = separator < 0 ? part : part.slice(0, separator);
              const rawValue = separator < 0 ? "" : part.slice(separator + 1);
              let key = rawKey;
              let queryValue = rawValue;
              try {
                key = decodeURIComponent(rawKey.replaceAll("+", " "));
              } catch {
                // Malformed untrusted query keys remain unchanged.
              }
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
    const redactedFragment =
      fragment === undefined ? "" : `#${redactUrlFragment(fragment)}`;
    const redactedUrl = `${redactUrlPath(path)}${redactedQuery}${redactedFragment}`;
    const index = urls.push(redactedUrl) - 1;
    return `\uE000${index}\uE001`;
  });
  return redactCredentialPatterns(shielded).replace(
    /\uE000(\d+)\uE001/gu,
    (marker, index: string) => urls[Number(index)] ?? marker,
  );
}

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function redactUrlPath(value: string): string {
  const schemeEnd = value.indexOf("://");
  const pathStart = schemeEnd < 0 ? -1 : value.indexOf("/", schemeEnd + 3);
  if (pathStart < 0) return redactCredentialPatterns(value);
  const authority = redactCredentialPatterns(value.slice(0, pathStart));
  const path = value
    .slice(pathStart)
    .split("/")
    .map((segment) => {
      if (segment.length === 0) return segment;
      const decodedSegment = decoded(segment);
      return redactCredentialPatterns(decodedSegment) === decodedSegment
        ? segment
        : REDACTED;
    })
    .join("/");
  return authority + path;
}

function redactUrlFragment(value: string): string {
  const redacted = redactCredentialPatterns(value);
  if (redacted !== value) return redacted;
  const decodedValue = decoded(value);
  return redactCredentialPatterns(decodedValue) === decodedValue
    ? value
    : REDACTED;
}

function redactCredentialPatterns(value: string): string {
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
      /\b(?:authorization|api[_-]?key|access[_-]?token|client[_-]?secret|password|secret|accountkey|token)\s*[:=]\s*[^\s,;/#]+/giu,
      REDACTED,
    )
    .replace(
      /\b(?:DefaultEndpointsProtocol|AccountName|AccountKey|EndpointSuffix)=[^;\s]+(?:;[^\s]*)?/giu,
      REDACTED,
    )
    .replace(/\bBearer(?:%20|\s)+[^\s,;#]+/giu, REDACTED);
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

/** Lossless credential redaction for private metadata; never truncates text. */
export function sanitizeRunMetadata(value: unknown): unknown {
  return sanitizeValue(value);
}

export function sanitizeReviewerResult(value: unknown): ReviewerResultV3 {
  const sanitized = reviewerResultV3Schema.parse(sanitizeValue(value));
  const byteLength = Buffer.byteLength(JSON.stringify(sanitized), "utf8");
  if (byteLength > MAX_REVIEWER_RESULT_BYTES) {
    throw new ResultSanitizationError(byteLength);
  }
  return sanitized;
}

export function sanitizeCurrentReviewerOutput(
  value: unknown,
): CurrentReviewerOutput {
  const sanitized = currentReviewerOutputSchema.parse(sanitizeValue(value));
  const byteLength = Buffer.byteLength(JSON.stringify(sanitized), "utf8");
  if (byteLength > MAX_REVIEWER_RESULT_BYTES) {
    throw new ResultSanitizationError(byteLength);
  }
  return sanitized;
}

export type V9ReviewerOutput =
  ProviderReviewerResultV4 | ReviewerResultV4 | AdjudicationResultV2;

export function sanitizeReviewerOutput(value: unknown): V9ReviewerOutput {
  const sanitizedValue = sanitizeValue(value);
  const parsed = providerReviewerResultV4Schema.safeParse(sanitizedValue);
  const sanitized = parsed.success
    ? parsed.data
    : reviewerResultV4Schema
        .or(adjudicationResultV2Schema)
        .parse(sanitizedValue);
  const byteLength = Buffer.byteLength(JSON.stringify(sanitized), "utf8");
  if (byteLength > MAX_REVIEWER_RESULT_BYTES) {
    throw new ResultSanitizationError(byteLength);
  }
  return sanitized;
}
