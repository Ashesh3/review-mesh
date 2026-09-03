import type {
  AdjudicationDecision,
  AdjudicationResult,
  ReviewerResultV3,
} from "../protocol/schemas.js";

export interface AdjudicationValidationContext {
  reviewScope: "changes" | "full";
}

export type AdjudicationValidationIssue =
  | "decision_required"
  | "duplicate_decision"
  | "unknown_source_finding_id"
  | "cited_evidence_required"
  | "adjusted_finding_required"
  | "ordered_execution_proof_required"
  | "ordered_execution_steps_invalid"
  | "failure_point_invalid"
  | "base_head_comparison_required";

export interface EffectiveAdjudicationDecision {
  source_finding_id: string;
  requested_decision: AdjudicationDecision["decision"] | "missing";
  effective_decision:
    | AdjudicationDecision["decision"]
    | "needs_verification";
  gate_eligible: boolean;
  issues: AdjudicationValidationIssue[];
  decision?: AdjudicationDecision;
}

export interface AdjudicationOutcome {
  complete: boolean;
  candidate_result: ReviewerResultV3;
  adjudication_result: AdjudicationResult;
  decisions: EffectiveAdjudicationDecision[];
  unknown_source_finding_ids: string[];
}

const orderedProofCategories = new Set([
  "reliability",
  "concurrency",
  "lifecycle",
  "cleanup",
]);

function validOrderedProof(decision: AdjudicationDecision): {
  ordered: boolean;
  failurePoint: boolean;
} {
  const proof = decision.ordered_execution_proof;
  if (proof === undefined) return { ordered: false, failurePoint: false };
  const orders = proof.steps.map((step) => step.order);
  const ordered =
    proof.steps.length >= 2 &&
    new Set(orders).size === orders.length &&
    orders.every((order, index) => index === 0 || order > orders[index - 1]!);
  const failurePoint = orders.includes(proof.failure_point.step_order);
  return { ordered, failurePoint };
}

export function validateAdjudication(
  candidateResult: ReviewerResultV3,
  adjudicationResult: AdjudicationResult,
  context: AdjudicationValidationContext,
): AdjudicationOutcome {
  const candidateIds = new Set(
    candidateResult.actionable_findings.map((finding) => finding.id),
  );
  const decisionsById = new Map<string, AdjudicationDecision[]>();
  for (const decision of adjudicationResult.decisions) {
    decisionsById.set(decision.source_finding_id, [
      ...(decisionsById.get(decision.source_finding_id) ?? []),
      decision,
    ]);
  }
  const unknownSourceIds = [...decisionsById.keys()]
    .filter((id) => !candidateIds.has(id))
    .sort((left, right) => left.localeCompare(right));
  const effective = candidateResult.actionable_findings.map(
    (candidate): EffectiveAdjudicationDecision => {
      const matching = decisionsById.get(candidate.id) ?? [];
      if (matching.length === 0) {
        return {
          source_finding_id: candidate.id,
          requested_decision: "missing",
          effective_decision: "needs_verification",
          gate_eligible: false,
          issues: ["decision_required"],
        };
      }
      const decision = matching[0]!;
      const issues: AdjudicationValidationIssue[] = [];
      if (matching.length > 1) issues.push("duplicate_decision");
      if (
        decision.decision !== "rejected" &&
        decision.cited_evidence.length === 0
      ) {
        issues.push("cited_evidence_required");
      }
      if (
        decision.decision === "adjusted" &&
        decision.adjusted_finding === undefined
      ) {
        issues.push("adjusted_finding_required");
      }
      if (
        decision.decision !== "rejected" &&
        orderedProofCategories.has(candidate.category)
      ) {
        const proof = validOrderedProof(decision);
        if (decision.ordered_execution_proof === undefined) {
          issues.push("ordered_execution_proof_required");
        } else {
          if (!proof.ordered) issues.push("ordered_execution_steps_invalid");
          if (!proof.failurePoint) issues.push("failure_point_invalid");
        }
      }
      if (
        decision.decision !== "rejected" &&
        context.reviewScope === "changes" &&
        decision.base_head_comparison === undefined
      ) {
        issues.push("base_head_comparison_required");
      }
      return {
        source_finding_id: candidate.id,
        requested_decision: decision.decision,
        effective_decision:
          decision.decision === "rejected"
            ? "rejected"
            : issues.length === 0
              ? decision.decision
              : "needs_verification",
        gate_eligible: decision.decision !== "rejected" && issues.length === 0,
        issues,
        decision,
      };
    },
  );
  return {
    complete:
      unknownSourceIds.length === 0 &&
      effective.every(
        (decision) =>
          decision.requested_decision !== "missing" &&
          !decision.issues.includes("duplicate_decision"),
      ),
    candidate_result: structuredClone(candidateResult),
    adjudication_result: structuredClone(adjudicationResult),
    decisions: effective,
    unknown_source_finding_ids: unknownSourceIds,
  };
}
