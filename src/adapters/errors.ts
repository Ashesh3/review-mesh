import type { IncompleteReason } from "../protocol/schemas.js";

const MAX_MESSAGE_LENGTH = 1_000;
const MAX_FAILURE_STAGE_LENGTH = 64;
const MAX_DIAGNOSTIC_LABEL_LENGTH = 128;
const MAX_PROVIDER_REQUEST_ID_LENGTH = 256;
const MAX_CONTENT_TYPES = 32;
const SECRET_PATTERNS = [
  /(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi,
  /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gi,
  /\bauthorization\s*[:=]\s*bearer\s+[^\s,;]+/gi,
  /\b(?:api[_-]?key|access[_-]?token|auth(?:orization)?|client[_-]?secret|password|secret|accountkey)\s*[:=]\s*[^\s,;]+/gi,
  /\b(?:DefaultEndpointsProtocol|AccountName|AccountKey|EndpointSuffix)=[^;\s]+(?:;[^\s]*)?/gi,
  /\bBearer\s+[^\s,;]+/gi,
];

export type AdapterFailureScope =
  "run_input" | "adapter" | "provider" | "model";
export type AdapterRepairOutcome = "not_attempted" | "succeeded" | "failed";

/** Bounded, provider-independent diagnostics that are safe to persist. */
export interface AdapterFailureDiagnostics {
  failure_stage?: string;
  scope?: AdapterFailureScope;
  http_status?: number;
  provider_request_id?: string;
  finish_reason?: string;
  content_types?: string[];
  response_bytes?: number;
  truncated?: boolean;
  repair_attempted?: boolean;
  repair_outcome?: AdapterRepairOutcome;
}

export interface AdapterFailureOptions {
  fallback_eligible?: boolean;
  diagnostics?: Partial<AdapterFailureDiagnostics>;
}

/** A provider-independent, safe-to-publish adapter failure. */
export interface AdapterFailure {
  reason: IncompleteReason;
  message: string;
  retryable: boolean;
  /** Whether another configured model/provider may recover this logical review. */
  fallback_eligible?: boolean;
  diagnostics?: AdapterFailureDiagnostics;
}

const defaultFallbackEligibility: Record<IncompleteReason, boolean> = {
  adapter_unavailable: true,
  authentication_failed: true,
  model_unavailable: true,
  read_failure: false,
  timeout: true,
  process_crashed: true,
  protocol_violation: true,
  invalid_result: true,
  cancelled: false,
  unknown: true,
};

function sanitizedText(
  value: unknown,
  maximumLength: number,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
  if (normalized.length === 0) return undefined;
  return SECRET_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, "[redacted]"),
    normalized,
  ).slice(0, maximumLength);
}

/** Redacts credential-shaped values and bounds text before public emission. */
export function sanitizePublicText(
  value: unknown,
  maximumLength = MAX_MESSAGE_LENGTH,
): string | undefined {
  if (!Number.isSafeInteger(maximumLength) || maximumLength < 1) {
    throw new Error("maximumLength must be a positive safe integer");
  }
  return sanitizedText(value, maximumLength);
}

function finiteInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : undefined;
}

