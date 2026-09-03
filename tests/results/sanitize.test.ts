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

  it("preserves benign URL query parameters while redacting credential parameters", () => {
    const sanitized = sanitizeReviewerResult(
      passResult(
        "Reviewed https://example.test/search?q=review&page=2&access_token=query-secret&sort=asc successfully.",
      ),
    );

    expect(sanitized.review_markdown).toContain(
      "https://example.test/search?q=review&page=2&access_token=[redacted]&sort=asc",
    );
    expect(sanitized.review_markdown).not.toContain("query-secret");
  });

  it("redacts credential-shaped query values even under a benign parameter name", () => {
    const credential = `ghp_${"a".repeat(24)}`;
    const sanitized = sanitizeReviewerResult(
      passResult(
        `Reviewed https://example.test/callback?state=${credential}&page=2.`,
      ),
    );

    expect(sanitized.review_markdown).toContain(
      "https://example.test/callback?state=[redacted]&page=2.",
    );
    expect(sanitized.review_markdown).not.toContain(credential);
  });

  it("redacts credential patterns in URL paths and fragments without duplicating fragments", () => {
    const github = `ghp_${"g".repeat(24)}`;
    const jwt = "eyJheader12.eyJpayload12.signature12";
    const sanitized = sanitizeReviewerResult(
      passResult(
        [
          "https://example.test/token=path-secret/report?q=regression",
          `https://example.test/report#Bearer%20fragment-secret-${github}-${jwt}`,
          `https://example.test/#${github}`,
        ].join("\n"),
      ),
    );

    expect(sanitized.review_markdown).toContain("?q=regression");
    expect(sanitized.review_markdown).not.toMatch(
      /path-secret|fragment-secret|ghp_|eyJheader12/iu,
    );
    expect(
      sanitized.review_markdown.match(/https:\/\/example\.test\/#/gu),
    ).toHaveLength(1);
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
