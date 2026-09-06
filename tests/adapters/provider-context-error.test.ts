import { describe, expect, it } from "vitest";
import { providerErrorBody } from "../../src/adapters/provider-error-body.js";

describe("provider context diagnostics", () => {
  it("uses structured numeric limits with a recognized context error code", async () => {
    const diagnostics = await providerErrorBody(
      new Response(
        JSON.stringify({
          error: {
            code: "context_length_exceeded",
            message: "Request rejected",
            input_tokens: 120000,
            limit_tokens: 100000,
          },
        }),
        { status: 400 },
      ),
      new AbortController().signal,
      undefined,
      "synthetic-key",
    );
    expect(diagnostics).toMatchObject({
      context_error_class: "context_too_large",
      input_tokens: 120000,
      limit_tokens: 100000,
      provider_error_message:
        "Model context limit exceeded: input 120000 tokens; limit 100000 tokens.",
    });
  });
  it("does not redact its own replacement marker in ordinary provider errors", async () => {
    const diagnostics = await providerErrorBody(
      new Response(
        JSON.stringify({
          error: { message: "Unsupported value: privateMode" },
        }),
        { status: 400 },
      ),
      new AbortController().signal,
      JSON.stringify({ messages: [{ content: "privateMode" }] }),
      "synthetic-key",
    );
    expect(diagnostics.provider_error_message).toBe(
      "Unsupported value: [request content redacted]",
    );
  });
  it.each([
    [
      "invalid_request_body",
      "prompt is too long: 1393417 tokens > 1000000 maximum",
      1393417,
      1000000,
    ],
    [
      "model_max_prompt_tokens_exceeded",
      "prompt token count of 390302 exceeds the limit of 372000",
      390302,
      372000,
    ],
    [
      "context_length_exceeded",
      "This model's maximum context length is 8192 tokens. However, you requested 9000 tokens.",
      9000,
      8192,
    ],
  ])(
    "extracts context capacity before echo redaction for %s",
    async (code, message, input, limit) => {
      const diagnostics = await providerErrorBody(
        new Response(JSON.stringify({ error: { code, message } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
        new AbortController().signal,
        JSON.stringify({
          messages: [
            {
              content: `Prompt context window maximum request tokens. ${message}`,
            },
          ],
        }),
        "synthetic-key",
      );
      expect(diagnostics).toMatchObject({
        failure_code: "context_length_exceeded",
        context_error_class: "context_too_large",
        input_tokens: input,
        limit_tokens: limit,
      });
      expect(diagnostics.provider_error_message).toBe(
        `Model context limit exceeded: input ${input} tokens; limit ${limit} tokens.`,
      );
      expect(diagnostics.provider_error_message).not.toContain(
        "[request content redacted]",
      );
    },
  );
  it("classifies a textual context error without inventing numeric limits", async () => {
    const diagnostics = await providerErrorBody(
      new Response(
        "Your request exceeds the context window of this model. Remove privateTenantX source.",
        { status: 400 },
      ),
      new AbortController().signal,
      JSON.stringify({ messages: [{ content: "privateTenantX" }] }),
      "synthetic-key",
    );
    expect(diagnostics).toMatchObject({
      failure_code: "context_length_exceeded",
      context_error_class: "context_too_large",
      provider_error_message: "Model context limit exceeded.",
    });
    expect(diagnostics).not.toHaveProperty("input_tokens");
    expect(diagnostics).not.toHaveProperty("limit_tokens");
    expect(JSON.stringify(diagnostics)).not.toContain("privateTenantX");
  });
  it("does not classify ordinary errors or output-token complaints as input context limits", async () => {
    for (const message of [
      "Bad Request",
      "max_tokens must be positive",
      "The output token limit was exceeded",
    ]) {
      const diagnostics = await providerErrorBody(
        new Response(message, { status: 400 }),
        new AbortController().signal,
        undefined,
        "synthetic-key",
      );
      expect(diagnostics).not.toHaveProperty("context_error_class");
    }
  });
});
