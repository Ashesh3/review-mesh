import { expect, it } from "vitest";
import { sanitizeRunMetadata } from "../../src/results/sanitize.js";

it("preserves only finite safe numeric usage fields through redaction", () => {
  expect(
    sanitizeRunMetadata({
      prompt_tokens: 500,
      completion_tokens: 100,
      total_tokens: 600,
      reasoning_tokens: 80,
      cached_tokens: 20,
      cache_creation_tokens: 5,
      cache_read_tokens: 20,
      request_output_tokens: 8192,
      output_ceiling_tokens: 32768,
      access_token: "private",
      completion_tokens_details: { token: "private" },
    }),
  ).toMatchObject({
    prompt_tokens: 500,
    completion_tokens: 100,
    total_tokens: 600,
    reasoning_tokens: 80,
    cached_tokens: 20,
    cache_creation_tokens: 5,
    cache_read_tokens: 20,
    request_output_tokens: 8192,
    output_ceiling_tokens: 32768,
    access_token: "[redacted]",
    completion_tokens_details: "[redacted]",
  });
});
