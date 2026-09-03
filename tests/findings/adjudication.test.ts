import { describe, expect, it } from "vitest";
import {
  validateAdjudication,
  type AdjudicationValidationContext,
} from "../../src/findings/adjudication.js";
import type {
  AdjudicationResult,
  ReviewerResultV3,
} from "../../src/protocol/schemas.js";

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
  return { reviewScope: "changes", ...overrides };
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

    expect(validateAdjudication(candidate(), judge, context()).decisions).toEqual([
      expect.objectContaining({
        effective_decision: "confirmed",
        gate_eligible: true,
        issues: [],
      }),
    ]);
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
