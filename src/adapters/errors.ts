import type { IncompleteReason } from "../protocol/schemas.js";
import type { V9IncompleteReason } from "../protocol/v9.js";

const MAX_MESSAGE_LENGTH = 1_000;
const MAX_FAILURE_STAGE_LENGTH = 64;
const MAX_DIAGNOSTIC_LABEL_LENGTH = 128;
const MAX_PROVIDER_REQUEST_ID_LENGTH = 256;
const MAX_CONTENT_TYPES = 32;
const MAX_CORRELATION_HEADERS = 8;
const MAX_VALIDATION_ISSUES = 12;
const MAX_STRUCTURE_KEYS = 32;
const MAX_DIAGNOSTIC_PATH_LENGTH = 256;
const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 256;
const MAX_RETRY_AFTER_MS = 60_000;
const FAILURE_CODES = new Set<AdapterFailureCode>([
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
]);
const CORRELATION_HEADER_NAMES = new Set([
  "x-request-id",
  "request-id",
  "x-correlation-id",
  "trace-id",
  "cf-ray",
  "traceparent",
]);
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
export type AdapterFailureCode =
  | "rate_limited"
  | "provider_unavailable"
  | "gateway_timeout"
  | "provider_response_invalid"
  | "output_truncated"
  | "request_timeout"
  | "transport_error"
  | "response_too_large"
  | "streaming_unsupported"
  | "result_page_too_large"
  | "structured_page_limit_exceeded";

export type AdapterRetryOutcome = "not_attempted" | "succeeded" | "exhausted";

export interface AdapterValidationIssue {
  path: string;
  code: string;
  message: string;
  expected_max_bytes?: number;
  actual_bytes?: number;
  unknown_keys?: string[];
}

export interface AdapterResponseStructure {
  root_type: string;
  top_level_keys?: string[];
  choices_count?: number;
  first_choice_type?: string;
  first_choice_keys?: string[];
  message_type?: string;
  message_keys?: string[];
}

/** Bounded, provider-independent diagnostics that are safe to persist. */
export interface AdapterFailureDiagnostics {
  failure_code?: AdapterFailureCode;
  failure_stage?: string;
  scope?: AdapterFailureScope;
  http_status?: number;
  provider_request_id?: string;
  retry_after_ms?: number;
  correlation_headers?: Record<string, string>;
  retry_blocked_by_circuit?: boolean;
  circuit_caused_by_reviewer_id?: string;
  finish_reason?: string;
  content_types?: string[];
  response_bytes?: number;
  response_fingerprint?: string;
  response_structure?: AdapterResponseStructure;
  validation_issues?: AdapterValidationIssue[];
  truncated?: boolean;
  repair_attempted?: boolean;
  repair_outcome?: AdapterRepairOutcome;
  attempt_count?: number;
  retry_outcome?: AdapterRetryOutcome;
  checkpoint_id?: string;
  artifact_ref?: string;
  recommended_action?: string;
}

export interface AdapterFailureOptions {
  fallback_eligible?: boolean;
  circuit_qualifying?: boolean;
  diagnostics?: Partial<AdapterFailureDiagnostics>;
}

/** A provider-independent, safe-to-publish adapter failure. */
export interface AdapterFailure {
  reason: IncompleteReason | V9IncompleteReason;
  message: string;
  retryable: boolean;
  /** Whether another configured model/provider may recover this logical review. */
  fallback_eligible?: boolean;
  /** Whether this failure is evidence for provider-wide circuit health. */
  circuit_qualifying?: boolean;
  diagnostics?: AdapterFailureDiagnostics;
}

const defaultFallbackEligibility: Partial<
  Record<IncompleteReason | V9IncompleteReason, boolean>
