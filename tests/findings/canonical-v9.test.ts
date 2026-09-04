import { describe, expect, it } from "vitest";
import {
  buildAdjudicationCandidates,
  buildCanonicalRawFindings,
  canonicalizeFindings,
  CanonicalCandidateLimitError,
  type CanonicalFindingCoreProof,
  type CanonicalRawFinding,
} from "../../src/findings/canonical.js";
import type { ReviewerResultV4 } from "../../src/protocol/v9.js";

function source(
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
    title: "Writes can publish stale state",
    description: "A retry publishes state from the failed attempt.",
    evidence: [
      {
        path: "src/publish.ts",
        start_line: 40,
        end_line: 48,
        detail: "The retry reuses the failed attempt state.",
      },
    ],
    suggested_direction: "Rebuild the state for each attempt.",
    confidence: "high",
    classification: "confirmed_defect",
    external_assumptions: [],
    source_findings: [{ reviewer_id: reviewerId, finding_id: findingId }],
    duplicate_finding_ids: [],
    adjudication: "unadjudicated",
    category: "reliability",
    verification: "Trace the failed attempt into the retry.",
    change_impact: "The changed retry path now publishes stale state.",
    claim: {
      trigger: "A publish attempt fails and is retried",
      affected_behavior: "The retry reuses state from the failed attempt",
      outcome: "Stale state is published",
    },
    ...overrides,
  };
}

const verifiedProof: CanonicalFindingCoreProof = {
  evidence_verified: true,
  source_coverage_verified: true,
  change_impact_verified: true,
  ordered_proof_verified: true,
};

function proofs(
  values: readonly CanonicalRawFinding[],
  override: CanonicalFindingCoreProof = verifiedProof,
): Record<string, CanonicalFindingCoreProof> {
  return Object.fromEntries(
    values.map((value) => [value.source_ref, override]),
  );
}

