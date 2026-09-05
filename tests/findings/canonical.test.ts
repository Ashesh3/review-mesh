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
    evidence: [
      {
        path: "src/shared.ts",
        start_line: 10,
        end_line: 14,
        detail: `${reviewerId} evidence.`,
      },
    ],
    suggested_direction: "Restore the invariant.",
    confidence: "high",
    classification: "confirmed_defect",
    external_assumptions: [],
    source_findings: [{ reviewer_id: reviewerId, finding_id: findingId }],
    duplicate_finding_ids: [],
    adjudication: "unadjudicated",
    category: "correctness",
    claim: {
      trigger: "The changed path executes",
      affected_behavior: "The operation violates the invariant",
      outcome: "The caller observes failure",
    },
    ...overrides,
  };
}

describe("canonicalizeFindings historical aliases", () => {
  it("retains rejected sources in explicit non-gating counts", () => {
    const confirmed = finding("reliability::source", "confirmed", {
      adjudication: "confirmed",
    });
    const rejected = finding("cleanup::source", "rejected", {
      adjudication: "rejected",
      claim: {
        trigger: "Cleanup runs",
        affected_behavior: "Cleanup retains a temporary file",
        outcome: "Disk usage leaks",
      },
    });

    const result = canonicalizeFindings([rejected, confirmed]);

    expect(result.raw.map((item) => item.finding_id)).toEqual([
      "rejected",
      "confirmed",
    ]);
    expect(result.consolidated).toHaveLength(2);
    expect(result.counts).toMatchObject({
      raw: 2,
      unique: 2,
      gate: 1,
      advisory: 1,
      rejected_subfindings: 1,
    });
  });

  it("uses roots for grouping while preserving two distinct subfindings", () => {
    const result = canonicalizeFindings([
      finding("contract::one", "one", {
        root_issue_id: "published-nullability",
        claim: {
          trigger: "The producer publishes null",
          affected_behavior: "The public type omits null",
          outcome: "Consumers dereference null",
        },
      }),
      finding("contract::two", "two", {
        root_issue_id: "published-nullability",
        severity: "critical",
        claim: {
          trigger: "The consumer receives null",
          affected_behavior: "The mapper assumes a value",
          outcome: "The request crashes",
        },
      }),
    ]);

    expect(result.consolidated).toHaveLength(2);
    expect(result.roots).toEqual([
      expect.objectContaining({
        id: "published-nullability",
        subfindings: expect.arrayContaining([
          expect.objectContaining({ severity: "critical" }),
          expect.objectContaining({ severity: "high" }),
        ]),
      }),
    ]);
  });

  it("does not collapse rootless legacy wording without concrete evidence anchors", () => {
    const result = canonicalizeFindings([
      finding("tests::one", "one", {
        title: "Enum mapping throws",
        evidence: [{ detail: "First prose-only assertion." }],
      }),
      finding("tests::two", "two", {
        title: " enum-mapping THROWS ",
        evidence: [{ detail: "Second prose-only assertion." }],
      }),
    ]);

    expect(result.consolidated).toHaveLength(2);
  });

  it("requires structural compatibility for explicit duplicate references", () => {
    const compatible = finding("financial::one", "root");
    const duplicate = finding("contract::two", "duplicate", {
      duplicate_of: compatible.source_ref,
    });
    const incompatible = finding("cleanup::one", "reference", {
      duplicate_finding_ids: ["root"],
      claim: {
        trigger: "Cleanup runs",
        affected_behavior: "Cleanup retains a temporary file",
        outcome: "Disk usage leaks",
      },
    });

    const result = canonicalizeFindings([incompatible, duplicate, compatible]);

    expect(
      result.consolidated.find((item) => item.source_findings.length === 2)
        ?.source_findings,
    ).toEqual([
      { reviewer_id: "contract::two", finding_id: "duplicate" },
      { reviewer_id: "financial::one", finding_id: "root" },
    ]);
    expect(result.consolidated).toHaveLength(2);
  });

  it("is stable across input order and keeps gate/advisory aliases", () => {
    const values = [
      finding("zeta::one", "gate"),
      finding("alpha::one", "verify", {
        classification: "needs_verification",
        claim: {
          trigger: "Proof is incomplete",
          affected_behavior: "The operation may violate the invariant",
          outcome: "The outcome is uncertain",
        },
      }),
      finding("beta::one", "advisory", {
        severity: "low",
        classification: "advisory",
        claim: {
          trigger: "Formatting runs",
          affected_behavior: "The output uses an old label",
          outcome: "The label is stale",
        },
      }),
    ];

    const forward = canonicalizeFindings(values);
    const reverse = canonicalizeFindings([...values].reverse());

    expect(reverse).toEqual(forward);
    expect(forward.gate_effective).toHaveLength(1);
    expect(forward.advisory).toHaveLength(2);
    expect(forward.counts).toMatchObject({
      raw: 3,
      unique: 3,
      gate: 1,
      advisory: 2,
    });
  });

  it("applies resolved per-lens severity and confidence thresholds", () => {
    const values = [
      finding("strict::medium", "medium", {
        lens_id: "strict",
        severity: "medium",
        confidence: "high",
        claim: {
          trigger: "Medium issue runs",
          affected_behavior: "Medium behavior changes",
          outcome: "Medium impact occurs",
        },
      }),
      finding("strict::uncertain", "uncertain", {
        lens_id: "strict",
        severity: "high",
        confidence: "medium",
        claim: {
          trigger: "Uncertain issue runs",
          affected_behavior: "Uncertain behavior changes",
          outcome: "Uncertain impact occurs",
        },
      }),
      finding("strict::gate", "gate", {
        lens_id: "strict",
        severity: "high",
        confidence: "high",
        claim: {
          trigger: "Gate issue runs",
          affected_behavior: "Gate behavior changes",
          outcome: "Gate impact occurs",
        },
      }),
    ];

    const result = canonicalizeFindings(values, {
      gatePolicies: {
        strict: { minimumSeverity: "high", minimumConfidence: "high" },
      },
    });

    expect(result.gate_effective).toHaveLength(1);
    expect(result.counts).toMatchObject({ gate: 1, advisory: 2 });
  });

  it("allows low severity only when the resolved threshold is low", () => {
    const low = finding("configurable::primary", "low-defect", {
      lens_id: "configurable",
      severity: "low",
      confidence: "high",
    });

    expect(canonicalizeFindings([low]).counts).toMatchObject({
      raw: 1,
      unique: 1,
      gate: 0,
      advisory: 1,
    });
    expect(
      canonicalizeFindings([low], {
        gatePolicies: {
          configurable: {
            minimumSeverity: "low",
            minimumConfidence: "medium",
          },
        },
      }).counts,
    ).toMatchObject({ raw: 1, unique: 1, gate: 1, advisory: 0 });
  });

  it("never gates needs-verification at the lowest thresholds", () => {
    const uncertain = finding("configurable::primary", "uncertain", {
      lens_id: "configurable",
      severity: "low",
      confidence: "low",
      classification: "needs_verification",
    });

    expect(
      canonicalizeFindings([uncertain], {
        gatePolicies: {
          configurable: {
            minimumSeverity: "low",
            minimumConfidence: "low",
          },
        },
      }).counts,
    ).toMatchObject({ raw: 1, unique: 1, gate: 0, advisory: 1 });
  });
});
