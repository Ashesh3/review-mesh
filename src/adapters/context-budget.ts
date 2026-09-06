import type { AdapterFailureDiagnostics } from "./errors.js";

export interface ModelContextSettings {
  context_window_tokens?: number | undefined;
  max_input_tokens?: number | undefined;
  max_output_tokens?: number | undefined;
}
export interface ModelBudget {
  contextTokens: number;
  inputTokens: number;
  outputTokens: number;
  source:
    | "configured"
    | "model_metadata"
    | "conservative_default"
    | "provider_feedback";
  tokenizer?: string;
}
function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function capacity(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1024 &&
    value <= 16_000_000
    ? value
    : undefined;
}
export function resolveModelBudget(
  model?: unknown,
  settings: ModelContextSettings = {},
): ModelBudget {
  const metadata = object(model),
    caps = object(metadata.capabilities),
    limits = object(caps.limits);
  const explicit =
    settings.context_window_tokens !== undefined ||
    settings.max_input_tokens !== undefined ||
    settings.max_output_tokens !== undefined;
  const context =
    capacity(settings.context_window_tokens) ??
    capacity(limits.max_context_window_tokens) ??
    capacity(metadata.context_window) ??
    128_000;
  const output = Math.min(
    capacity(settings.max_output_tokens) ??
      capacity(limits.max_output_tokens) ??
      8192,
    8192,
    Math.floor(context / 4),
  );
  const input = Math.min(
    capacity(settings.max_input_tokens) ??
      capacity(limits.max_prompt_tokens) ??
      context - output,
    context - output,
  );
  return {
    contextTokens: context,
    inputTokens: input,
    outputTokens: output,
    source: explicit
      ? "configured"
      : capacity(limits.max_context_window_tokens) ||
          capacity(limits.max_prompt_tokens) ||
          capacity(metadata.context_window)
        ? "model_metadata"
        : "conservative_default",
    ...(typeof caps.tokenizer === "string"
      ? { tokenizer: caps.tokenizer.slice(0, 128) }
      : {}),
  };
}

/** Conservative tokenizer-independent upper estimate. UTF-8 bytes can greatly
 * overestimate BPE tokens; it is an explicit safe default, never an exact count. */
export class ContextBudget {
  private limit: number;
  constructor(readonly model: ModelBudget) {
    this.limit = Math.max(
      0,
      model.inputTokens - Math.max(1024, Math.ceil(model.contextTokens * 0.05)),
    );
  }
  get inputLimit() {
    return this.limit;
  }
  estimate(body: unknown) {
    return Buffer.byteLength(JSON.stringify(body), "utf8") + 256;
  }
  fits(body: unknown) {
    return this.estimate(body) <= this.limit;
  }
  reduce(
    feedback: Pick<AdapterFailureDiagnostics, "input_tokens" | "limit_tokens">,
    body: unknown,
  ): boolean {
    const ratio =
      feedback.input_tokens && feedback.limit_tokens
        ? feedback.limit_tokens / feedback.input_tokens
        : 0.6;
    const next = Math.floor(
      Math.min(
        this.limit * 0.75,
        this.estimate(body) * Math.min(0.75, ratio * 0.8),
      ),
    );
    if (next < 2048 || next >= this.limit) return false;
    this.limit = next;
    this.model.source = "provider_feedback";
    return true;
  }
  diagnostics(body?: unknown): Partial<AdapterFailureDiagnostics> {
    return {
      budget_source: this.model.source,
      token_estimation: "utf8_upper_bound",
      input_budget_tokens: this.limit,
      output_reserve_tokens: this.model.outputTokens,
      context_window_tokens: this.model.contextTokens,
      ...(body === undefined
        ? {}
        : { estimated_input_tokens: this.estimate(body) }),
    };
  }
}