function sanitizeDiagnostics(
  input: Partial<AdapterFailureDiagnostics> | undefined,
): AdapterFailureDiagnostics | undefined {
  if (input === undefined) return undefined;
  const failureStage = sanitizedText(
    input.failure_stage,
    MAX_FAILURE_STAGE_LENGTH,
  );
  const providerRequestId = sanitizedText(
    input.provider_request_id,
    MAX_PROVIDER_REQUEST_ID_LENGTH,
  );
  const finishReason = sanitizedText(
    input.finish_reason,
    MAX_DIAGNOSTIC_LABEL_LENGTH,
  );
  const httpStatus = finiteInteger(input.http_status, 100, 599);
  const responseBytes = finiteInteger(
    input.response_bytes,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const scope =
    input.scope === "run_input" ||
    input.scope === "adapter" ||
    input.scope === "provider" ||
    input.scope === "model"
      ? input.scope
      : undefined;
  const repairOutcome =
    input.repair_outcome === "not_attempted" ||
    input.repair_outcome === "succeeded" ||
    input.repair_outcome === "failed"
      ? input.repair_outcome
      : undefined;
  const contentTypes = Array.isArray(input.content_types)
    ? [
        ...new Set(
          input.content_types
            .slice(0, MAX_CONTENT_TYPES)
            .map((value) => sanitizedText(value, MAX_DIAGNOSTIC_LABEL_LENGTH))
            .filter((value): value is string => value !== undefined),
        ),
      ]
    : undefined;
  const diagnostics: AdapterFailureDiagnostics = {
    ...(failureStage === undefined ? {} : { failure_stage: failureStage }),
    ...(scope === undefined ? {} : { scope }),
    ...(httpStatus === undefined ? {} : { http_status: httpStatus }),
    ...(providerRequestId === undefined
      ? {}
      : { provider_request_id: providerRequestId }),
    ...(finishReason === undefined ? {} : { finish_reason: finishReason }),
    ...(contentTypes === undefined || contentTypes.length === 0
      ? {}
      : { content_types: contentTypes }),
    ...(responseBytes === undefined ? {} : { response_bytes: responseBytes }),
    ...(typeof input.truncated === "boolean"
      ? { truncated: input.truncated }
      : {}),
    ...(typeof input.repair_attempted === "boolean"
      ? { repair_attempted: input.repair_attempted }
      : {}),
    ...(repairOutcome === undefined ? {} : { repair_outcome: repairOutcome }),
  };
  return Object.keys(diagnostics).length === 0 ? undefined : diagnostics;
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
  options: AdapterFailureOptions = {},
): AdapterFailure {
  const sanitized =
    sanitizePublicText(message) ??
    "Adapter failed without a safe diagnostic message.";
  const diagnostics = sanitizeDiagnostics(options.diagnostics);
  const fallbackEligible =
    options.fallback_eligible ?? defaultFallbackEligibility[reason] ?? false;

  return {
    reason,
    message: sanitized,
    retryable,
    fallback_eligible: fallbackEligible,
    ...(diagnostics === undefined ? {} : { diagnostics }),
  };
}

export const adapterFailure = {
  unavailable: (
    message: unknown,
    retryable = false,
    options?: AdapterFailureOptions,
  ): AdapterFailure =>
    sanitizeAdapterFailure("adapter_unavailable", message, retryable, options),
  authentication: (
    message: unknown,
    retryable = false,
    options?: AdapterFailureOptions,
  ): AdapterFailure =>
    sanitizeAdapterFailure(
      "authentication_failed",
      message,
      retryable,
      options,
    ),
  modelUnavailable: (
    message: unknown,
    retryable = false,
    options?: AdapterFailureOptions,
  ): AdapterFailure =>
    sanitizeAdapterFailure("model_unavailable", message, retryable, options),
  read: (
    message: unknown,
    retryable = false,
    options?: AdapterFailureOptions,
  ): AdapterFailure =>
    sanitizeAdapterFailure("read_failure", message, retryable, options),
  timeout: (
    message: unknown,
    retryable = true,
    options?: AdapterFailureOptions,
  ): AdapterFailure =>
    sanitizeAdapterFailure("timeout", message, retryable, options),
  processCrashed: (
    message: unknown,
    retryable = false,
    options?: AdapterFailureOptions,
  ): AdapterFailure =>
    sanitizeAdapterFailure("process_crashed", message, retryable, options),
  protocolViolation: (
    message: unknown,
    retryable = false,
    options?: AdapterFailureOptions,
  ): AdapterFailure =>
    sanitizeAdapterFailure("protocol_violation", message, retryable, options),
  invalidResult: (
    message: unknown,
    retryable = false,
    options?: AdapterFailureOptions,
  ): AdapterFailure =>
    sanitizeAdapterFailure("invalid_result", message, retryable, options),
  cancelled: (
    message: unknown = "Review was cancelled.",
    options?: AdapterFailureOptions,
  ): AdapterFailure =>
    sanitizeAdapterFailure("cancelled", message, false, {
      ...options,
      fallback_eligible: false,
    }),
  unknown: (
    message: unknown,
    retryable = false,
    options?: AdapterFailureOptions,
  ): AdapterFailure =>
    sanitizeAdapterFailure("unknown", message, retryable, options),
} as const;
