import { describe, expect, it } from "vitest";
import {
  validateAdjudication,
  type AdjudicationValidationContext,
} from "../../src/findings/adjudication.js";
import type {
  AdjudicationResult,
  ReviewerResultV3,
} from "../../src/protocol/schemas.js";
import type {
  AdjudicationResultV2,
  ReviewerResultV4,
} from "../../src/protocol/v9.js";
import {
  createAdjudicationValidationAttestation,
  verifyAdjudicationValidationAttestation,
} from "../../src/findings/attestation.js";

function candidate(): ReviewerResultV3 {
  return {
    schema_version: "3",
    verdict: "fail",
    review_markdown: "# Review\n\nThe enum throws after ingest.",
    summary: "Enum handling can abort the batch.",
    actionable_findings: [
      {
        id: "enum-post-ingest",
        severity: "high",
        title: "Unknown enum throws after ingest",
        description: "An unknown value throws after the record is ingested.",
        evidence: [
          {
            path: "src/ingest.ts",
            start_line: 40,
            end_line: 45,
            detail: "The candidate attributes the throw to post-ingest work.",
          },
        ],
        suggested_direction: "Handle unknown enum values without aborting.",
        confidence: "high",
        classification: "confirmed_defect",
        external_assumptions: [],
        category: "reliability",
        verification: "The candidate followed the exception path.",
        change_impact: "The HEAD behavior was reported as newly throwing.",
      },
    ],
    informational_notes: [],
  };
}

function context(
  overrides: Partial<AdjudicationValidationContext> = {},
): AdjudicationValidationContext {
  return {
    reviewScope: "changes",
    git: {
      changedFiles: ["src/ingest.ts"],
      diff: [
        "diff --git a/src/ingest.ts b/src/ingest.ts",
        "--- a/src/ingest.ts",
        "+++ b/src/ingest.ts",
        "@@ -30,16 +30,16 @@",
      ].join("\n"),
    },
    evidenceVerification: {
      by_source_finding_id: {
        "enum-post-ingest": { verified: true, failures: [] },
      },
    },
    ...overrides,
  };
}

function adjudication(
  decision: AdjudicationResult["decisions"][number],
): AdjudicationResult {
  return {
    schema_version: "1",
    kind: "review-mesh.adjudication-result",
    verdict: "pass",
    review_markdown:
      "# Adjudication\n\nThe cited control flow maps the enum before ingest.",
    summary: "Candidate evaluated.",
    actionable_findings: [],
    decisions: [decision],
    informational_notes: [],
  };
}

