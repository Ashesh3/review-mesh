import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createResultPageCollector,
  ResultPageError,
} from "../../src/results/result-pages.js";

const digest = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");
const finding = (id: string) => ({
  id,
  severity: "high",
  title: `Finding ${id}`,
  description: "The operation returns stale data.",
  evidence: [
    { path: "src/index.ts", start_line: 1, end_line: 2, detail: "Stale read." },
  ],
  suggested_direction: "Refresh the value.",
  confidence: "high",
  classification: "confirmed_defect",
  external_assumptions: [],
  category: "correctness",
  verification: "Run the regression test.",
  claim: {
    trigger: "A cache exists.",
    affected_behavior: "Reads use it.",
    outcome: "Stale data is returned.",
  },
});

function rawPage(page: Record<string, unknown>): string {
  return JSON.stringify(page);
}

function reviewerPages(
  resultId = "result-1",
  narrative = "first second",
): string[] {
  const fragments = ["first ", "second"];
  const pages: string[] = [];
  pages.push(
    rawPage({
      schema_version: "1",
      kind: "review-mesh.result-page",
      result_id: resultId,
      result_kind: "reviewer",
      result_schema_version: "4",
      page_index: 0,
      page_count: 6,
      page_kind: "header",
      previous_page_digest: null,
      payload: {
        verdict: "fail",
        summary: "Six findings.",
        informational_notes: [],
        narrative_byte_count: Buffer.byteLength(narrative, "utf8"),
        narrative_fragment_count: 2,
        actionable_finding_count: 6,
        coverage_attestation: null,
      },
    }),
  );
  for (let index = 0; index < fragments.length; index += 1) {
    pages.push(
      rawPage({
        schema_version: "1",
        kind: "review-mesh.result-page",
        result_id: resultId,
        result_kind: "reviewer",
        result_schema_version: "4",
        page_index: index + 1,
        page_count: 6,
        page_kind: "narrative",
        previous_page_digest: digest(pages[index]!),
        payload: { text_fragment: fragments[index] },
      }),
    );
  }
  for (let index = 0; index < 3; index += 1) {
    pages.push(
      rawPage({
        schema_version: "1",
        kind: "review-mesh.result-page",
        result_id: resultId,
        result_kind: "reviewer",
        result_schema_version: "4",
        page_index: index + 3,
        page_count: 6,
        page_kind: "findings",
        previous_page_digest: digest(pages[index + 2]!),
        payload: {
          actionable_findings: [
            finding(`f-${index * 2 + 1}`),
            finding(`f-${index * 2 + 2}`),
          ],
        },
      }),
    );
  }
  return pages;
}

function narrativePages(resultId: string, narrative: string): string[] {
  const fragments: string[] = [];
  for (let offset = 0; offset < narrative.length; offset += 24 * 1_024) {
    fragments.push(narrative.slice(offset, offset + 24 * 1_024));
  }
  const pageCount = 1 + fragments.length;
  const pages = [
    rawPage({
      schema_version: "1",
      kind: "review-mesh.result-page",
      result_id: resultId,
      result_kind: "reviewer",
      result_schema_version: "4",
      page_index: 0,
      page_count: pageCount,
      page_kind: "header",
      previous_page_digest: null,
      payload: {
        verdict: "pass",
        summary: "No findings.",
        informational_notes: [],
        narrative_byte_count: Buffer.byteLength(narrative, "utf8"),
        narrative_fragment_count: fragments.length,
        actionable_finding_count: 0,
        coverage_attestation: null,
      },
    }),
  ];
  for (const [index, fragment] of fragments.entries()) {
    pages.push(
      rawPage({
        schema_version: "1",
        kind: "review-mesh.result-page",
        result_id: resultId,
        result_kind: "reviewer",
        result_schema_version: "4",
        page_index: index + 1,
        page_count: pageCount,
        page_kind: "narrative",
        previous_page_digest: digest(pages[index]!),
        payload: { text_fragment: fragment },
      }),
    );
  }
  return pages;
}

