import { describe, expect, it } from "vitest";
import type { ReviewerResultV3 } from "../../src/protocol/schemas.js";
import { reviewerResultDigest } from "../../src/results/digest.js";
import {
  ResultSanitizationError,
  sanitizeReviewerResult,
} from "../../src/results/sanitize.js";

function passResult(reviewMarkdown: string): ReviewerResultV3 {
  return {
    schema_version: "3",
    verdict: "pass",
    review_markdown: reviewMarkdown,
    summary: "No actionable findings.",
    actionable_findings: [],
    informational_notes: [],
  };
}

describe("sanitizeReviewerResult", () => {
  it("redacts credentials without truncating or changing surrounding review text", () => {
    const prefix = `# Review\n\n${"Preserved evidence. ".repeat(600)}`;
    const suffix = `\n\n${"Preserved conclusion. ".repeat(600)}`;
    const sanitized = sanitizeReviewerResult(
      passResult(`${prefix}Authorization: Bearer reviewer-secret${suffix}`),
    );

    expect(sanitized.review_markdown).toBe(`${prefix}[redacted]${suffix}`);
    expect(sanitized.review_markdown).not.toContain("[truncated]");
  });

  it("rejects a sanitized result above 16 MiB with result_too_large", () => {
    expect(() =>
      sanitizeReviewerResult(passResult("x".repeat(16 * 1_024 * 1_024))),
    ).toThrowError(
      expect.objectContaining<Partial<ResultSanitizationError>>({
        code: "result_too_large",
      }),
    );
  });
});

describe("reviewerResultDigest", () => {
  it("is stable across equivalent object key insertion orders", () => {
    const first = passResult("# Review\n\nComplete result.");
    const second = {
      informational_notes: [],
      actionable_findings: [],
      summary: "No actionable findings.",
      review_markdown: "# Review\n\nComplete result.",
      verdict: "pass",
      schema_version: "3",
    } as ReviewerResultV3;

    expect(reviewerResultDigest(first)).toMatch(/^[0-9a-f]{64}$/u);
    expect(reviewerResultDigest(first)).toBe(reviewerResultDigest(second));
  });
});
