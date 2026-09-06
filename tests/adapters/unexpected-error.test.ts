import { describe, expect, it } from "vitest";
import { sanitizeAdapterFailure } from "../../src/adapters/errors.js";

describe("persisted exception diagnostics", () => {
  it("preserves only well-bounded exception and numeric context diagnostics", () => {
    const failure = sanitizeAdapterFailure("unknown", "safe", false, {
      diagnostics: {
        exception_name: "TypeError",
        exception_message: "Authorization: Bearer hidden",
        last_operation: "read_file",
        stack_fingerprint: "a".repeat(64),
        context_error_class: "context_too_large",
        input_tokens: 2000,
        limit_tokens: 1000,
      },
    });
    expect(failure.diagnostics).toMatchObject({
      exception_message: "[redacted]",
      input_tokens: 2000,
      limit_tokens: 1000,
      stack_fingerprint: "a".repeat(64),
    });
    expect(JSON.stringify(failure)).not.toContain("hidden");
  });
});
