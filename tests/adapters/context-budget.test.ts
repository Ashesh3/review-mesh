import { expect, it } from "vitest";
import {
  ContextBudget,
  resolveModelBudget,
} from "../../src/adapters/context-budget.js";

it("resolves model metadata and explicit capacity with output reserve", () => {
  const budget = resolveModelBudget({
    id: "model",
    capabilities: {
      limits: {
        max_context_window_tokens: 64000,
        max_prompt_tokens: 56000,
        max_output_tokens: 4096,
      },
      tokenizer: "unknown",
    },
  });
  expect(budget).toMatchObject({
    source: "model_metadata",
    contextTokens: 64000,
    inputTokens: 56000,
    outputTokens: 4096,
  });
  expect(
    resolveModelBudget(undefined, {
      context_window_tokens: 32768,
      max_output_tokens: 2048,
    }),
  ).toMatchObject({
    source: "configured",
    contextTokens: 32768,
    outputTokens: 2048,
  });
});
it("accounts for the whole envelope and shrinks context feedback without admitting unchanged oversize requests", () => {
  const budget = new ContextBudget(
    resolveModelBudget(undefined, {
      context_window_tokens: 32768,
      max_output_tokens: 2048,
    }),
  );
  const body = {
    messages: [{ role: "user", content: "a".repeat(28000) }],
    tools: [{ description: "b".repeat(5000) }],
    max_tokens: 2048,
  };
  expect(budget.fits(body)).toBe(false);
  const before = budget.inputLimit;
  budget.reduce({ input_tokens: 40000, limit_tokens: 16000 }, body);
  expect(budget.inputLimit).toBeLessThan(before);
  expect(budget.fits(body)).toBe(false);
});
