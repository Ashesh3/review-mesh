import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createResultPageCollector } from "../../src/results/result-pages.js";

const header = (
  findings: number,
  narrative: number,
  coverage: number,
  pages: number,
) =>
  JSON.stringify({
    schema_version: "1",
    kind: "review-mesh.result-page",
    result_id: "header",
    result_kind: "reviewer",
    result_schema_version: "4",
    page_index: 0,
    page_count: pages,
    previous_page_digest: null,
    page_kind: "header",
    payload: {
      verdict: findings > 0 ? "fail" : "pass",
      summary: "Synthetic.",
      informational_notes: [],
      narrative_byte_count: 0,
      narrative_fragment_count: narrative,
      actionable_finding_count: findings,
      coverage_attestation:
        coverage === 0
          ? null
          : {
              scope_digest: "a".repeat(64),
              entry_count: coverage,
              entries_digest: createHash("sha256").update("[]").digest("hex"),
            },
    },
  });
describe("reviewer header page capacity", () => {
  it.each([
    { findings: 2, narrative: 0, coverage: 0, minimum: 2 },
    { findings: 3, narrative: 2, coverage: 17, minimum: 7 },
    { findings: 0, narrative: 1, coverage: 16, minimum: 3 },
  ])(
    "rejects undersized declarations at the header for $minimum minimum pages",
    ({ findings, narrative, coverage, minimum }) => {
      const collector = createResultPageCollector({
        resultId: "header",
        resultKind: "reviewer",
      });
      expect(() =>
        collector.addPage(header(findings, narrative, coverage, minimum - 1)),
      ).toThrow(`page_count must be at least ${minimum}`);
      expect(collector.complete).toBe(false);
      expect(collector.nextRequest().pageIndex).toBe(0);
      expect(collector.nextRequest().minimumFindingCount ?? 0).toBe(findings);
      expect(() =>
        collector.addPage(header(findings, narrative, coverage, minimum)),
      ).not.toThrow();
      expect(collector.nextRequest().pageIndex).toBe(1);
    },
  );
  it("does not lower findings or verdict to repair page capacity", () => {
    const collector = createResultPageCollector({
      resultId: "header",
      resultKind: "reviewer",
    });
    expect(() => collector.addPage(header(2, 0, 0, 1))).toThrow();
    expect(() => collector.addPage(header(0, 0, 0, 1))).toThrow(/preserve/i);
    expect(collector.nextRequest().minimumFindingCount).toBe(2);
  });
});