> = {
  adapter_unavailable: true,
  authentication_failed: true,
  model_unavailable: true,
  read_failure: false,
  queue_deadline_exceeded: true,
  probe_deadline_exceeded: true,
  attempt_deadline_exceeded: true,
  model_candidate_deadline_exceeded: true,
  no_progress_timeout: true,
  lens_deadline_exceeded: true,
  run_deadline_exceeded: false,
  structured_page_limit_exceeded: true,
  result_page_too_large: true,
  output_truncated: true,
  provider_response_invalid: true,
  timeout: true,
  process_crashed: true,
  protocol_violation: true,
  invalid_result: true,
  result_too_large: true,
  persistence_failed: false,
  change_coverage_incomplete: true,
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
  const circuitCausedByReviewerId = sanitizedText(
    input.circuit_caused_by_reviewer_id,
    MAX_PROVIDER_REQUEST_ID_LENGTH,
  );
  const httpStatus = finiteInteger(input.http_status, 100, 599);
  const retryAfterMs = finiteInteger(
    input.retry_after_ms,
    0,
    MAX_RETRY_AFTER_MS,
  );
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
  const attemptCount = finiteInteger(input.attempt_count, 1, 100);
  const retryOutcome =
    input.retry_outcome === "not_attempted" ||
    input.retry_outcome === "succeeded" ||
    input.retry_outcome === "exhausted"
      ? input.retry_outcome
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
  const failureCode =
    typeof input.failure_code === "string" &&
    FAILURE_CODES.has(input.failure_code as AdapterFailureCode)
      ? (input.failure_code as AdapterFailureCode)
      : undefined;
  const correlationHeaders =
    input.correlation_headers !== undefined &&
    typeof input.correlation_headers === "object" &&
    input.correlation_headers !== null &&
    !Array.isArray(input.correlation_headers)
      ? Object.fromEntries(
          Object.entries(input.correlation_headers)
            .filter(([name]) =>
              CORRELATION_HEADER_NAMES.has(name.toLowerCase()),
            )
            .slice(0, MAX_CORRELATION_HEADERS)
            .flatMap(([name, value]) => {
              const sanitized = sanitizedText(
                value,
                MAX_PROVIDER_REQUEST_ID_LENGTH,
              );
              return sanitized === undefined
                ? []
                : [[name.toLowerCase(), sanitized]];
            }),
        )
      : undefined;
  const validationIssues = Array.isArray(input.validation_issues)
    ? input.validation_issues
        .slice(0, MAX_VALIDATION_ISSUES)
        .flatMap((issue): AdapterValidationIssue[] => {
          if (typeof issue !== "object" || issue === null) return [];
          const path = sanitizedText(issue.path, MAX_DIAGNOSTIC_PATH_LENGTH);
          const code = sanitizedText(issue.code, MAX_FAILURE_STAGE_LENGTH);
          const message = sanitizedText(
            issue.message,
            MAX_DIAGNOSTIC_MESSAGE_LENGTH,
          );
          return path === undefined ||
            code === undefined ||
            message === undefined
            ? []
            : [
                {
                  path,
                  code,
                  message,
                  ...(finiteInteger(
                    issue.expected_max_bytes,
                    0,
                    Number.MAX_SAFE_INTEGER,
                  ) === undefined
                    ? {}
                    : { expected_max_bytes: issue.expected_max_bytes }),
                  ...(finiteInteger(
                    issue.actual_bytes,
                    0,
                    Number.MAX_SAFE_INTEGER,
                  ) === undefined
                    ? {}
                    : { actual_bytes: issue.actual_bytes }),
                  ...(sanitizeStructureKeys(issue.unknown_keys) === undefined
                    ? {}
                    : {
                        unknown_keys: sanitizeStructureKeys(
                          issue.unknown_keys,
                        )!,
                      }),
                },
              ];
        })
    : undefined;
  const responseFingerprint =
    typeof input.response_fingerprint === "string" &&
    /^[a-f0-9]{64}$/u.test(input.response_fingerprint)
      ? input.response_fingerprint
      : undefined;
  const responseStructure = sanitizeResponseStructure(input.response_structure);
  const diagnostics: AdapterFailureDiagnostics = {
    ...(sanitizedText(input.checkpoint_id, 256) === undefined
      ? {}
      : { checkpoint_id: sanitizedText(input.checkpoint_id, 256)! }),
    ...(sanitizedText(input.artifact_ref, 4096) === undefined
      ? {}
      : { artifact_ref: sanitizedText(input.artifact_ref, 4096)! }),
    ...(sanitizedText(input.recommended_action, 256) === undefined
      ? {}
      : { recommended_action: sanitizedText(input.recommended_action, 256)! }),
    ...(failureCode === undefined ? {} : { failure_code: failureCode }),
    ...(failureStage === undefined ? {} : { failure_stage: failureStage }),
    ...(scope === undefined ? {} : { scope }),
    ...(httpStatus === undefined ? {} : { http_status: httpStatus }),
    ...(providerRequestId === undefined
      ? {}
      : { provider_request_id: providerRequestId }),
    ...(retryAfterMs === undefined ? {} : { retry_after_ms: retryAfterMs }),
    ...(correlationHeaders === undefined ||
    Object.keys(correlationHeaders).length === 0
      ? {}
      : { correlation_headers: correlationHeaders }),
    ...(typeof input.retry_blocked_by_circuit === "boolean"
      ? { retry_blocked_by_circuit: input.retry_blocked_by_circuit }
      : {}),
    ...(circuitCausedByReviewerId === undefined
      ? {}
      : { circuit_caused_by_reviewer_id: circuitCausedByReviewerId }),
    ...(finishReason === undefined ? {} : { finish_reason: finishReason }),
    ...(contentTypes === undefined || contentTypes.length === 0
      ? {}
      : { content_types: contentTypes }),
    ...(responseBytes === undefined ? {} : { response_bytes: responseBytes }),
    ...(responseFingerprint === undefined
      ? {}
      : { response_fingerprint: responseFingerprint }),
    ...(responseStructure === undefined
      ? {}
      : { response_structure: responseStructure }),
    ...(validationIssues === undefined || validationIssues.length === 0
      ? {}
      : { validation_issues: validationIssues }),
    ...(typeof input.truncated === "boolean"
      ? { truncated: input.truncated }
      : {}),
    ...(typeof input.repair_attempted === "boolean"
      ? { repair_attempted: input.repair_attempted }
      : {}),
    ...(repairOutcome === undefined ? {} : { repair_outcome: repairOutcome }),
    ...(attemptCount === undefined ? {} : { attempt_count: attemptCount }),
    ...(retryOutcome === undefined ? {} : { retry_outcome: retryOutcome }),
  };
  return Object.keys(diagnostics).length === 0 ? undefined : diagnostics;
}

