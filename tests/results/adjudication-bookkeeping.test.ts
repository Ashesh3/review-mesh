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
import { privatePayloadSchemas } from "../../src/diagnostics/artifact-payloads.js";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const envelope = {
  schema_version: "1",
  kind: "review-mesh.result-page",
  result_id: "adjudication",
  result_kind: "adjudication",
  result_schema_version: "2",
};
const decision = (id: string) => ({
  source_finding_id: id,
  decision: "confirmed",
  rationale: "Verified synthetic evidence.",
  cited_evidence: [],
  unverified_assumptions: [],
});
function header(
  ids: string[],
  overrides: Record<string, unknown> = {},
  pageCount = 1 + Math.ceil(ids.length / 4),
) {
  return JSON.stringify({
    ...envelope,
    page_index: 0,
    page_count: pageCount,
    previous_page_digest: null,
    page_kind: "header",
    payload: {
      verdict: ids.length ? "fail" : "pass",
      summary: "Synthetic adjudication.",
      review_markdown: "Synthetic result.",
      informational_notes: [],
      candidate_count: ids.length,
      candidate_ids_digest: digest(JSON.stringify(ids)),
      ...overrides,
    },
  });
}
function page(
  previous: string,
  index: number,
  ids: string[],
  items = ids.map(decision),
  pageCount = 2,
) {
  return JSON.stringify({
    ...envelope,
    page_index: index,
    page_count: pageCount,
    previous_page_digest: digest(previous),
    page_kind: "decisions",
    payload: { decisions: items },
  });
}

