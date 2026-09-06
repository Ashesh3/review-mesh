import type { AdapterFailureDiagnostics } from "./errors.js";

const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const integer = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;

/** Numeric telemetry only; never retain provider-owned raw reasoning or arbitrary usage keys. */
export function usageDiagnostics(
  response: unknown,
): Partial<AdapterFailureDiagnostics> {
  const usage = object(object(response).usage);
  const completion = object(usage.completion_tokens_details);
  const prompt = object(usage.prompt_tokens_details);
  return Object.fromEntries(
    Object.entries({
      prompt_tokens:
        integer(usage.prompt_tokens) ?? integer(usage.input_tokens),
      completion_tokens:
        integer(usage.completion_tokens) ?? integer(usage.output_tokens),
      total_tokens: integer(usage.total_tokens),
      reasoning_tokens:
        integer(completion.reasoning_tokens) ??
        integer(usage.reasoning_tokens) ??
        integer(object(usage.output_tokens_details).reasoning_tokens),
      cached_tokens:
        integer(prompt.cached_tokens) ??
        integer(object(usage.input_tokens_details).cached_tokens),
      cache_creation_tokens: integer(usage.cache_creation_input_tokens),
      cache_read_tokens: integer(usage.cache_read_input_tokens),
    }).filter(([, value]) => value !== undefined),
  );
}