function sanitizeStructureKeys(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const keys = [
    ...new Set(
      value
        .slice(0, MAX_STRUCTURE_KEYS)
        .map((key) => sanitizedText(key, MAX_DIAGNOSTIC_LABEL_LENGTH))
        .filter((key): key is string => key !== undefined),
    ),
  ];
  return keys.length === 0 ? undefined : keys;
}

function sanitizeResponseStructure(
  input: AdapterResponseStructure | undefined,
): AdapterResponseStructure | undefined {
  if (input === undefined || typeof input !== "object" || input === null) {
    return undefined;
  }
  const rootType = sanitizedText(input.root_type, MAX_DIAGNOSTIC_LABEL_LENGTH);
  if (rootType === undefined) return undefined;
  const topLevelKeys = sanitizeStructureKeys(input.top_level_keys);
  const firstChoiceKeys = sanitizeStructureKeys(input.first_choice_keys);
  const messageKeys = sanitizeStructureKeys(input.message_keys);
  const choicesCount = finiteInteger(
    input.choices_count,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const firstChoiceType = sanitizedText(
    input.first_choice_type,
    MAX_DIAGNOSTIC_LABEL_LENGTH,
  );
  const messageType = sanitizedText(
    input.message_type,
    MAX_DIAGNOSTIC_LABEL_LENGTH,
  );
  return {
    root_type: rootType,
    ...(topLevelKeys === undefined ? {} : { top_level_keys: topLevelKeys }),
    ...(choicesCount === undefined ? {} : { choices_count: choicesCount }),
    ...(firstChoiceType === undefined
      ? {}
      : { first_choice_type: firstChoiceType }),
    ...(firstChoiceKeys === undefined
      ? {}
      : { first_choice_keys: firstChoiceKeys }),
    ...(messageType === undefined ? {} : { message_type: messageType }),
    ...(messageKeys === undefined ? {} : { message_keys: messageKeys }),
  };
}

/**
 * Removes common credential-shaped fragments and bounds text before it can be
 * emitted in the public protocol. Adapters choose the stable reason first;
 * this helper deliberately never classifies provider text.
 */
export function sanitizeAdapterFailure(
  reason: IncompleteReason | V9IncompleteReason,
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
    ...(typeof options.circuit_qualifying === "boolean"
      ? { circuit_qualifying: options.circuit_qualifying }
      : {}),
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
  resultTooLarge: (
    message: unknown,
    options?: AdapterFailureOptions,
  ): AdapterFailure =>
    sanitizeAdapterFailure("result_too_large", message, false, options),
  cancelled: (
    message: unknown = "Review was cancelled.",
    options?: AdapterFailureOptions,
  ): AdapterFailure =>
    sanitizeAdapterFailure("cancelled", message, false, {
      ...options,
      fallback_eligible: false,
      circuit_qualifying: false,
    }),
  unknown: (
    message: unknown,
    retryable = false,
    options?: AdapterFailureOptions,
  ): AdapterFailure =>
    sanitizeAdapterFailure("unknown", message, retryable, options),
} as const;
