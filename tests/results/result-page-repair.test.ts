import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createResultPageCollector,
  createResultPagePreservation,
  ResultPageError,
} from "../../src/results/result-pages.js";
import {
  resultPageRequestMessage,
  resultPageSchemaFor,
} from "../../src/adapters/openai-pages.js";
import { recordResultPageDraft } from "../../src/adapters/sdk-pages.js";
import type { AdapterReviewInput } from "../../src/adapters/types.js";

const digest = (raw: string) => createHash("sha256").update(raw).digest("hex");
const candidate = (id: string) => ({
  id,
  severity: "high",
  title: "Candidate",
  description: "A defect.",
  evidence: [{ path: "a.ts", start_line: 1, end_line: 1, detail: "Evidence." }],
  suggested_direction: "Fix it.",
  confidence: "high",
  classification: "confirmed_defect",
  external_assumptions: [],
  category: "correctness",
  verification: "Test it.",
  claim: {
    trigger: "The path runs.",
    affected_behavior: "Value changes.",
    outcome: "Wrong result.",
  },
});
const envelope = {
  schema_version: "1",
  kind: "review-mesh.result-page",
  result_id: "repair",
  result_kind: "reviewer",
  result_schema_version: "4",
};
function header(overrides: Record<string, unknown> = {}, pageCount = 2) {
  return JSON.stringify({
    ...envelope,
    page_index: 0,
    page_count: pageCount,
    previous_page_digest: null,
    page_kind: "header",
    payload: {
      verdict: "fail",
      summary: "Candidates.",
      informational_notes: [],
      actionable_finding_count: 2,
      narrative_fragment_count: 0,
      narrative_byte_count: 0,
      ...overrides,
    },
  });
}
function findings(previous: string, items: unknown[]) {
  return JSON.stringify({
    ...envelope,
    page_index: 1,
    page_count: 2,
    previous_page_digest: digest(previous),
    page_kind: "findings",
    payload: { actionable_findings: items },
  });
}