describe("validateAdjudication", () => {
  it("validates all 80 v2 decisions without losing v4 claim or proof fields", () => {
    const actionable_findings = Array.from({ length: 80 }, (_, index) => ({
      id: `candidate-${index}`,
      severity: "high" as const,
      title: `Candidate ${index}`,
      description: `Candidate ${index} describes a defect.`,
      evidence: [
        {
          path: `src/file-${index}.ts`,
          start_line: 1,
          end_line: 2,
          detail: `Candidate ${index} evidence.`,
        },
      ],
      suggested_direction: `Repair candidate ${index}.`,
      confidence: "high" as const,
      classification: "confirmed_defect" as const,
      external_assumptions: [],
      category: "correctness" as const,
      verification: `Verify candidate ${index}.`,
      change_impact: `Candidate ${index} is introduced by HEAD.`,
      claim: {
        trigger: `Trigger ${index}`,
        affected_behavior: `Behavior ${index}`,
        outcome: `Outcome ${index}`,
      },
    }));
    const candidates: ReviewerResultV4 = {
      schema_version: "4",
      verdict: "fail",
      review_markdown: "# Candidates",
      summary: "Eighty candidates.",
      actionable_findings,
      informational_notes: [],
      change_coverage: {
        status: "complete",
        proof_kind: "observed",
        scope_digest: "a".repeat(64),
        inspected_count: 80,
        deficit_count: 0,
        deficit_sample: [],
      },
    };
    const judge: AdjudicationResultV2 = {
      schema_version: "2",
      kind: "review-mesh.adjudication-result",
      verdict: "pass",
      review_markdown: "# Decisions",
      summary: "Every candidate was rejected.",
      actionable_findings: [],
      decisions: actionable_findings.map((finding) => ({
        source_finding_id: finding.id,
        decision: "rejected" as const,
        rationale: `Candidate ${finding.id} is not a defect.`,
        cited_evidence: [],
        unverified_assumptions: [],
      })),
      informational_notes: [],
    };

    const outcome = validateAdjudication(candidates, judge, {
      reviewScope: "full",
    });

    expect(outcome.complete).toBe(true);
    expect(outcome.decisions).toHaveLength(80);
    expect(outcome.candidate_result.actionable_findings[79]).toMatchObject({
      claim: actionable_findings[79]!.claim,
    });
    expect(outcome.adjudication_result.schema_version).toBe("2");
  });

  it("downgrades a contradictory confirmation missing ordered and base/head proof without hiding either review", () => {
    const judge = adjudication({
      source_finding_id: "enum-post-ingest",
      decision: "confirmed",
      rationale:
        "Mapping actually occurs before ingest, but the candidate is repeated as confirmed.",
      cited_evidence: [
        {
          path: "src/ingest.ts",
          start_line: 20,
          end_line: 25,
          detail: "Enum mapping occurs before the ingest call.",
        },
      ],
      unverified_assumptions: [],
    });

    const outcome = validateAdjudication(candidate(), judge, context());

    expect(outcome.candidate_result.review_markdown).toContain(
      "throws after ingest",
    );
    expect(outcome.adjudication_result.review_markdown).toContain(
      "maps the enum before ingest",
    );
    expect(outcome.decisions).toEqual([
      expect.objectContaining({
        source_finding_id: "enum-post-ingest",
        requested_decision: "confirmed",
        effective_decision: "needs_verification",
        gate_eligible: false,
        issues: expect.arrayContaining([
          "ordered_execution_proof_required",
          "base_head_comparison_required",
        ]),
      }),
    ]);
  });

  it("accepts a cited two-step failure proof and cited base/head comparison", () => {
    const judge = adjudication({
      source_finding_id: "enum-post-ingest",
      decision: "confirmed",
      rationale: "The changed ordering makes the exception abort the batch.",
      cited_evidence: [
        {
          path: "src/ingest.ts",
          start_line: 40,
          end_line: 45,
          detail: "The exception escapes the batch loop.",
        },
      ],
      ordered_execution_proof: {
        steps: [
          {
            order: 1,
            description: "The record is accepted.",
            citation: {
              path: "src/ingest.ts",
              start_line: 30,
              end_line: 32,
              detail: "The accept call completes first.",
            },
          },
          {
            order: 2,
            description: "The enum mapping throws.",
            citation: {
              path: "src/ingest.ts",
              start_line: 40,
              end_line: 45,
              detail: "The mapping throws after acceptance.",
            },
          },
        ],
        failure_point: {
          step_order: 2,
          citation: {
            path: "src/ingest.ts",
            start_line: 40,
            end_line: 45,
            detail: "The exception escapes at this concrete location.",
          },
          detail: "The exception escapes at the second step.",
        },
      },
      base_head_comparison: {
        base: {
          behavior: "The base maps unknown values to a sentinel.",
          citation: {
            path: "src/ingest.ts",
            start_line: 40,
            end_line: 42,
            detail: "Base uses a sentinel.",
          },
        },
        head: {
          behavior: "HEAD throws on the same value.",
          citation: {
            path: "src/ingest.ts",
            start_line: 40,
            end_line: 45,
            detail: "HEAD throws.",
          },
        },
        impact: "The change introduced the escaping exception.",
      },
      unverified_assumptions: [],
    });

    expect(
      validateAdjudication(candidate(), judge, context()).decisions,
    ).toEqual([
      expect.objectContaining({
        effective_decision: "confirmed",
        gate_eligible: true,
        issues: [],
      }),
    ]);
  });

  it("rejects detail-only proof citations as needs verification", () => {
    const judge = adjudication({
      source_finding_id: "enum-post-ingest",
      decision: "confirmed",
      rationale: "The prose claims a confirmed ordering defect.",
      cited_evidence: [{ detail: "No concrete repository location." }],
      ordered_execution_proof: {
        steps: [
          {
            order: 1,
            description: "First step.",
            citation: { detail: "No path or line." },
          },
          {
            order: 2,
            description: "Second step.",
            citation: { detail: "Still no path or line." },
          },
        ],
        failure_point: {
          step_order: 2,
          detail: "The claimed failure point has no concrete citation.",
        },
      },
      base_head_comparison: {
        base: {
          behavior: "Base behavior by assertion only.",
          citation: { detail: "No base location." },
        },
        head: {
          behavior: "HEAD behavior by assertion only.",
          citation: { detail: "No HEAD location." },
        },
        impact: "Claimed change impact.",
      },
      unverified_assumptions: [],
    });

    expect(
      validateAdjudication(candidate(), judge, context()).decisions,
    ).toEqual([
      expect.objectContaining({
        effective_decision: "needs_verification",
        gate_eligible: false,
        issues: expect.arrayContaining([
          "cited_evidence_location_required",
          "ordered_execution_citation_required",
          "failure_point_citation_required",
          "base_head_citation_required",
        ]),
      }),
    ]);
  });

  it("returns an adjusted effective finding while retaining the original candidate", () => {
    const judge = adjudication({
      source_finding_id: "enum-post-ingest",
      decision: "adjusted",
      rationale: "The defect exists but is low-severity and advisory.",
      cited_evidence: [
        {
          path: "src/ingest.ts",
          start_line: 40,
          end_line: 45,
          detail: "The fallback prevents batch failure.",
        },
      ],
      adjusted_finding: {
        severity: "low",
        title: "Unknown enum uses fallback",
        description: "The behavior is observable but does not abort ingestion.",
        evidence: [
          {
            path: "src/ingest.ts",
            start_line: 40,
            end_line: 45,
            detail: "The catch maps to a safe sentinel.",
          },
        ],
        suggested_direction: "Document the fallback.",
        confidence: "high",
        classification: "advisory",
        root_issue_id: "enum-fallback",
        external_assumptions: [],
      },
      ordered_execution_proof: {
        steps: [
          {
            order: 1,
            description: "Mapping is attempted.",
            citation: {
              path: "src/ingest.ts",
              start_line: 40,
              end_line: 42,
              detail: "Mapping is attempted here.",
            },
          },
          {
            order: 2,
            description: "Fallback catches the unknown value.",
            citation: {
              path: "src/ingest.ts",
              start_line: 43,
              end_line: 45,
              detail: "Fallback occurs here.",
            },
          },
        ],
        failure_point: {
          step_order: 2,
          citation: {
            path: "src/ingest.ts",
            start_line: 43,
            end_line: 45,
            detail: "The candidate's claimed failure is contained here.",
          },
          detail: "The effective issue is limited to fallback observability.",
        },
      },
      base_head_comparison: {
        base: {
          behavior: "Base rejected the unknown value.",
          citation: {
            path: "src/ingest.ts",
            start_line: 40,
            end_line: 42,
            detail: "Base behavior in the supplied diff.",
          },
        },
        head: {
          behavior: "HEAD catches and maps it.",
          citation: {
            path: "src/ingest.ts",
            start_line: 43,
            end_line: 45,
            detail: "HEAD behavior in the supplied diff.",
          },
        },
        impact: "The change reduced the impact to advisory fallback behavior.",
      },
      unverified_assumptions: [],
    });

    const outcome = validateAdjudication(candidate(), judge, context());

    expect(outcome.candidate_result.actionable_findings[0]).toMatchObject({
      severity: "high",
      title: "Unknown enum throws after ingest",
    });
    expect(outcome.decisions[0]).toMatchObject({
      effective_decision: "adjusted",
      gate_eligible: false,
      effective_finding: {
        id: "enum-post-ingest",
        severity: "low",
        title: "Unknown enum uses fallback",
        classification: "advisory",
        root_issue_id: "enum-fallback",
      },
    });
  });

  it.each([
    "https://attacker.invalid/src/ingest.ts",
    "C:/src/ingest.ts",
    "/src/ingest.ts",
    "../src/ingest.ts",
    ".",
    "",
    "src\\ingest.ts",
    "src/ingest.ts\u0000escape",
    "src/not-reviewed.ts",
  ])("rejects an unsafe or unreviewed citation path %j", (path) => {
    const judge = adjudication({
      source_finding_id: "enum-post-ingest",
      decision: "confirmed",
      rationale: "Claimed confirmation.",
      cited_evidence: [
        { path, start_line: 40, end_line: 45, detail: "Claimed evidence." },
      ],
      ordered_execution_proof: {
        steps: [
          {
            order: 1,
            description: "First.",
            citation: { path, start_line: 40, detail: "First." },
          },
          {
            order: 2,
            description: "Second.",
            citation: { path, start_line: 41, detail: "Second." },
          },
        ],
        failure_point: {
          step_order: 2,
          citation: { path, start_line: 41, detail: "Failure." },
          detail: "Failure.",
        },
      },
      base_head_comparison: {
        base: {
          behavior: "Base.",
          citation: { path, start_line: 40, detail: "Base." },
        },
        head: {
          behavior: "Head.",
          citation: { path, start_line: 41, detail: "Head." },
        },
        impact: "Impact.",
      },
      unverified_assumptions: [],
    });

    expect(
      validateAdjudication(candidate(), judge, context()).decisions[0],
    ).toMatchObject({
      effective_decision: "needs_verification",
      gate_eligible: false,
    });
  });

  it("rejects fabricated base/head locations outside supplied diff hunks", () => {
    const judge = adjudication({
      source_finding_id: "enum-post-ingest",
      decision: "confirmed",
      rationale: "Claimed confirmation.",
      cited_evidence: [
        {
          path: "src/ingest.ts",
          start_line: 40,
          detail: "Candidate-bound evidence.",
        },
      ],
      ordered_execution_proof: {
        steps: [
          {
            order: 1,
            description: "First.",
            citation: {
              path: "src/ingest.ts",
              start_line: 40,
              detail: "First.",
            },
          },
          {
            order: 2,
            description: "Second.",
            citation: {
              path: "src/ingest.ts",
              start_line: 41,
              detail: "Second.",
            },
          },
        ],
        failure_point: {
          step_order: 2,
          citation: {
            path: "src/ingest.ts",
            start_line: 41,
            detail: "Failure.",
          },
          detail: "Failure.",
        },
      },
      base_head_comparison: {
        base: {
          behavior: "Fabricated base.",
          citation: {
            path: "src/ingest.ts",
            start_line: 900,
            detail: "Not in diff.",
          },
        },
        head: {
          behavior: "Fabricated head.",
          citation: {
            path: "src/ingest.ts",
            start_line: 901,
            detail: "Not in diff.",
          },
        },
        impact: "Fabricated impact.",
      },
      unverified_assumptions: [],
    });

    expect(
      validateAdjudication(candidate(), judge, context()).decisions[0],
    ).toMatchObject({
      effective_decision: "needs_verification",
      issues: expect.arrayContaining(["base_head_context_required"]),
    });
  });

  it("allows full-scope ordered proof bound to inspected candidate evidence without a diff", () => {
    const judge = adjudication({
      source_finding_id: "enum-post-ingest",
      decision: "confirmed",
      rationale: "Candidate evidence establishes the ordered failure.",
      cited_evidence: [
        {
          path: "src/ingest.ts",
          start_line: 40,
          end_line: 45,
          detail: "Candidate-bound evidence.",
        },
      ],
      ordered_execution_proof: {
        steps: [
          {
            order: 1,
            description: "Mapping starts.",
            citation: {
              path: "src/ingest.ts",
              start_line: 40,
              detail: "Within candidate evidence.",
            },
          },
          {
            order: 2,
            description: "Exception escapes.",
            citation: {
              path: "src/ingest.ts",
              start_line: 45,
              detail: "Within candidate evidence.",
            },
          },
        ],
        failure_point: {
          step_order: 2,
          citation: {
            path: "src/ingest.ts",
            start_line: 45,
            detail: "Candidate failure point.",
          },
          detail: "Exception escapes.",
        },
      },
      unverified_assumptions: [],
    });

    expect(
      validateAdjudication(candidate(), judge, {
        reviewScope: "full",
        git: { changedFiles: [], diff: "" },
        evidenceVerification: {
          by_source_finding_id: {
            "enum-post-ingest": { verified: true, failures: [] },
          },
        },
      }).decisions[0],
    ).toMatchObject({ effective_decision: "confirmed", gate_eligible: true });
  });

  it("cannot gate without authoritative core evidence verification", () => {
    const judge = adjudication({
      source_finding_id: "enum-post-ingest",
      decision: "confirmed",
      rationale: "Candidate repetition only.",
      cited_evidence: [
        {
          path: "src/ingest.ts",
          start_line: 40,
          end_line: 45,
          detail: "Repeated candidate evidence.",
        },
      ],
      ordered_execution_proof: {
        steps: [
          {
            order: 1,
            description: "First.",
            citation: {
              path: "src/ingest.ts",
              start_line: 40,
              detail: "First.",
            },
          },
          {
            order: 2,
            description: "Second.",
            citation: {
              path: "src/ingest.ts",
              start_line: 45,
              detail: "Second.",
            },
          },
        ],
        failure_point: {
          step_order: 2,
          citation: {
            path: "src/ingest.ts",
            start_line: 45,
            detail: "Failure.",
          },
          detail: "Failure.",
        },
      },
      unverified_assumptions: [],
    });

    expect(
      validateAdjudication(candidate(), judge, {
        reviewScope: "full",
        git: { changedFiles: [], diff: "" },
      }).decisions[0],
    ).toMatchObject({
      effective_decision: "needs_verification",
      gate_eligible: false,
      issues: expect.arrayContaining(["core_evidence_verification_required"]),
    });
  });

  it("binds persisted validation to both results and the context head", () => {
    const candidateResult = candidate();
    const adjudicationResult = adjudication({
      source_finding_id: "enum-post-ingest",
      decision: "rejected",
      rationale: "Rejected.",
      cited_evidence: [],
      unverified_assumptions: [],
    });
    const validationContext = context();
    const attestation = createAdjudicationValidationAttestation({
      candidateResult,
      adjudicationResult,
      contextHead: "abc123",
      validationContext,
    });

    expect(
      verifyAdjudicationValidationAttestation({
        attestation,
        candidateResult,
        adjudicationResult,
        contextHead: "abc123",
        validationContext,
      }),
    ).toEqual(attestation.outcome);
    expect(
      verifyAdjudicationValidationAttestation({
        attestation,
        candidateResult,
        adjudicationResult,
        contextHead: "different",
        validationContext,
      }),
    ).toBeUndefined();
  });

  it("requires exactly one decision for each candidate source id", () => {
    const judge: AdjudicationResult = {
      schema_version: "1",
      kind: "review-mesh.adjudication-result",
      verdict: "pass",
      review_markdown: "# Adjudication\n\nNo matching decision.",
      summary: "Missing decision.",
      actionable_findings: [],
      decisions: [],
      informational_notes: [],
    };

    const outcome = validateAdjudication(candidate(), judge, context());

    expect(outcome.complete).toBe(false);
    expect(outcome.decisions).toEqual([
      expect.objectContaining({
        source_finding_id: "enum-post-ingest",
        effective_decision: "needs_verification",
        issues: ["decision_required"],
      }),
    ]);
  });
});
