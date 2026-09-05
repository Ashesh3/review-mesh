import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sanitizedResultPages } from "../../src/results/sanitized-pages.js";
import { createResultPageCollector } from "../../src/results/result-pages.js";

describe("sanitized artifact result pages", () => {
  it("removes credentials and rebuilds a verifiable chain matching the accepted result", async () => {
    const page = JSON.stringify({
      schema_version: "1",
      kind: "review-mesh.result-page",
      result_id: "result-1",
      result_kind: "reviewer",
      result_schema_version: "4",
      page_index: 0,
      page_count: 1,
      page_kind: "header",
      previous_page_digest: null,
      payload: {
        verdict: "pass",
        summary: "api_key=secret-value",
        informational_notes: [],
        narrative_byte_count: 0,
        narrative_fragment_count: 0,
        actionable_finding_count: 0,
        coverage_attestation: null,
      },
    });
    const collector = createResultPageCollector({
      resultId: "result-1",
      resultKind: "reviewer",
    });
    collector.addPage(page);
    const expected = collector.assemble();
    const pages = await sanitizedResultPages(
      (async function* () {
        yield {
          raw: page,
          sha256: createHash("sha256").update(page).digest("hex"),
        };
      })(),
      expected,
    );
    expect(pages).toHaveLength(1);
    expect(pages[0]?.raw).not.toContain("secret-value");
    expect(pages[0]?.raw).toContain("[redacted]");
  });
});