describe("result assembly recovery", () => {
  it("redacts credential keys in rejected JSON draft excerpts", async () => {
    const c = createResultPageCollector({
      resultId: "repair",
      resultKind: "reviewer",
    });
    const records: unknown[] = [];
    const input = {
      recordDiagnostic: async (value: unknown) => {
        records.push(value);
      },
    } as AdapterReviewInput;
    await recordResultPageDraft(
      input,
      c,
      undefined,
      JSON.stringify({
        api_key: "plain-sensitive-value",
        payload: { summary: "Diagnostic" },
      }),
    );
    expect(JSON.stringify(records)).not.toContain("plain-sensitive-value");
  });
  it("preserves candidates across outer attempts with a new result identity", () => {
    const preservation = createResultPagePreservation();
    const first = createResultPageCollector({
      resultId: "repair",
      resultKind: "reviewer",
      preservation,
    });
    const h = header();
    first.addPage(h);
    first.addPage(findings(h, [candidate("f-1")]));
    const second = createResultPageCollector({
      resultId: "next-attempt",
      resultKind: "reviewer",
      preservation,
    });
    const empty = JSON.parse(
      header({ verdict: "pass", actionable_finding_count: 0 }, 1),
    );
    empty.result_id = "next-attempt";
    expect(() => second.addPage(JSON.stringify(empty))).toThrow(/preserve/);
    expect(second.nextRequest().preservedCandidateIds).toEqual(["f-1"]);
  });
  it("pins accepted header and phase into continuation assignments", () => {
    const c = createResultPageCollector({
      resultId: "repair",
      resultKind: "reviewer",
    });
    c.addPage(header());
    const request = c.nextRequest();
    expect(
      JSON.parse(resultPageRequestMessage(request, "reviewer")),
    ).toMatchObject({
      page_count: 2,
      expected_page_kind: "findings",
      remaining_counts: { actionable_findings: 2 },
    });
    const schema = resultPageSchemaFor(request, "reviewer") as any;
    expect(schema.anyOf).toHaveLength(1);
    expect(schema.anyOf[0].properties.page_count).toEqual({
      type: "integer",
      const: 2,
    });
    expect(schema.anyOf[0].properties.page_kind.const).toBe("findings");
  });

  it("preserves valid candidates and unresolved counts across regeneration", () => {
    const c = createResultPageCollector({
      resultId: "repair",
      resultKind: "reviewer",
    });
    const h = header();
    c.addPage(h);
    c.addPage(findings(h, [candidate("f-1")]));
    expect(() => c.assemble()).toThrow("actionable finding count");
    const next = c.restart();
    expect(() =>
      next.addPage(header({ verdict: "pass", actionable_finding_count: 0 }, 1)),
    ).toThrow(/preserve/);
    expect(next.draft().candidateIds).toEqual(["f-1"]);
    expect(next.draft().unresolvedObligations.length).toBeGreaterThan(0);
    next.addPage(h);
    expect(() =>
      next.addPage(findings(h, [candidate("f-2"), candidate("f-3")])),
    ).not.toThrow();
    expect(() => next.assemble()).toThrow(/preserve.*candidate/);
  });

  it("repairs an underfilled final findings page while retaining its valid item", () => {
    const c = createResultPageCollector({
      resultId: "repair",
      resultKind: "reviewer",
    });
    const h = header();
    c.addPage(h);
    c.addPage(findings(h, [candidate("f-1")]));
    const repair = c.repairAssembly();
    expect(repair?.nextRequest().pageIndex).toBe(1);
    repair!.addPage(findings(h, [candidate("f-1"), candidate("f-2")]));
    expect(repair!.assemble()).toMatchObject({
      actionable_findings: [{ id: "f-1" }, { id: "f-2" }],
    });
  });

  it("retains a valid sibling item when another finding fails its schema", () => {
    const c = createResultPageCollector({
      resultId: "repair",
      resultKind: "reviewer",
    });
    const h = header();
    c.addPage(h);
    expect(() =>
      c.addPage(
        findings(h, [
          candidate("f-1"),
          { ...candidate("f-2"), severity: "invalid" },
        ]),
      ),
    ).toThrow(ResultPageError);
    expect(c.draft().candidates).toHaveLength(1);
    const modified = { ...candidate("f-1"), description: "A weakened claim." };
    expect(() => c.addPage(findings(h, [modified, candidate("f-2")]))).toThrow(
      /preserve/,
    );
  });

  it("computes UTF-8 representation bytes but still rejects missing fragments", () => {
    const c = createResultPageCollector({
      resultId: "repair",
      resultKind: "reviewer",
    });
    const h = header({
      verdict: "pass",
      actionable_finding_count: 0,
      narrative_fragment_count: 1,
      narrative_byte_count: 1,
    });
    c.addPage(h);
    c.addPage(
      JSON.stringify({
        ...envelope,
        page_index: 1,
        page_count: 2,
        previous_page_digest: digest(h),
        page_kind: "narrative",
        payload: { text_fragment: "é🙂" },
      }),
    );
    expect(c.assemble()).toMatchObject({ review_markdown: "é🙂" });
    const missing = createResultPageCollector({
      resultId: "repair",
      resultKind: "reviewer",
    });
    missing.addPage(
      header(
        {
          verdict: "pass",
          actionable_finding_count: 0,
          narrative_fragment_count: 1,
        },
        1,
      ),
    );
    expect(() => missing.assemble()).toThrow(/narrative/);
  });

  it("retains narrative and coverage declarations when restarting an incomplete assembly", () => {
    const c = createResultPageCollector({
      resultId: "repair",
      resultKind: "reviewer",
    });
    c.addPage(
      header(
        {
          verdict: "pass",
          actionable_finding_count: 0,
          narrative_fragment_count: 1,
          coverage_attestation: {
            scope_digest: "a".repeat(64),
            entry_count: 1,
            entries_digest: "b".repeat(64),
          },
        },
        1,
      ),
    );
    const next = c.restart();
    expect(() =>
      next.addPage(header({ verdict: "pass", actionable_finding_count: 0 }, 1)),
    ).toThrow(/preserve declared narrative and coverage/);
    expect(next.nextRequest()).toMatchObject({
      minimumNarrativeFragments: 1,
      minimumCoverageEntries: 1,
      coverageScopeDigest: "a".repeat(64),
    });
  });

  it("computes coverage representation digest while retaining count and scope proof", () => {
    const c = createResultPageCollector({
      resultId: "repair",
      resultKind: "reviewer",
    });
    const h = header({
      verdict: "pass",
      actionable_finding_count: 0,
      coverage_attestation: {
        scope_digest: "a".repeat(64),
        entry_count: 1,
        entries_digest: "0".repeat(64),
      },
    });
    c.addPage(h);
    c.addPage(
      JSON.stringify({
        ...envelope,
        page_index: 1,
        page_count: 2,
        previous_page_digest: digest(h),
        page_kind: "coverage",
        payload: {
          entries: [
            {
              path: "a.ts",
              method: "full_file",
              snapshot_digest: "b".repeat(64),
            },
          ],
        },
      }),
    );
    expect(c.assemble()).toMatchObject({
      coverage_attestation: {
        scope_digest: "a".repeat(64),
        entries: [{ path: "a.ts", snapshot_digest: "b".repeat(64) }],
      },
    });
  });

  it("reports useful semantic validation paths without raw provider values", () => {
    const c = createResultPageCollector({
      resultId: "repair",
      resultKind: "reviewer",
    });
    c.addPage(header({ actionable_finding_count: 0 }, 1));
    let error: ResultPageError | undefined;
    try {
      c.assemble();
    } catch (e) {
      error = e as ResultPageError;
    }
    expect(error?.validationIssues.length).toBeGreaterThan(0);
    expect(JSON.stringify(error?.validationIssues)).not.toContain(
      "Candidates.",
    );
  });
});