describe("reviewer result page collector", () => {
  it("assembles six findings from semantic pages without repeating narrative or evidence", () => {
    const collector = createResultPageCollector({
      resultId: "result-1",
      resultKind: "reviewer",
    });
    for (const page of reviewerPages()) collector.addPage(page);

    expect(collector.complete).toBe(true);
    expect(collector.assemble()).toMatchObject({
      schema_version: "4",
      verdict: "fail",
      review_markdown: "first second",
      summary: "Six findings.",
      actionable_findings: [
        { id: "f-1" },
        { id: "f-2" },
        { id: "f-3" },
        { id: "f-4" },
        { id: "f-5" },
        { id: "f-6" },
      ],
    });
  });

  it("advances continuation identity only after the exact raw page validates", () => {
    const collector = createResultPageCollector({
      resultId: "result-1",
      resultKind: "reviewer",
    });
    const pages = reviewerPages();
    expect(collector.nextRequest()).toEqual({
      resultId: "result-1",
      pageIndex: 0,
      previousPageDigest: null,
      candidateIds: [],
    });
    collector.addPage(pages[0]!);
    expect(collector.nextRequest()).toEqual({
      resultId: "result-1",
      pageIndex: 1,
      previousPageDigest: digest(pages[0]!),
      candidateIds: [],
    });
  });

  it.each([
    [
      "wrong result ID",
      (page: any) => {
        page.result_id = "other";
      },
    ],
    [
      "index gap",
      (page: any) => {
        page.page_index = 2;
      },
    ],
    [
      "changed page count",
      (page: any) => {
        page.page_count = 7;
      },
    ],
    [
      "broken digest",
      (page: any) => {
        page.previous_page_digest = "b".repeat(64);
      },
    ],
    [
      "illegal page ordering",
      (page: any) => {
        page.page_kind = "findings";
        page.payload = { actionable_findings: [finding("early")] };
      },
    ],
  ])("rejects a %s without advancing state", (_name, mutate) => {
    const collector = createResultPageCollector({
      resultId: "result-1",
      resultKind: "reviewer",
    });
    const pages = reviewerPages();
    collector.addPage(pages[0]!);
    const invalid = JSON.parse(pages[1]!) as Record<string, unknown>;
    mutate(invalid);
    const raw = rawPage(invalid);
    expect(() => collector.addPage(raw)).toThrow(ResultPageError);
    expect(collector.nextRequest().pageIndex).toBe(1);
  });

  it("rejects an oversize raw page before parsing and retains the received bytes", () => {
    const collector = createResultPageCollector({
      resultId: "result-1",
      resultKind: "reviewer",
    });
    const raw = `{"bad":"${"😀".repeat(8_192)}"}`;
    expect(Buffer.byteLength(raw, "utf8")).toBeGreaterThan(32 * 1_024);
    try {
      collector.addPage(raw);
      throw new Error("expected addPage to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ResultPageError);
      expect((error as ResultPageError).reason).toBe("result_page_too_large");
      expect((error as ResultPageError).receivedRaw).toBe(raw);
      expect((error as ResultPageError).receivedBytes).toBe(
        Buffer.byteLength(raw, "utf8"),
      );
    }
  });

  it("enforces the 24 KiB narrative fragment limit as UTF-8 bytes", () => {
    const collector = createResultPageCollector({
      resultId: "utf8",
      resultKind: "reviewer",
    });
    const fragment = "😀".repeat(6_144);
    const header = rawPage({
      schema_version: "1",
      kind: "review-mesh.result-page",
      result_id: "utf8",
      result_kind: "reviewer",
      result_schema_version: "4",
      page_index: 0,
      page_count: 2,
      page_kind: "header",
      previous_page_digest: null,
      payload: {
        verdict: "pass",
        summary: "No findings.",
        informational_notes: [],
        narrative_byte_count: 24 * 1_024,
        narrative_fragment_count: 1,
        actionable_finding_count: 0,
        coverage_attestation: null,
      },
    });
    collector.addPage(header);
    const page = (text_fragment: string) =>
      rawPage({
        schema_version: "1",
        kind: "review-mesh.result-page",
        result_id: "utf8",
        result_kind: "reviewer",
        result_schema_version: "4",
        page_index: 1,
        page_count: 2,
        page_kind: "narrative",
        previous_page_digest: digest(header),
        payload: { text_fragment },
      });
    expect(Buffer.byteLength(fragment, "utf8")).toBe(24 * 1_024);
    expect(() => collector.addPage(page(`${fragment}a`))).toThrow(
      ResultPageError,
    );
    expect(collector.nextRequest().pageIndex).toBe(1);
    collector.addPage(page(fragment));
    expect(
      (collector.assemble() as { review_markdown: string }).review_markdown,
    ).toBe(fragment);
  });

  it("rejects false narrative and finding declarations during assembly", () => {
    for (const field of [
      "narrative_byte_count",
      "actionable_finding_count",
    ] as const) {
      const collector = createResultPageCollector({
        resultId: field,
        resultKind: "reviewer",
      });
      const pages = reviewerPages(field);
      const header = JSON.parse(pages[0]!) as any;
      header.payload[field] += 1;
      pages[0] = rawPage(header);
      for (let index = 1; index < pages.length; index += 1) {
        const page = JSON.parse(pages[index]!) as any;
        page.previous_page_digest = digest(pages[index - 1]!);
        pages[index] = rawPage(page);
      }
      for (const page of pages) collector.addPage(page);
      expect(() => collector.assemble()).toThrow(ResultPageError);
    }
  });

  it("rejects a repeated finding ID and pages after the declared final page", () => {
    const repeated = createResultPageCollector({
      resultId: "repeat",
      resultKind: "reviewer",
    });
    const pages = reviewerPages("repeat");
    const last = JSON.parse(pages.at(-1)!) as any;
    last.payload.actionable_findings[1].id = "f-5";
    pages[pages.length - 1] = rawPage(last);
    for (const page of pages.slice(0, -1)) repeated.addPage(page);
    expect(() => repeated.addPage(pages.at(-1)!)).toThrow(ResultPageError);

    const complete = createResultPageCollector({
      resultId: "complete",
      resultKind: "reviewer",
    });
    const completePages = narrativePages("complete", "review");
    for (const page of completePages) complete.addPage(page);
    expect(() => complete.addPage(completePages.at(-1)!)).toThrow(
      ResultPageError,
    );
  });

  it("rejects a missing final page", () => {
    const collector = createResultPageCollector({
      resultId: "missing",
      resultKind: "reviewer",
    });
    const pages = reviewerPages("missing");
    for (const page of pages.slice(0, -1)) collector.addPage(page);
    expect(collector.complete).toBe(false);
    expect(() => collector.assemble()).toThrow(ResultPageError);
  });

  it("rejects a findings transition before all declared narrative fragments without advancing", () => {
    const collector = createResultPageCollector({
      resultId: "partial-narrative",
      resultKind: "reviewer",
    });
    const pages = reviewerPages("partial-narrative");
    collector.addPage(pages[0]!);
    collector.addPage(pages[1]!);
    const findingPage = JSON.parse(pages[3]!) as any;
    findingPage.page_index = 2;
    findingPage.previous_page_digest = digest(pages[1]!);
    expect(() => collector.addPage(rawPage(findingPage))).toThrow(
      ResultPageError,
    );
    expect(collector.nextRequest().pageIndex).toBe(2);
    collector.addPage(pages[2]!);
    expect(collector.nextRequest().pageIndex).toBe(3);
  });

  it("rejects a narrative transition before all declared coverage entries without advancing", () => {
    const entries = [
      { path: "a.ts", method: "diff" },
      { path: "b.ts", method: "diff" },
    ];
    const header = rawPage({
      schema_version: "1",
      kind: "review-mesh.result-page",
      result_id: "partial-coverage",
      result_kind: "reviewer",
      result_schema_version: "4",
      page_index: 0,
      page_count: 4,
      page_kind: "header",
      previous_page_digest: null,
      payload: {
        verdict: "pass",
        summary: "No findings.",
        informational_notes: [],
        narrative_byte_count: 1,
        narrative_fragment_count: 1,
        actionable_finding_count: 0,
        coverage_attestation: {
          scope_digest: "a".repeat(64),
          entry_count: 2,
          entries_digest: digest(JSON.stringify(entries)),
        },
      },
    });
    const coverage = rawPage({
      schema_version: "1",
      kind: "review-mesh.result-page",
      result_id: "partial-coverage",
      result_kind: "reviewer",
      result_schema_version: "4",
      page_index: 1,
      page_count: 4,
      page_kind: "coverage",
      previous_page_digest: digest(header),
      payload: { entries: [entries[0]] },
    });
    const narrative = rawPage({
      schema_version: "1",
      kind: "review-mesh.result-page",
      result_id: "partial-coverage",
      result_kind: "reviewer",
      result_schema_version: "4",
      page_index: 2,
      page_count: 4,
      page_kind: "narrative",
      previous_page_digest: digest(coverage),
      payload: { text_fragment: "x" },
    });
    const collector = createResultPageCollector({
      resultId: "partial-coverage",
      resultKind: "reviewer",
    });
    collector.addPage(header);
    collector.addPage(coverage);
    expect(() => collector.addPage(narrative)).toThrow(ResultPageError);
    expect(collector.nextRequest().pageIndex).toBe(2);
  });

  it("rejects a false or non-canonical coverage attestation", () => {
    const entries = [
      { path: "z.ts", method: "diff" },
      { path: "a.ts", method: "full_file", snapshot_digest: "b".repeat(64) },
    ];
    const header = rawPage({
      schema_version: "1",
      kind: "review-mesh.result-page",
      result_id: "coverage",
      result_kind: "reviewer",
      result_schema_version: "4",
      page_index: 0,
      page_count: 2,
      page_kind: "header",
      previous_page_digest: null,
      payload: {
        verdict: "pass",
        summary: "No findings.",
        informational_notes: [],
        narrative_byte_count: 0,
        narrative_fragment_count: 0,
        actionable_finding_count: 0,
        coverage_attestation: {
          scope_digest: "a".repeat(64),
          entry_count: 2,
          entries_digest: digest(JSON.stringify(entries)),
        },
      },
    });
    const coverage = rawPage({
      schema_version: "1",
      kind: "review-mesh.result-page",
      result_id: "coverage",
      result_kind: "reviewer",
      result_schema_version: "4",
      page_index: 1,
      page_count: 2,
      page_kind: "coverage",
      previous_page_digest: digest(header),
      payload: { entries },
    });
    const collector = createResultPageCollector({
      resultId: "coverage",
      resultKind: "reviewer",
    });
    collector.addPage(header);
    collector.addPage(coverage);
    expect(() => collector.assemble()).toThrow(ResultPageError);
  });

  it.each([
    ["13 MiB", "x".repeat(13 * 1_024 * 1_024)],
    ["just below 16 MiB", "x".repeat(16 * 1_024 * 1_024 - 2_048)],
  ])("round-trips a lossless %s narrative", (_label, narrative) => {
    const resultId = `large-${narrative.length}`;
    const collector = createResultPageCollector({
      resultId,
      resultKind: "reviewer",
    });
    for (const page of narrativePages(resultId, narrative))
      collector.addPage(page);
    expect(
      (collector.assemble() as { review_markdown: string }).review_markdown,
    ).toBe(narrative);
  });

  it("measures fragment and serialized-page limits separately for escaped text", () => {
    const text = "\n".repeat(12 * 1_024);
    expect(Buffer.byteLength(text, "utf8")).toBe(12 * 1_024);
    const collector = createResultPageCollector({
      resultId: "escaped",
      resultKind: "reviewer",
    });
    const pages = narrativePages("escaped", text);
    expect(Buffer.byteLength(pages[1]!, "utf8")).toBeLessThanOrEqual(
      32 * 1_024,
    );
    for (const page of pages) collector.addPage(page);
    expect(
      (collector.assemble() as { review_markdown: string }).review_markdown,
    ).toBe(text);
  });
});

describe("adjudication result page collector", () => {
  it("assigns and assembles 80 candidates in deterministic groups of four", () => {
    const candidateIds = Array.from(
      { length: 80 },
      (_, index) => `candidate-${index + 1}`,
    );
    const collector = createResultPageCollector({
      resultId: "adj-1",
      resultKind: "adjudication",
      candidateIds,
    });
    const candidateDigest = digest(JSON.stringify(candidateIds));
    let previous: string | null = null;
    for (let pageIndex = 0; pageIndex <= 20; pageIndex += 1) {
      const assigned =
        pageIndex === 0
          ? []
          : candidateIds.slice((pageIndex - 1) * 4, pageIndex * 4);
      expect(collector.nextRequest().candidateIds).toEqual(assigned);
      const raw = rawPage({
        schema_version: "1",
        kind: "review-mesh.result-page",
        result_id: "adj-1",
        result_kind: "adjudication",
        result_schema_version: "2",
        page_index: pageIndex,
        page_count: 21,
        page_kind: pageIndex === 0 ? "header" : "decisions",
        previous_page_digest: previous,
        payload:
          pageIndex === 0
            ? {
                verdict: "fail",
                review_markdown: "Adjudicated.",
                summary: "Candidates reviewed.",
                informational_notes: [],
                candidate_count: 80,
                candidate_ids_digest: candidateDigest,
              }
            : {
                decisions: assigned.map((id) => ({
                  source_finding_id: id,
                  decision: "confirmed",
                  rationale: "Confirmed by cited evidence.",
                  cited_evidence: [],
                  unverified_assumptions: [],
                })),
              },
      });
      collector.addPage(raw);
      previous = digest(raw);
    }
    expect(collector.complete).toBe(true);
    expect(
      (collector.assemble() as { decisions: unknown[] }).decisions,
    ).toHaveLength(80);
  });

  it("rejects decision IDs outside the exact core assignment", () => {
    const collector = createResultPageCollector({
      resultId: "adj-1",
      resultKind: "adjudication",
      candidateIds: ["a", "b"],
    });
    const header = rawPage({
      schema_version: "1",
      kind: "review-mesh.result-page",
      result_id: "adj-1",
      result_kind: "adjudication",
      result_schema_version: "2",
      page_index: 0,
      page_count: 2,
      page_kind: "header",
      previous_page_digest: null,
      payload: {
        verdict: "fail",
        review_markdown: "Review",
        summary: "Summary",
        informational_notes: [],
        candidate_count: 2,
        candidate_ids_digest: digest(JSON.stringify(["a", "b"])),
      },
    });
    collector.addPage(header);
    expect(() =>
      collector.addPage(
        rawPage({
          schema_version: "1",
          kind: "review-mesh.result-page",
          result_id: "adj-1",
          result_kind: "adjudication",
          result_schema_version: "2",
          page_index: 1,
          page_count: 2,
          page_kind: "decisions",
          previous_page_digest: digest(header),
          payload: {
            decisions: ["a", "c"].map((id) => ({
              source_finding_id: id,
              decision: "confirmed",
              rationale: "Confirmed.",
              cited_evidence: [],
              unverified_assumptions: [],
            })),
          },
        }),
      ),
    ).toThrow(ResultPageError);
  });
});
