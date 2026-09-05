import {
  adapterFailureDiagnosticsSchema,
  incompleteReasonSchema,
  type IncompleteReason,
} from "./schemas.js";

/** Frozen v4/v5 output cannot name v9-only boundaries. */
export function legacyIncompleteReason(reason: string): IncompleteReason {
  const parsed = incompleteReasonSchema.safeParse(reason);
  if (parsed.success) return parsed.data;
  if (reason.endsWith("deadline_exceeded") || reason === "no_progress_timeout")
    return "timeout";
  if (reason === "change_coverage_incomplete") return "read_failure";
  return "invalid_result";
}

export function legacyFailureDiagnostics(value: unknown) {
  const record =
    typeof value === "object" && value !== null
      ? ({ ...value } as Record<string, unknown>)
      : {};
  const parsed = adapterFailureDiagnosticsSchema.safeParse(record);
  if (parsed.success) return parsed.data;
  delete record.failure_code;
  return adapterFailureDiagnosticsSchema.parse(record);
}
