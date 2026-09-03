import { describe, expect, it } from "vitest";
import {
  canonicalizeFindings,
  type CanonicalRawFinding,
} from "../../src/findings/canonical.js";

function finding(
  reviewerId: string,
  findingId: string,
  overrides: Partial<CanonicalRawFinding> = {},
): CanonicalRawFinding {
  return {
    source_ref: `${reviewerId}#${findingId}`,
    reviewer_id: reviewerId,
    lens_id: reviewerId.split("::")[0]!,
    finding_id: findingId,
    severity: "high",
    title: "Shared failure",
    description: `${reviewerId} observed the failure.`,
    evidence: [{ detail: `${reviewerId} evidence.` }],
    suggested_direction: "Restore the invariant.",
    confidence: "high",
    classification: "confirmed_defect",
    external_assumptions: [],
    source_findings: [{ reviewer_id: reviewerId, finding_id: findingId }],
    duplicate_finding_ids: [],
    gate_eligible: true,
    adjudication: "unadjudicated",
    ...overrides,
  };
}

describe("canonicalizeFindings", () => {
  it("retains confirmed and rejected sources while excluding rejected candidates from derived counts", () => {
    const confirmed = finding("reliability::source", "confirmed", {
      adjudication: "confirmed",
    });
    const rejected = finding("cleanup::source", "rejected", {
      adjudication: "rejected",
      title: "Rejected candidate",
    });

    const result = canonicalizeFindings([rejected, confirmed]);

    expect(result.raw.map((item) => item.finding_id)).toEqual([
      "rejected",
      "confirmed",
    ]);
    expect(result.consolidated.map((item) => item.id)).toEqual(["confirmed"]);
    expect(result.counts).toEqual({ raw: 2, unique: 1, gate: 1, advisory: 0 });
  });

  it("merges explicit roots and preserves every source, description, evidence item, and direction", () => {
    const result = canonicalizeFindings([
      finding("contract::one", "one", {
        root_issue_id: "published-nullability",
        title: "First wording",
        description: "First description.",
        suggested_direction: "Repair producer typing.",
      }),
      finding("contract::two", "two", {
        root_issue_id: "published-nullability",
        severity: "critical",
        title: "Second wording",
        description: "Second description.",
        suggested_direction: "Repair consumer mapping.",
      }),
    ]);

    expect(result.consolidated).toHaveLength(1);
    expect(result.consolidated[0]).toMatchObject({
      id: "two",
      severity: "critical",
      descriptions: ["First description.", "Second description."],
      suggested_directions: [
        "Repair consumer mapping.",
        "Repair producer typing.",
      ],
      source_findings: [
        { reviewer_id: "contract::one", finding_id: "one" },
        { reviewer_id: "contract::two", finding_id: "two" },
      ],
    });
    expect(result.consolidated[0]?.evidence).toHaveLength(2);
  });

  it("merges rootless findings by exact normalized title even when descriptions differ", () => {
    const result = canonicalizeFindings([
      finding("tests::one", "one", {
        title: "Enum mapping throws",
        description: "The first description.",
      }),
      finding("tests::two", "two", {
        title: "  enum-mapping THROWS ",
        description: "A materially different description.",
      }),
    ]);

    expect(result.consolidated).toHaveLength(1);
    expect(result.consolidated[0]?.descriptions).toEqual([
      "A materially different description.",
      "The first description.",
    ]);
  });

  it("does not use an ambiguous title to merge distinct explicit roots", () => {
    const values = [
      finding("runtime::one", "root-a", {
        root_issue_id: "root-a",
        title: "Generic failure",
        description: "First rooted defect.",
      }),
      finding("runtime::two", "root-b", {
        root_issue_id: "root-b",
        title: "Generic failure",
        description: "Second rooted defect.",
      }),
      finding("runtime::three", "rootless", {
        title: "Generic failure",
        description: "Legacy observation.",
      }),
    ];

    const result = canonicalizeFindings(values);

    expect(result.consolidated).toHaveLength(3);
    expect(result.consolidated.map((item) => item.source_findings)).toEqual(
      expect.arrayContaining([
        [{ reviewer_id: "runtime::one", finding_id: "root-a" }],
        [{ reviewer_id: "runtime::two", finding_id: "root-b" }],
        [{ reviewer_id: "runtime::three", finding_id: "rootless" }],
      ]),
    );
  });

  it("unions explicit duplicate references without merging ambiguous bare ids", () => {
    const values = [
      finding("financial::one", "root"),
      finding("contract::two", "duplicate", {
        duplicate_of: "financial::one#root",
      }),
      finding("tests::one", "ambiguous", {
        title: "First unrelated issue",
      }),
      finding("design::one", "ambiguous", {
        title: "Second unrelated issue",
      }),
      finding("cleanup::one", "reference", {
        title: "Third unrelated issue",
        duplicate_finding_ids: ["ambiguous"],
      }),
    ];

    const result = canonicalizeFindings(values);

    expect(
      result.consolidated.find((item) => item.source_findings.length === 2)
        ?.source_findings,
    ).toEqual([
      { reviewer_id: "contract::two", finding_id: "duplicate" },
      { reviewer_id: "financial::one", finding_id: "root" },
    ]);
    expect(result.consolidated).toHaveLength(4);
  });

  it("is stable across input order and separates gate-effective findings from advisory findings", () => {
    const values = [
      finding("zeta::one", "gate"),
      finding("alpha::one", "verify", {
        title: "Needs proof",
        classification: "needs_verification",
        gate_eligible: false,
      }),
      finding("beta::one", "advisory", {
        title: "Advisory",
        severity: "low",
        classification: "advisory",
        gate_eligible: false,
      }),
    ];

    const forward = canonicalizeFindings(values);
    const reverse = canonicalizeFindings([...values].reverse());

    expect(reverse).toEqual(forward);
    expect(forward.gate_effective.map((item) => item.id)).toEqual(["gate"]);
    expect(forward.advisory.map((item) => item.id)).toEqual([
      "verify",
      "advisory",
    ]);
    expect(forward.counts).toEqual({ raw: 3, unique: 3, gate: 1, advisory: 2 });
  });
});
