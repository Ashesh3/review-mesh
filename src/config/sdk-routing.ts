import {
  validateAdapterEffort,
  type AdapterRegistration,
  type ResolvedConfig,
} from "./schemas.js";

export type SdkHarness = "codex" | "claude" | "copilot";

/** Route the model family, without altering a provider's exact model identifier. */
export function sdkForModel(model: string): SdkHarness {
  const name = model.toLowerCase();
  const leaf = name.split("/").at(-1)!;
  if (
    name.startsWith("anthropic/") ||
    /^(?:anthropic[.:])?claude(?:[-.:]|$)/.test(leaf)
  )
    return "claude";
  if (
    name.startsWith("openai/") ||
    /^(?:gpt[-.]|chatgpt[-.]|codex(?:[-.]|$)|o[1-9](?:[-.]|$))/.test(leaf)
  )
    return "codex";
  return "copilot";
}

export function routeSdkReviewers(config: ResolvedConfig): ResolvedConfig {
  const commandCount = config.reviewers.filter(
    (reviewer) => reviewer.adapter.type === "command",
  ).length;
  if (commandCount === config.reviewers.length) return config;
  if (commandCount > 0)
    throw new Error(
      "Command and native SDK reviewers cannot share the same run. Select separate command-only or SDK-only rosters.",
    );
  return {
    ...config,
    execution: {
      ...config.execution,
      retry_attempts: 1,
      continuation_attempts: 0,
      retry_backoff_ms: 0,
    },
    reviewers: config.reviewers.map((reviewer) => {
      const registration = reviewer.adapter;
      if (registration.type === "openai_compatible")
        throw new Error(
          `Reviewer ${reviewer.id} uses retired raw inference. Change its adapter type to "sdk" and configure the selected SDK's supported provider protocol.`,
        );
      if (registration.type === "command") return reviewer;
      const harness = sdkForModel(reviewer.model);
      validateAdapterEffort(
        harness,
        reviewer.effort,
        `Reviewer ${reviewer.id}`,
      );
      if (registration.type !== "sdk" && registration.type !== harness)
        throw new Error(
          `Reviewer ${reviewer.id}: OpenAI models use codex, Claude/Anthropic models use claude, and other models use copilot; ${reviewer.model} requires ${harness}.`,
        );
      // Preserve legacy coverage configuration without converting it into native
      // file-read obligations. Native agents choose their own review inspection.
      const { type: _type, ...settings } = registration;
      const adapter = { ...settings, type: harness } as AdapterRegistration;
      return {
        ...reviewer,
        adapter,
        runtime: {
          ...reviewer.runtime,
          execution_contract: "native_review_v1",
        },
      };
    }),
  };
}
