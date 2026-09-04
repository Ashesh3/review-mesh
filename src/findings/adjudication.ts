import type {
  AdjudicationDecision,
  AdjudicationResult,
  ReviewerResultV3,
} from "../protocol/schemas.js";
import type { AdjudicationEvidenceVerification } from "./evidence-verifier.js";

export interface AdjudicationValidationContext {
  reviewScope: "changes" | "full";
  git?: {
    changedFiles: readonly string[];
    diff: string;
  };
  evidenceVerification?: AdjudicationEvidenceVerification;
}

export type AdjudicationValidationIssue =
  | "decision_required"
  | "duplicate_decision"
  | "unknown_source_finding_id"
  | "cited_evidence_required"
  | "cited_evidence_location_required"
  | "cited_evidence_context_required"
  | "adjusted_finding_required"
  | "ordered_execution_proof_required"
  | "ordered_execution_steps_invalid"
  | "ordered_execution_citation_required"
  | "ordered_execution_context_required"
  | "failure_point_invalid"
  | "failure_point_citation_required"
  | "failure_point_context_required"
  | "base_head_comparison_required"
  | "base_head_citation_required"
  | "base_head_context_required"
  | "core_evidence_verification_required"
  | "validation_attestation_required";

export interface EffectiveAdjudicationDecision {
  source_finding_id: string;
  requested_decision: AdjudicationDecision["decision"] | "missing";
  effective_decision: AdjudicationDecision["decision"] | "needs_verification";
  gate_eligible: boolean;
  issues: AdjudicationValidationIssue[];
  decision?: AdjudicationDecision;
  effective_finding?: ReviewerResultV3["actionable_findings"][number];
}

export interface AdjudicationOutcome {
  complete: boolean;
  candidate_result: ReviewerResultV3;
  adjudication_result: AdjudicationResult;
  decisions: EffectiveAdjudicationDecision[];
  unknown_source_finding_ids: string[];
}

export function failClosedAdjudicationOutcome(
  candidateResult: ReviewerResultV3,
  adjudicationResult: AdjudicationResult,
): AdjudicationOutcome {
  const decisionsById = new Map(
    adjudicationResult.decisions.map((decision) => [
      decision.source_finding_id,
      decision,
    ]),
  );
  return {
    complete: false,
    candidate_result: structuredClone(candidateResult),
    adjudication_result: structuredClone(adjudicationResult),
    decisions: candidateResult.actionable_findings.map((candidate) => {
      const decision = decisionsById.get(candidate.id);
      return {
        source_finding_id: candidate.id,
        requested_decision: decision?.decision ?? "missing",
        effective_decision: "needs_verification",
        gate_eligible: false,
        issues: ["validation_attestation_required"],
        ...(decision === undefined
          ? {}
          : { decision: structuredClone(decision) }),
      };
    }),
    unknown_source_finding_ids: adjudicationResult.decisions
      .map((decision) => decision.source_finding_id)
      .filter(
        (id) =>
          !candidateResult.actionable_findings.some(
            (finding) => finding.id === id,
          ),
      )
      .sort(),
  };
}

const orderedProofCategories = new Set([
  "reliability",
  "concurrency",
  "lifecycle",
  "cleanup",
]);

function validOrderedProof(decision: AdjudicationDecision): {
  ordered: boolean;
  citations: boolean;
  failurePoint: boolean;
  failurePointCitation: boolean;
} {
  const proof = decision.ordered_execution_proof;
  if (proof === undefined)
    return {
      ordered: false,
      citations: false,
      failurePoint: false,
      failurePointCitation: false,
    };
  const orders = proof.steps.map((step) => step.order);
  const ordered =
    proof.steps.length >= 2 &&
    new Set(orders).size === orders.length &&
    orders.every((order, index) => index === 0 || order > orders[index - 1]!);
  const failurePoint = orders.includes(proof.failure_point.step_order);
  return {
    ordered,
    citations: proof.steps.every((step) => concreteCitation(step.citation)),
    failurePoint,
    failurePointCitation: concreteCitation(proof.failure_point.citation),
  };
}

function concreteCitation(
  value:
    | {
        path?: string | undefined;
        start_line?: number | undefined;
        end_line?: number | undefined;
      }
    | undefined,
): boolean {
  if (value === undefined) return false;
  const path = value.path;
  return (
    typeof path === "string" &&
    path.length > 0 &&
    path !== "." &&
    path !== ".." &&
    !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(path) &&
    !path.startsWith("/") &&
    !path.startsWith(":") &&
    !/^[A-Za-z]:/u.test(path) &&
    !path.includes("\\") &&
    !/[\u0000-\u001f]/u.test(path) &&
    !/[*?[\]]/u.test(path) &&
    !path
      .split("/")
      .some((part) => part === "" || part === "." || part === "..") &&
    typeof value.start_line === "number" &&
    Number.isSafeInteger(value.start_line) &&
    value.start_line > 0 &&
    (value.end_line === undefined ||
      (Number.isSafeInteger(value.end_line) &&
        value.end_line >= value.start_line))
  );
}

interface DiffRanges {
  old: Map<string, Array<{ start: number; end: number }>>;
  head: Map<string, Array<{ start: number; end: number }>>;
}