describe("host-owned adjudication bookkeeping", () => {
  it("chunks all 256 assigned IDs losslessly into bounded durable drafts and deduplicates repeats", async () => {
    const ids = Array.from({ length: 256 }, (_, i) => `${i}`.padEnd(256, "x"));
    const c = createResultPageCollector({
      resultId: envelope.result_id,
      resultKind: "adjudication",
      candidateIds: ids,
    });
    const records: any[] = [];
    const input = {
      recordDiagnostic: async (value: unknown) => {
        records.push(value);
      },
    } as AdapterReviewInput;
    await recordResultPageDraft(input, c);
    await recordResultPageDraft(input, c);
    expect(records).toHaveLength(4);
    expect(records.flatMap((record) => record.assigned_candidate_ids)).toEqual(
      ids,
    );
    expect(records.flatMap((record) => record.missing_decision_ids)).toEqual(
      ids,
    );
    expect(
      records.every(
        (record) => Buffer.byteLength(JSON.stringify(record)) <= 256 * 1024,
      ),
    ).toBe(true);
    for (const record of records)
      expect(() =>
        privatePayloadSchemas["reviewer.draft"]!.parse({
          ...record,
          attempt: 1,
          verified: false,
        }),
      ).not.toThrow();
  });
  it.each([0, 2, 5, 256])(
    "assigns and completes %i candidates using host totals",
    (count) => {
      const ids = Array.from({ length: count }, (_, i) => `candidate-${i + 1}`);
      const c = createResultPageCollector({
        resultId: envelope.result_id,
        resultKind: "adjudication",
        candidateIds: ids,
      });
      const assignment = JSON.parse(
        resultPageRequestMessage(c.nextRequest(), "adjudication"),
      );
      expect(assignment).toMatchObject({
        page_count: 1 + Math.ceil(count / 4),
        candidate_count: count,
        candidate_ids_digest: digest(JSON.stringify(ids)),
        assigned_candidate_ids: ids,
        candidate_ids: [],
      });
      const schema = resultPageSchemaFor(
        c.nextRequest(),
        "adjudication",
      ) as any;
      expect(schema.anyOf[0].properties.page_count.const).toBe(
        1 + Math.ceil(count / 4),
      );
      expect(
        schema.anyOf[0].properties.payload.properties.candidate_count.const,
      ).toBe(count);
      expect(
        schema.anyOf[0].properties.payload.properties.candidate_ids_digest
          .const,
      ).toBe(digest(JSON.stringify(ids)));
      let previous = header(ids);
      c.addPage(previous);
      for (let index = 1; index <= Math.ceil(count / 4); index++) {
        const assigned = ids.slice((index - 1) * 4, index * 4);
        expect(c.nextRequest().candidateIds).toEqual(assigned);
        previous = page(
          previous,
          index,
          assigned,
          assigned.map(decision),
          1 + Math.ceil(count / 4),
        );
        c.addPage(previous);
      }
      expect(c.complete).toBe(true);
      expect((c.assemble() as { decisions: unknown[] }).decisions).toHaveLength(
        count,
      );
    },
  );

  it("corrects representation metadata without altering raw page-chain identity", () => {
    const ids = ["a", "b"];
    const c = createResultPageCollector({
      resultId: envelope.result_id,
      resultKind: "adjudication",
      candidateIds: ids,
    });
    const h = header(
      ids,
      { candidate_count: 0, candidate_ids_digest: "0".repeat(64) },
      1,
    );
    c.addPage(h);
    expect(c.complete).toBe(false);
    expect(c.nextRequest()).toMatchObject({
      pageCount: 2,
      previousPageDigest: digest(h),
      candidateIds: ids,
    });
    expect(c.draft().metadataCorrections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "page_count",
          message: expect.stringContaining("Expected 2; received 1"),
        }),
        expect.objectContaining({ path: "payload.candidate_count" }),
        expect.objectContaining({ path: "payload.candidate_ids_digest" }),
      ]),
    );
    const finalPage = page(h, 1, ids, ids.map(decision), 1);
    c.addPage(finalPage);
    for (const [index, raw] of [h, finalPage].entries())
      expect(() =>
        privatePayloadSchemas["reviewer.result_page"]!.parse({
          index,
          raw,
          sha256: digest(raw),
        }),
      ).not.toThrow();
    expect((c.assemble() as { decisions: unknown[] }).decisions).toHaveLength(
      2,
    );
  });

  it("reports missing decisions and rejects header-only completion", () => {
    const ids = ["a", "b"];
    const c = createResultPageCollector({
      resultId: envelope.result_id,
      resultKind: "adjudication",
      candidateIds: ids,
    });
    c.addPage(header(ids, {}, 1));
    let error: ResultPageError | undefined;
    try {
      c.assemble();
    } catch (e) {
      error = e as ResultPageError;
    }
    expect(error?.validationIssues).toContainEqual(
      expect.objectContaining({
        path: "payload.decisions",
        message: expect.stringContaining("Expected 2; received 0"),
      }),
    );
    expect(c.draft().adjudication).toEqual({
      assignedCandidateIds: ids,
      acceptedDecisionIds: [],
      missingDecisionIds: ids,
    });
  });

  it.each([[["a", "a"]], [["b", "a"]], [["a", "foreign"]], [["a"]]])(
    "rejects invalid decision assignment %j",
    (returned) => {
      const ids = ["a", "b"];
      const c = createResultPageCollector({
        resultId: envelope.result_id,
        resultKind: "adjudication",
        candidateIds: ids,
      });
      const h = header(ids);
      c.addPage(h);
      expect(() => c.addPage(page(h, 1, returned))).toThrow(ResultPageError);
      expect(c.complete).toBe(false);
    },
  );

  it("preserves valid decision siblings and content across repair and outer attempts", () => {
    const ids = ["a", "b"];
    const preservation = createResultPagePreservation();
    const c = createResultPageCollector({
      resultId: envelope.result_id,
      resultKind: "adjudication",
      candidateIds: ids,
      preservation,
    });
    const h = header(ids);
    c.addPage(h);
    expect(() =>
      c.addPage(
        page(h, 1, ids, [
          decision("a"),
          { ...decision("b"), decision: "invalid" },
        ]),
      ),
    ).toThrow();
    expect(c.draft().decisions).toEqual([decision("a")]);
    const next = createResultPageCollector({
      resultId: envelope.result_id,
      resultKind: "adjudication",
      candidateIds: ids,
      preservation,
    });
    next.addPage(h);
    expect(next.nextRequest().adjudication?.preservedDecisions).toEqual([
      decision("a"),
    ]);
    expect(() =>
      next.addPage(
        page(h, 1, ids, [
          { ...decision("a"), decision: "rejected" },
          decision("b"),
        ]),
      ),
    ).toThrow(/preserve/);
    next.addPage(page(h, 1, ids));
    expect(
      (next.assemble() as { decisions: unknown[] }).decisions,
    ).toHaveLength(2);
  });

  it("rejects malformed raw metadata instead of persisting schema-invalid wire pages", () => {
    const ids = ["a", "b"];
    const c = createResultPageCollector({
      resultId: envelope.result_id,
      resultKind: "adjudication",
      candidateIds: ids,
    });
    expect(() =>
      c.addPage(header(ids, { candidate_ids_digest: "not-a-digest" })),
    ).toThrow(ResultPageError);
    expect(c.complete).toBe(false);
  });

  it("does not preserve a foreign decision or accept a broken raw digest chain", () => {
    const ids = ["a", "b"];
    const c = createResultPageCollector({
      resultId: envelope.result_id,
      resultKind: "adjudication",
      candidateIds: ids,
    });
    const h = header(ids);
    c.addPage(h);
    expect(() => c.addPage(page(h, 1, ["a", "foreign"]))).toThrow();
    expect(c.draft().decisions?.map((item) => item.source_finding_id)).toEqual([
      "a",
    ]);
    const broken = JSON.parse(page(h, 1, ids));
    broken.previous_page_digest = "0".repeat(64);
    expect(() => c.addPage(JSON.stringify(broken))).toThrow(/digest/);
  });

  it("keeps completed decision pages across restart while limiting retained payloads to one page", () => {
    const ids = ["a", "b", "c", "d", "e"];
    const first = createResultPageCollector({
      resultId: envelope.result_id,
      resultKind: "adjudication",
      candidateIds: ids,
    });
    const h = header(ids);
    first.addPage(h);
    first.addPage(
      page(h, 1, ids.slice(0, 4), ids.slice(0, 4).map(decision), 3),
    );
    expect(first.draft().adjudication).toMatchObject({
      acceptedDecisionIds: ids.slice(0, 4),
      missingDecisionIds: ["e"],
    });
    const restarted = first.restart();
    expect(
      restarted.nextRequest().adjudication?.preservedDecisions,
    ).toHaveLength(0);
    restarted.addPage(h);
    expect(
      restarted.nextRequest().adjudication?.preservedDecisions,
    ).toHaveLength(4);
    const p = page(h, 1, ids.slice(0, 4), ids.slice(0, 4).map(decision), 3);
    restarted.addPage(p);
    expect(
      restarted.nextRequest().adjudication?.preservedDecisions,
    ).toHaveLength(0);
    restarted.addPage(page(p, 2, ["e"], [decision("e")], 3));
    expect(
      (restarted.assemble() as { decisions: unknown[] }).decisions,
    ).toHaveLength(5);
  });

  it("refuses to reuse decisions for a changed candidate assignment", () => {
    const preservation = createResultPagePreservation();
    createResultPageCollector({
      resultId: envelope.result_id,
      resultKind: "adjudication",
      candidateIds: ["a"],
      preservation,
    });
    expect(() =>
      createResultPageCollector({
        resultId: envelope.result_id,
        resultKind: "adjudication",
        candidateIds: ["b"],
        preservation,
      }),
    ).toThrow(/candidate assignment/);
  });
  it("bounds assigned IDs before they reach schemas or durable diagnostics", () => {
    expect(() =>
      createResultPageCollector({
        resultId: envelope.result_id,
        resultKind: "adjudication",
        candidateIds: ["x".repeat(257)],
      }),
    ).toThrow(/1-256/);
  });
});