describe("v9 canonical findings", () => {
  it("collapses compatible duplicates while a shared root only groups distinct atomics", () => {
    const first = source("reliability::one", "stale-a", {
      root_issue_id: "publish-transaction",
    });
    const duplicate = source("reliability::two", "stale-b", {
      root_issue_id: "publish-transaction",
      title: "Retry publishes stale state",
      evidence: [
        {
          path: "src/publish.ts",
          start_line: 45,
          end_line: 52,
          detail: "The overlapping retry block publishes old state.",
        },
      ],
    });
    const cleanup = source("cleanup::one", "leak", {
      root_issue_id: "publish-transaction",
      category: "cleanup",
      title: "Failed publish leaks a temporary snapshot",
      description: "The failure path retains its temporary snapshot.",
      evidence: [
        {
          path: "src/publish.ts",
          start_line: 70,
          end_line: 76,
          detail: "The cleanup branch omits snapshot disposal.",
        },
      ],
      claim: {
        trigger: "A publish attempt fails",
        affected_behavior: "The failure cleanup retains a temporary snapshot",
        outcome: "The snapshot leaks",
      },
    });
    const input = [cleanup, duplicate, first];
    const snapshot = structuredClone(input);

    const canonical = canonicalizeFindings(input, {
      proofBySourceRef: proofs(input),
    });

    expect(input).toEqual(snapshot);
    expect(canonical.atomics).toHaveLength(2);
    expect(canonical.roots).toHaveLength(1);
    expect(canonical.roots[0]?.subfindings).toHaveLength(2);
    expect(canonical.atomics[0]?.source_findings.length).toBeGreaterThan(0);
    expect(
      canonical.atomics.find((atomic) => atomic.source_findings.length === 2)
        ?.source_findings,
    ).toEqual([
      { reviewer_id: "reliability::one", finding_id: "stale-a" },
      { reviewer_id: "reliability::two", finding_id: "stale-b" },
    ]);
    expect(canonical.counts.atomic_subfindings).toBe(2);
    expect(canonical.counts.canonical_roots).toBe(1);
  });

  it("keeps conflicting explicit duplicate claims distinct and diagnoses the relation", () => {
    const target = source("reliability::one", "target");
    const conflicting = source("reliability::two", "conflict", {
      duplicate_of: target.source_ref,
      claim: {
        trigger: "The service shuts down",
        affected_behavior: "The shutdown path skips the final flush",
        outcome: "Buffered records are lost",
      },
      evidence: [
        {
          path: "src/shutdown.ts",
          start_line: 10,
          end_line: 12,
          detail: "The flush is skipped.",
        },
      ],
    });

    const canonical = canonicalizeFindings([conflicting, target], {
      proofBySourceRef: proofs([conflicting, target]),
    });

    expect(canonical.atomics).toHaveLength(2);
    expect(canonical.atomics.flatMap((atomic) => atomic.diagnostics)).toEqual([
      expect.objectContaining({
        code: "conflicting_duplicate_claim",
        source_ref: conflicting.source_ref,
        target_source_ref: target.source_ref,
      }),
    ]);
  });

  it("emits a display-only pairwise proposal for rooted and rootless stale-documentation variants", () => {
    const rooted = source("compatibility::one", "rooted", {
      root_issue_id: "documented-contract",
      category: "compatibility",
      title: "Documented retry contract is stale",
      claim: {
        trigger: "A caller retries a failed publish request",
        affected_behavior: "The documented retry contract reuses failed state",
        outcome: "The caller publishes stale state",
      },
    });
    const rootless = source("compatibility::two", "rootless", {
      category: "compatibility",
      title: "Retry documentation describes stale behavior",
      claim: {
        trigger: "A caller retries the failed publish request",
        affected_behavior:
          "The retry contract documentation reuses failed state",
        outcome: "A caller can publish stale state",
      },
    });

    const canonical = canonicalizeFindings([rootless, rooted], {
      proofBySourceRef: proofs([rootless, rooted]),
    });

    expect(canonical.atomics).toHaveLength(2);
    expect(canonical.roots[0]?.subfindings).toHaveLength(1);
    expect(canonical.semantic_proposals).toEqual([
      expect.objectContaining({
        relation: "semantic_proposal",
        atomic_ids: [...canonical.semantic_proposals[0]!.atomic_ids].sort(),
        existing_root_id: "documented-contract",
      }),
    ]);
    expect(canonical.counts.atomic_subfindings).toBe(2);
    expect(canonical.counts.canonical_roots).toBe(1);
  });

  it("assigns disjoint count buckets and an explanation to every atomic", () => {
    const gate = source("gate::one", "gate");
    const rejected = source("rejected::one", "rejected", {
      adjudication: "rejected",
    });
    const outOfScope = source("scope::one", "scope");
    const advisory = source("advisory::one", "advisory", {
      classification: "advisory",
    });
    const needsProof = source("proof::one", "proof", {
      classification: "needs_verification",
    });
    const belowPolicy = source("policy::one", "policy", {
      severity: "low",
    });
    const values = [
      gate,
      rejected,
      outOfScope,
      advisory,
      needsProof,
      belowPolicy,
    ];
    for (const [index, value] of values.entries()) {
      value.claim = {
        trigger: `Trigger ${index}`,
        affected_behavior: `Behavior ${index}`,
        outcome: `Outcome ${index}`,
      };
      value.evidence = [
        {
          path: `src/bucket-${index}.ts`,
          start_line: 1,
          end_line: 2,
          detail: `Bucket ${index} evidence.`,
        },
      ];
    }
    const proofBySourceRef = proofs(values);
    proofBySourceRef[outOfScope.source_ref] = {
      ...verifiedProof,
      out_of_scope: true,
    };

    const canonical = canonicalizeFindings(values, {
      proofBySourceRef,
      gatePolicies: {
        policy: { minimumSeverity: "high", minimumConfidence: "high" },
      },
    });

    expect(canonical.counts).toMatchObject({
      raw_source_findings: 6,
      atomic_subfindings: 6,
      canonical_roots: 0,
      gate_eligible_subfindings: 1,
      advisory_subfindings: 1,
      rejected_subfindings: 1,
      needs_verification_subfindings: 1,
      out_of_scope_subfindings: 1,
      policy_non_gating_subfindings: 1,
      non_gating_subfindings: 5,
    });
    expect(
      canonical.atomics.every((finding) =>
        finding.gate_eligibility.eligible
          ? finding.gate_eligibility.reasons.length === 0
          : finding.gate_eligibility.reasons.length > 0,
      ),
    ).toBe(true);
  });

  it.each([
    ["classification_not_confirmed", { classification: "advisory" }, {}],
    ["severity_below_threshold", { severity: "low" }, {}],
    ["confidence_below_threshold", { confidence: "low" }, {}],
    ["adjudication_required", {}, { adjudication_required: true }],
    ["adjudication_rejected", { adjudication: "rejected" }, {}],
    ["evidence_unverified", {}, { evidence_verified: false }],
    [
      "ordered_proof_missing",
      {},
      { ordered_proof_required: true, ordered_proof_verified: false },
    ],
    [
      "change_impact_unverified",
      {},
      { change_impact_required: true, change_impact_verified: false },
    ],
    ["source_coverage_unverified", {}, { source_coverage_verified: false }],
    ["out_of_scope", {}, { out_of_scope: true }],
    ["policy_non_gating", {}, { policy_non_gating: true }],
  ] as const)("emits the %s exclusion reason", (reason, overrides, proof) => {
    const value = source("policy::one", reason, overrides);
    const canonical = canonicalizeFindings([value], {
      proofBySourceRef: {
        [value.source_ref]: { ...verifiedProof, ...proof },
      },
      gatePolicies: {
        policy: { minimumSeverity: "high", minimumConfidence: "high" },
      },
    });

    expect(canonical.atomics[0]?.gate_eligibility).toMatchObject({
      eligible: false,
      reasons: expect.arrayContaining([reason]),
    });
  });

  it("treats a needs-verification adjudication disposition as still required", () => {
    const value = source("reliability::one", "pending", {
      adjudication: "needs_verification",
    });

    expect(
      canonicalizeFindings([value], {
        proofBySourceRef: { [value.source_ref]: verifiedProof },
      }).atomics[0]?.gate_eligibility,
    ).toEqual({ eligible: false, reasons: ["adjudication_required"] });
  });

  it("does not let an unrelated coverage deficit suppress verified causal evidence", () => {
    const value = source("reliability::one", "causal");

    const canonical = canonicalizeFindings([value], {
      proofBySourceRef: {
        [value.source_ref]: {
          ...verifiedProof,
          unrelated_coverage_deficits: ["src/unrelated.ts"],
        },
      },
    });

    expect(canonical.atomics[0]?.gate_eligibility).toEqual({
      eligible: true,
      reasons: [],
    });
  });
});

