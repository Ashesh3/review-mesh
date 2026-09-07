import type { ResolvedReviewer } from "../config/schemas.js";
import type { ResolvedContext } from "../context/resolve.js";
import {
  actionableFindingV4Schema,
  type AdjudicationResultV2,
  type ReviewerResultV4,
} from "./v9.js";
import { validateNativeSubmission } from "./native-review.js";
import { validateAdjudication } from "../findings/adjudication.js";
import { verifyAdjudicationEvidence } from "../findings/evidence-verifier.js";
import { sanitizePublicText } from "../adapters/errors.js";

/** Check claimed native adjudication proof before a terminal tool accepts it. */
export async function validateNativeAdjudicationSubmission(
  reviewer: ResolvedReviewer,
  context: ResolvedContext,
  result: AdjudicationResultV2,
  signal: AbortSignal,
): Promise<{ accepted: true } | { accepted: false; message: string }> {
  signal.throwIfAborted();
  const structural = validateNativeSubmission(reviewer, context, result);
  if (!structural.accepted) return structural;
  const candidates = actionableFindingV4Schema
    .array()
    .min(1)
    .max(256)
    .safeParse(reviewer.policy?.candidateFindings);
  if (!candidates.success)
    return {
      accepted: false,
      message:
        "Assigned adjudication candidate metadata is invalid; preserve the assigned candidates and do not manufacture source findings.",
    };
  const source: ReviewerResultV4 = {
    schema_version: "4",
    verdict: "fail",
    summary: "Assigned native adjudication candidates.",
    review_markdown:
      "Assigned source findings; source inspection proof is verified by the orchestrator.",
    actionable_findings: candidates.data,
    informational_notes: [],
    change_coverage: {
      status: "incomplete",
      proof_kind: "unknown",
      contract: "native_review_v1",
      inspected_count: 0,
      deficit_count: 1,
      deficit_sample: [],
    },
  };
  try {
    const verification = await verifyAdjudicationEvidence({
      workspace: context.workspace,
      adjudicationResult: result,
      ...(context.git.is_repository && context.git.merge_base
        ? { baseRevision: context.git.merge_base }
        : {}),
      signal,
    });
    signal.throwIfAborted();
    const outcome = validateAdjudication(source, result, {
      reviewScope: context.review_scope.mode,
      evidenceVerification: verification,
      ...(context.git.is_repository
        ? {
            git: {
              changedFiles: context.git.changed_files,
              diff: context.git.diff,
            },
          }
        : {}),
    });
    const issues = outcome.decisions.flatMap((decision) => {
      const value = decision.decision;
      const unresolved =
        value?.decision === "adjusted" &&
        value.adjusted_finding?.classification === "needs_verification" &&
        ((value.unverified_assumptions?.length ?? 0) > 0 ||
          value.adjusted_finding.external_assumptions.length > 0);
      if (unresolved || decision.issues.length === 0) return [];
      const failures =
        verification.by_source_finding_id[decision.source_finding_id]
          ?.failures ?? [];
      return [
        `${JSON.stringify(sanitizePublicText(decision.source_finding_id, 256) ?? "candidate")}: ${[...new Set([...decision.issues, ...failures])].join(", ")}`,
      ];
    });
    if (!issues.length && outcome.complete) return { accepted: true };
    return {
      accepted: false,
      message: [
        "Adjudication proof requires correction:",
        ...issues,
        "Keep every assigned candidate and the existing decision claims. Correct only the cited proof: cite real inspected head lines, use old/new hunk ranges from the supplied Git diff for base_head_comparison, and use the pinned merge-base revision for prior content. Ordered proof requires at least two increasing steps and a cited failure point referring to an existing step.",
        "If the claim cannot be substantiated, preserve it as adjusted with adjusted_finding.classification needs_verification and an explicit unverified_assumptions reason. Do not reject or drop a candidate merely to bypass proof requirements; do not invent citations.",
      ].join("\n"),
    };
  } catch {
    signal.throwIfAborted();
    return {
      accepted: false,
      message:
        "Adjudication proof verification could not read the required evidence. Preserve all candidates, inspect the cited files and pinned base revision, and resubmit corrected proof or an explicit needs_verification adjustment.",
    };
  }
}
