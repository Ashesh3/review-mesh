import type { IncompleteReason } from "../protocol/schemas.js";

const MAX_MESSAGE_LENGTH = 1_000;
const SECRET_PATTERNS = [
  /\bauthorization\s*[:=]\s*bearer\s+[^\s,;]+/gi,
  /\b(?:api[_-]?key|access[_-]?token|auth(?:orization)?|password|secret)\s*[:=]\s*[^\s,;]+/gi,
  /\bBearer\s+[^\s,;]+/gi,
];

/** A provider-independent, safe-to-publish adapter failure. */
export interface AdapterFailure {
  reason: IncompleteReason;
  message: string;
  retryable: boolean;
}

/**
 * Removes common credential-shaped fragments and bounds text before it can be
 * emitted in the public protocol. Adapters choose the stable reason first;
 * this helper deliberately never classifies provider text.
 */
export function sanitizeAdapterFailure(
  reason: IncompleteReason,
  message: unknown,
  retryable = false,
): AdapterFailure {
  const text =
    typeof message === "string" && message.trim().length > 0
      ? message.trim()
      : "Adapter failed without a safe diagnostic message.";
  const sanitized = SECRET_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, "[redacted]"),
    text,
  ).slice(0, MAX_MESSAGE_LENGTH);

  return { reason, message: sanitized, retryable };
}

export const adapterFailure = {
  unavailable: (message: unknown, retryable = false): AdapterFailure =>
    sanitizeAdapterFailure("adapter_unavailable", message, retryable),
  authentication: (message: unknown, retryable = false): AdapterFailure =>
    sanitizeAdapterFailure("authentication_failed", message, retryable),
  modelUnavailable: (message: unknown, retryable = false): AdapterFailure =>
    sanitizeAdapterFailure("model_unavailable", message, retryable),
  read: (message: unknown, retryable = false): AdapterFailure =>
    sanitizeAdapterFailure("read_failure", message, retryable),
  timeout: (message: unknown, retryable = true): AdapterFailure =>
    sanitizeAdapterFailure("timeout", message, retryable),
  processCrashed: (message: unknown, retryable = false): AdapterFailure =>
    sanitizeAdapterFailure("process_crashed", message, retryable),
  protocolViolation: (message: unknown, retryable = false): AdapterFailure =>
    sanitizeAdapterFailure("protocol_violation", message, retryable),
  invalidResult: (message: unknown, retryable = false): AdapterFailure =>
    sanitizeAdapterFailure("invalid_result", message, retryable),
  cancelled: (message: unknown = "Review was cancelled."): AdapterFailure =>
    sanitizeAdapterFailure("cancelled", message, false),
  unknown: (message: unknown, retryable = false): AdapterFailure =>
    sanitizeAdapterFailure("unknown", message, retryable),
} as const;