describe("v9 canonical integration builders", () => {
  it("converts reviewer result v4 without accepting provider gate state", () => {
    const result: ReviewerResultV4 = {
      schema_version: "4",
      verdict: "fail",
      review_markdown: "# Review",
      summary: "One failure.",
      actionable_findings: [
        {
          id: "failure",
          severity: "high",
          title: "Failure",
          description: "The failure is observable.",
          evidence: [
            {
              path: "src/failure.ts",
              start_line: 1,
              end_line: 2,
              detail: "The failure occurs here.",
            },
          ],
          suggested_direction: "Repair the failure.",
          confidence: "high",
          classification: "confirmed_defect",
          external_assumptions: [],
          category: "correctness",
          verification: "Reproduce the failure.",
          change_impact: "The changed branch introduces the failure.",
          claim: {
            trigger: "The changed branch runs",
            affected_behavior: "The operation returns the wrong value",
            outcome: "The caller observes failure",
          },
        },
      ],
      informational_notes: [],
      change_coverage: {
        status: "complete",
        proof_kind: "observed",
        scope_digest: "a".repeat(64),
        inspected_count: 1,
        deficit_count: 0,
        deficit_sample: [],
      },
    };

    expect(
      buildCanonicalRawFindings({
        reviewer_id: "correctness::primary",
        lens_id: "correctness",
        result,
      }),
    ).toEqual([
      expect.objectContaining({
        source_ref: "correctness::primary#failure",
        finding_id: "failure",
        claim: result.actionable_findings[0]!.claim,
        source_findings: [
          { reviewer_id: "correctness::primary", finding_id: "failure" },
        ],
      }),
    ]);
  });

  it("builds 80 deterministic bounded candidates and retains every source id", () => {
    const values = Array.from({ length: 80 }, (_, index) =>
      source(`reliability::${index}`, `finding-${index}-${"x".repeat(220)}`, {
        claim: {
          trigger: `Trigger ${index}`,
          affected_behavior: `Behavior ${index}`,
          outcome: `Outcome ${index}`,
        },
        evidence: [
          {
            path: `src/file-${index}.ts`,
            start_line: 1,
            end_line: 2,
            detail: `Evidence ${index}.`,
          },
        ],
      }),
    );
    const forward = buildAdjudicationCandidates(values);
    const reverse = buildAdjudicationCandidates([...values].reverse());

    expect(reverse).toEqual(forward);
    expect(forward.candidates).toHaveLength(80);
    expect(
      forward.candidates.every(
        (candidate) => Buffer.byteLength(candidate.candidate_id, "utf8") <= 256,
      ),
    ).toBe(true);
    expect(
      forward.candidates.flatMap((candidate) => candidate.source_findings),
    ).toHaveLength(80);
  });

  it("coalesces compatible sources before enforcing the 256-candidate limit", () => {
    const values = Array.from({ length: 257 }, (_, index) =>
      source(`reliability::${index}`, `finding-${index}`, {
        claim: {
          trigger: index < 2 ? "Shared trigger" : `Trigger ${index}`,
          affected_behavior:
            index < 2 ? "Shared behavior" : `Behavior ${index}`,
          outcome: index < 2 ? "Shared outcome" : `Outcome ${index}`,
        },
        evidence: [
          {
            path: index < 2 ? "src/shared.ts" : `src/file-${index}.ts`,
            start_line: 1,
            end_line: 2,
            detail: `Evidence ${index}.`,
          },
        ],
      }),
    );

    expect(buildAdjudicationCandidates(values).candidates).toHaveLength(256);
    expect(() =>
      buildAdjudicationCandidates(
        values.map((value, index) => ({
          ...value,
          claim: {
            trigger: `Distinct trigger ${index}`,
            affected_behavior: `Distinct behavior ${index}`,
            outcome: `Distinct outcome ${index}`,
          },
        })),
      ),
    ).toThrow(CanonicalCandidateLimitError);
  });

  it("does not transitively collapse adjacent evidence overlaps", () => {
    const values = [
      source("reliability::one", "first", {
        evidence: [
          {
            path: "src/shared.ts",
            start_line: 1,
            end_line: 5,
            detail: "First range.",
          },
        ],
      }),
      source("reliability::two", "bridge", {
        evidence: [
          {
            path: "src/shared.ts",
            start_line: 5,
            end_line: 9,
            detail: "Bridge range.",
          },
        ],
      }),
      source("reliability::three", "last", {
        evidence: [
          {
            path: "src/shared.ts",
            start_line: 9,
            end_line: 13,
            detail: "Last range.",
          },
        ],
      }),
    ];

    const candidates = buildAdjudicationCandidates(values).candidates;

    expect(candidates).toHaveLength(2);
    expect(
      candidates.map((candidate) => candidate.source_findings.length).sort(),
    ).toEqual([1, 2]);
  });
});
