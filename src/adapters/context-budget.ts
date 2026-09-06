import type { AdapterFailureDiagnostics } from "./errors.js";

export interface ModelContextSettings {
  context_window_tokens?: number | undefined;
  max_input_tokens?: number | undefined;
  max_output_tokens?: number | undefined;
}
export interface ModelBudget {
  contextTokens: number;
  inputTokens: number;
  inputCeilingTokens: number;
  outputTokens: number;
  outputCeilingTokens: number;
  outputSource: "configured" | "model_metadata" | "default" | "adaptive";
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
  const configuredOutput = capacity(settings.max_output_tokens);
  const metadataOutput = capacity(limits.max_output_tokens);
  const outputCeiling = Math.min(
    configuredOutput ?? metadataOutput ?? 8192,
    metadataOutput ?? 65536,
    65536,
    Math.max(
      1,
      context -
        Math.max(1024, Math.ceil(context * 0.05)) -
        Math.min(2048, Math.floor(context / 2)),
    ),
  );
  const output = Math.min(configuredOutput ?? 8192, outputCeiling);
  const inputCeiling =
    capacity(settings.max_input_tokens) ??
    capacity(limits.max_prompt_tokens) ??
    context;
  const input = Math.min(inputCeiling, context - output);
  return {
    contextTokens: context,
    inputTokens: input,
    inputCeilingTokens: inputCeiling,
    outputTokens: output,
    outputCeilingTokens: outputCeiling,
    outputSource:
      configuredOutput !== undefined
        ? "configured"
        : metadataOutput !== undefined
          ? "model_metadata"
          : "default",
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
  private feedbackLimit = Number.POSITIVE_INFINITY;
  private readonly headroom: number;
  constructor(readonly model: ModelBudget) {
    this.headroom = Math.max(1024, Math.ceil(model.contextTokens * 0.05));
    this.limit = Math.max(0, model.inputTokens - this.headroom);
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
  growOutput(minimumInputTokens = 2048): boolean {
    if (!Number.isSafeInteger(minimumInputTokens) || minimumInputTokens < 2048)
      return false;
    const next = Math.min(
      this.model.outputCeilingTokens,
      this.model.outputTokens * 2,
      this.model.contextTokens - this.headroom - minimumInputTokens,
    );
    if (next <= this.model.outputTokens) return false;
    const input = Math.min(
      this.model.inputCeilingTokens,
      this.model.contextTokens - next,
    );
    const limit = Math.max(
      0,
      Math.min(input - this.headroom, this.feedbackLimit),
    );
    if (limit < minimumInputTokens) return false;
    this.model.outputTokens = next;
    this.model.inputTokens = input;
    this.model.outputSource = "adaptive";
    this.limit = limit;
    return true;
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
    this.feedbackLimit = next;
    this.model.source = "provider_feedback";
    return true;
  }
  diagnostics(body?: unknown): Partial<AdapterFailureDiagnostics> {
    return {
      budget_source: this.model.source,
      token_estimation: "utf8_upper_bound",
      input_budget_tokens: this.limit,
      output_reserve_tokens: this.model.outputTokens,
      request_output_tokens: this.model.outputTokens,
      output_cap_source: this.model.outputSource,
      output_ceiling_tokens: this.model.outputCeilingTokens,
      context_window_tokens: this.model.contextTokens,
      ...(body === undefined
        ? {}
        : { estimated_input_tokens: this.estimate(body) }),
    };
  }
}
