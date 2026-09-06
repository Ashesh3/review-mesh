import { createHash } from "node:crypto";
import { sanitizeAdapterFailure } from "./errors.js";

const OPERATIONS = new Set([
  "inspection",
  "list_files",
  "read_file",
  "search_text",
  "coverage_status",
  "finalization",
  "snapshot_delivery",
  "response_decode",
]);
const PHASES = new Set([
  "inspection",
  "finalization",
  "snapshot_delivery",
  "response_decode",
  "probing",
]);
const ERROR_CLASSES = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "URIError",
  "EvalError",
  "AggregateError",
  "DOMException",
  "ZodError",
]);

export interface UnexpectedAdapterContext {
  model: string;
  operation: string;
  phase: string;
  turn: number;
  redactValues?: readonly string[];
  diagnosticRef?: string;
}

/** Unexpected error text may contain source or queries. Keep known fault
 * categories as safe templates, fingerprint the private stack, and never
 * serialize arbitrary exception properties, stack frames or caller values. */
export function unexpectedAdapterFailure(
  error: unknown,
  context: UnexpectedAdapterContext,
) {
  let name = "Error",
    message = "",
    stack = "";
  try {
    if (error instanceof Error) {
      name = ERROR_CLASSES.has(error.name) ? error.name : "Error";
      message = error.message;
      stack = error.stack ?? "";
    }
  } catch {
    /* Hostile getters must not break the diagnostic fallback. */
  }
  const safeMessage = /cannot read propert(?:y|ies) of undefined/iu.test(
    message,
  )
    ? "Cannot read properties of undefined."
    : /cannot read propert(?:y|ies) of null/iu.test(message)
      ? "Cannot read properties of null."
      : /maximum call stack size exceeded/iu.test(message)
        ? "Maximum call stack size exceeded."
        : /invalid string length/iu.test(message)
          ? "Invalid string length."
          : /not valid (?:utf-?8|encoded data)|encoded data was not valid/iu.test(
                message,
              )
            ? "Source text decoding failed."
            : /requested path is unavailable/iu.test(message)
              ? "The requested path is unavailable."
              : /unexpected token|unexpected end.*json|not valid json/iu.test(
                    message,
                  )
                ? "JSON parsing failed."
                : "Unexpected internal adapter exception.";
  const operation = OPERATIONS.has(context.operation)
    ? context.operation
    : "inspection";
  const phase = PHASES.has(context.phase) ? context.phase : "inspection";
  const fingerprint = createHash("sha256")
    .update(name)
    .update("\n")
    .update(stack.slice(0, 64 * 1024))
    .digest("hex");
  return sanitizeAdapterFailure(
    "unknown",
    `${name} during ${operation}: ${safeMessage}`,
    false,
    {
      fallback_eligible: true,
      circuit_qualifying: false,
      diagnostics: {
        failure_code: "unexpected_adapter_exception",
        failure_stage: "adapter_exception",
        scope: "adapter",
        exception_name: name,
        exception_message: safeMessage,
        stack_fingerprint: fingerprint,
        model: context.model,
        operation_phase: phase,
        last_operation: operation,
        inspection_turn: context.turn,
        artifact_ref: context.diagnosticRef ?? "reviewer.exception",
        recommended_action:
          "Inspect the correlated adapter exception and retry after correcting the failing operation.",
      },
    },
  );
}
