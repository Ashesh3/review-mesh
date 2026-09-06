import { expect, it } from "vitest";
import {
  ContextBudget,
  resolveModelBudget,
} from "../../src/adapters/context-budget.js";

it("does not grow output into input capacity required by the checkpoint schema", () => {
  const budget = new ContextBudget(
    resolveModelBudget({
      capabilities: {
        limits: { max_context_window_tokens: 32768, max_output_tokens: 32768 },
      },
    }),
  );
  expect(budget.growOutput(10000)).toBe(true);
  expect(budget.growOutput(10000)).toBe(true);
  expect(budget.inputLimit).toBeGreaterThanOrEqual(10000);
  expect(budget.growOutput(10000)).toBe(false);
});

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

it("honors trusted output allocation while respecting the model ceiling", () => {
  const model = {
    capabilities: {
      limits: { max_context_window_tokens: 128000, max_output_tokens: 32768 },
    },
  };
  expect(resolveModelBudget(model, { max_output_tokens: 65536 })).toMatchObject(
    {
      outputTokens: 32768,
      outputCeilingTokens: 32768,
      outputSource: "configured",
      inputTokens: 95232,
    },
  );
  expect(
    resolveModelBudget(undefined, {
      context_window_tokens: 128000,
      max_output_tokens: 65536,
    }),
  ).toMatchObject({ outputTokens: 65536, outputCeilingTokens: 65536 });
});

it("starts at the default cap then grows within metadata and rebalances input reserve", () => {
  const budget = new ContextBudget(
    resolveModelBudget({
      capabilities: {
        limits: { max_context_window_tokens: 128000, max_output_tokens: 32768 },
      },
    }),
  );
  expect(budget.model.outputTokens).toBe(8192);
  const before = budget.inputLimit;
  expect(budget.growOutput()).toBe(true);
  expect(budget.model.outputTokens).toBe(16384);
  expect(budget.inputLimit).toBe(before - 8192);
  expect(budget.growOutput()).toBe(true);
  expect(budget.model.outputTokens).toBe(32768);
  expect(budget.growOutput()).toBe(false);
  expect(budget.diagnostics()).toMatchObject({
    output_cap_source: "adaptive",
    output_ceiling_tokens: 32768,
    request_output_tokens: 32768,
  });
});

it("output growth never increases an input limit already reduced by provider feedback", () => {
  const budget = new ContextBudget(
    resolveModelBudget({
      capabilities: {
        limits: { max_context_window_tokens: 128000, max_output_tokens: 65536 },
      },
    }),
  );
  budget.reduce(
    { input_tokens: 100000, limit_tokens: 20000 },
    { messages: [{ content: "x".repeat(80000) }] },
  );
  const reduced = budget.inputLimit;
  expect(budget.growOutput()).toBe(true);
  expect(budget.inputLimit).toBeLessThanOrEqual(reduced);
  expect(budget.inputLimit + budget.model.outputTokens).toBeLessThan(
    budget.model.contextTokens,
  );
});
it.each([4096, 8192])(
  "keeps positive output and useful input reserves for context %s",
  (context) => {
    const budget = new ContextBudget(
      resolveModelBudget(
        {
          capabilities: {
            limits: {
              max_context_window_tokens: context,
              max_output_tokens: 65536,
            },
          },
        },
        { max_output_tokens: 65536 },
      ),
    );
    expect(budget.model.outputTokens).toBeGreaterThan(0);
    expect(budget.inputLimit).toBeGreaterThanOrEqual(2048);
    expect(budget.model.outputTokens + budget.inputLimit).toBeLessThan(context);
  },
);