function parseDiffRanges(diff: string): DiffRanges {
  const ranges: DiffRanges = { old: new Map(), head: new Map() };
  let path: string | undefined;
  for (const line of diff.split(/\r?\n/u)) {
    const file = /^diff --git a\/(.+) b\/(.+)$/u.exec(line);
    if (file !== null) {
      path = file[2];
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line);
    if (path === undefined || hunk === null) continue;
    const oldStart = Number(hunk[1]);
    const oldCount = Number(hunk[2] ?? "1");
    const headStart = Number(hunk[3]);
    const headCount = Number(hunk[4] ?? "1");
    if (oldCount > 0) {
      ranges.old.set(path, [
        ...(ranges.old.get(path) ?? []),
        { start: oldStart, end: oldStart + oldCount - 1 },
      ]);
    }
    if (headCount > 0) {
      ranges.head.set(path, [
        ...(ranges.head.get(path) ?? []),
        { start: headStart, end: headStart + headCount - 1 },
      ]);
    }
  }
  return ranges;
}

function withinRanges(
  citation: {
    path?: string | undefined;
    start_line?: number | undefined;
    end_line?: number | undefined;
  },
  ranges: Map<string, Array<{ start: number; end: number }>>,
): boolean {
  if (!concreteCitation(citation)) return false;
  const end = citation.end_line ?? citation.start_line!;
  return (ranges.get(citation.path!) ?? []).some(
    (range) => citation.start_line! >= range.start && end <= range.end,
  );
}

function withinCandidateEvidence(
  citation: {
    path?: string | undefined;
    start_line?: number | undefined;
    end_line?: number | undefined;
  },
  candidate: ReviewerResultV3["actionable_findings"][number],
): boolean {
  if (!concreteCitation(citation)) return false;
  const end = citation.end_line ?? citation.start_line!;
  return candidate.evidence.some((evidence) => {
    if (!concreteCitation(evidence) || evidence.path !== citation.path)
      return false;
    const evidenceEnd = evidence.end_line ?? evidence.start_line!;
    return citation.start_line! >= evidence.start_line! && end <= evidenceEnd;
  });
}

function contextBoundCitation(
  citation: {
    path?: string | undefined;
    start_line?: number | undefined;
    end_line?: number | undefined;
  },
  candidate: ReviewerResultV3["actionable_findings"][number],
  context: AdjudicationValidationContext,
): boolean {
  if (!concreteCitation(citation)) return false;
  if (withinCandidateEvidence(citation, candidate)) return true;
  const git = context.git;
  if (git === undefined || !git.changedFiles.includes(citation.path!))
    return false;
  const ranges = parseDiffRanges(git.diff);
  return (
    withinRanges(citation, ranges.old) || withinRanges(citation, ranges.head)
  );
}

function adjustedFinding(
  candidate: ReviewerResultV3["actionable_findings"][number],
  decision: AdjudicationDecision,
): ReviewerResultV3["actionable_findings"][number] | undefined {
  const adjusted = decision.adjusted_finding;
  if (adjusted === undefined) return undefined;
  return {
    ...structuredClone(candidate),
    ...structuredClone(adjusted),
    id: candidate.id,
  };
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
        decision.decision !== "rejected" &&
        !decision.cited_evidence.every(concreteCitation)
      ) {
        issues.push("cited_evidence_location_required");
      }
      if (
        decision.decision !== "rejected" &&
        !decision.cited_evidence.every((citation) =>
          contextBoundCitation(citation, candidate, context),
        )
      ) {
        issues.push("cited_evidence_context_required");
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
          if (!proof.citations)
            issues.push("ordered_execution_citation_required");
          if (
            !decision.ordered_execution_proof.steps.every((step) =>
              contextBoundCitation(step.citation, candidate, context),
            )
          )
            issues.push("ordered_execution_context_required");
          if (!proof.failurePoint) issues.push("failure_point_invalid");
          if (!proof.failurePointCitation)
            issues.push("failure_point_citation_required");
          if (
            !contextBoundCitation(
              decision.ordered_execution_proof.failure_point.citation ?? {},
              candidate,
              context,
            )
          )
            issues.push("failure_point_context_required");
        }
      }
      if (
        decision.decision !== "rejected" &&
        context.reviewScope === "changes" &&
        decision.base_head_comparison === undefined
      ) {
        issues.push("base_head_comparison_required");
      }
      if (
        decision.decision !== "rejected" &&
        decision.base_head_comparison !== undefined &&
        (!concreteCitation(decision.base_head_comparison.base.citation) ||
          !concreteCitation(decision.base_head_comparison.head.citation))
      ) {
        issues.push("base_head_citation_required");
      }
      if (
        decision.decision !== "rejected" &&
        context.reviewScope === "changes" &&
        decision.base_head_comparison !== undefined
      ) {
        const ranges = parseDiffRanges(context.git?.diff ?? "");
        if (
          !withinRanges(
            decision.base_head_comparison.base.citation,
            ranges.old,
          ) ||
          !withinRanges(
            decision.base_head_comparison.head.citation,
            ranges.head,
          )
        ) {
          issues.push("base_head_context_required");
        }
      }
      if (
        decision.decision !== "rejected" &&
        context.evidenceVerification?.by_source_finding_id[candidate.id]
          ?.verified !== true
      ) {
        issues.push("core_evidence_verification_required");
      }
      const effectiveFinding = adjustedFinding(candidate, decision);
      return {
        source_finding_id: candidate.id,
        requested_decision: decision.decision,
        effective_decision:
          decision.decision === "rejected"
            ? "rejected"
            : issues.length === 0
              ? decision.decision
              : "needs_verification",
        gate_eligible:
          decision.decision !== "rejected" &&
          issues.length === 0 &&
          (effectiveFinding ?? candidate).classification === "confirmed_defect",
        issues,
        decision,
        ...(effectiveFinding === undefined
          ? {}
          : { effective_finding: effectiveFinding }),
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
