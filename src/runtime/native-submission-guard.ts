import { createHash } from "node:crypto";
import { sanitizePublicText } from "../adapters/errors.js";
import { sanitizeReviewerOutput } from "../results/sanitize.js";
import { validateNativeSubmission } from "../protocol/native-review.js";
import { validateNativeAdjudicationSubmission } from "../protocol/native-submission.js";
import type { AdjudicationDecisionV2 } from "../protocol/v9.js";
import type { ReviewerDraftDiagnostic } from "../adapters/types.js";
import type { ResolvedReviewer } from "../config/schemas.js";
import type { ResolvedContext } from "../context/resolve.js";
import type { AdapterReviewInput } from "../adapters/types.js";
import type {
  ProviderReviewerResultV4,
  AdjudicationResultV2,
} from "../protocol/v9.js";
export type NativeSubmissionResult =
  ProviderReviewerResultV4 | AdjudicationResultV2;
export type NativeSubmissionValidation =
  { accepted: true } | { accepted: false; message: string };
export interface NativeSubmissionGuardOptions {
  reviewer: ResolvedReviewer;
  context: ResolvedContext;
  signal: AbortSignal;
  recordDiagnostic?: AdapterReviewInput["recordDiagnostic"];
  redactLiteralValues?: (value: unknown) => unknown;
  sanitizeMessage?: (value: unknown) => string | undefined;
  diagnosticPrefix?: string;
  validateAdditional?: (
    result: NativeSubmissionResult,
  ) => NativeSubmissionValidation | Promise<NativeSubmissionValidation>;
}

/** Preserve rejected candidate evidence while each SDK owns its repair turns. */
export function createNativeSubmissionGuard(
  options: NativeSubmissionGuardOptions,
) {
  const redactLiteralValues =
    options.redactLiteralValues ?? ((value: unknown) => value);
  const safe = options.sanitizeMessage ?? sanitizePublicText;
  const retainedFindings = new Map<string, string>();
  const retainedDecisions = new Map<
    string,
    { kind: string; core: string; unresolvedCore: string }
  >();
  const decisionCore = (
    decision: AdjudicationDecisionV2,
    unresolved = false,
  ) => {
    const source = Array.isArray(options.reviewer.policy?.candidateFindings)
      ? options.reviewer.policy.candidateFindings.find(
          (value) =>
            typeof value === "object" &&
            value !== null &&
            !Array.isArray(value) &&
            value.id === decision.source_finding_id,
        )
      : undefined;
    const finding = (decision.adjusted_finding ?? source ?? {}) as Record<
      string,
      unknown
    >;
    const claim = finding.claim as Record<string, unknown> | undefined;
    return createHash("sha256")
      .update(
        JSON.stringify([
          finding.severity,
          finding.title,
          finding.description,
          finding.suggested_direction,
          finding.category,
          finding.root_issue_id,
          finding.change_impact,
          claim?.trigger,
          claim?.affected_behavior,
          claim?.outcome,
          ...(unresolved ? [] : [finding.classification, finding.confidence]),
        ]),
      )
      .digest("hex");
  };
  let rejectedSubmissionCount = 0;
  const recordRejectedSubmission = async (
    result: NativeSubmissionResult,
    reason: string,
  ) => {
    const sanitized = sanitizeReviewerOutput(redactLiteralValues(result));
    const candidateIds =
      sanitized.schema_version === "4"
        ? sanitized.actionable_findings.map((finding) => finding.id)
        : sanitized.decisions.map((decision) => decision.source_finding_id);
    rejectedSubmissionCount++;
    const reportId = `${options.diagnosticPrefix ?? "native-submission"}-${rejectedSubmissionCount}`;
    const draft: ReviewerDraftDiagnostic = {
      kind: "unverified_result_draft",
      checkpoint_id: reportId,
      accepted_page_count: 0,
      candidate_ids: candidateIds,
      unresolved_obligations: [safe(reason) ?? "native_submission_rejected"],
      candidate: sanitized as unknown as Record<string, unknown>,
      result_kind:
        sanitized.schema_version === "4" ? "reviewer" : "adjudication",
    };
    if (
      candidateIds.length <= 256 &&
      Buffer.byteLength(JSON.stringify(draft), "utf8") <= 128 * 1024
    ) {
      await options.recordDiagnostic?.(draft);
      return;
    }
    const serialized = JSON.stringify(sanitized);
    const digest = createHash("sha256").update(serialized).digest("hex");
    const fragments: string[] = [];
    // Split by code points so every fragment is valid Unicode, including
    // surrogate pairs, and leaves room for JSON escaping and metadata.
    let fragment = "";
    let size = 0;
    for (const character of serialized) {
      const bytes = Buffer.byteLength(character, "utf8");
      if (size + bytes > 32 * 1024) {
        fragments.push(fragment);
        fragment = "";
        size = 0;
      }
      fragment += character;
      size += bytes;
    }
    if (fragment) fragments.push(fragment);
    for (const [index, reportFragment] of fragments.entries())
      await options.recordDiagnostic?.({
        ...draft,
        checkpoint_id: `${reportId}-${index}`,
        page_index: index,
        candidate_ids: [],
        candidate: {
          kind: "native_rejected_submission_fragment",
          report_id: reportId,
          report_fragment: reportFragment,
          fragment_index: index,
          fragment_count: fragments.length,
          report_sha256: digest,
        },
      });
  };
  return {
    async validate(
      result: NativeSubmissionResult,
    ): Promise<NativeSubmissionValidation> {
      let message = "";
      if (result.schema_version === "2" && retainedDecisions.size) {
        const changed = result.decisions.filter((decision) => {
          const previous = retainedDecisions.get(decision.source_finding_id);
          if (!previous) return false;
          const unresolved =
            decision.decision === "adjusted" &&
            decision.adjusted_finding?.classification ===
              "needs_verification" &&
            (decision.unverified_assumptions.length > 0 ||
              decision.adjusted_finding.external_assumptions.length > 0);
          return unresolved
            ? previous.unresolvedCore !== decisionCore(decision, true)
            : previous.kind !== decision.decision ||
                previous.core !== decisionCore(decision);
        });
        if (changed.length) {
          message =
            "Proof correction must preserve the original candidate claims and decisions. Correct citations and proof only; if a claim cannot be substantiated, keep that claim as an adjusted needs_verification finding with an explicit reason. Do not reject or drop claims to bypass proof checks.";
          await recordRejectedSubmission(result, message);
          return { accepted: false, message };
        }
      }
      if (result.schema_version === "4" && retainedFindings.size) {
        const current = new Map(
          result.actionable_findings.map((finding) => [
            finding.id,
            createHash("sha256").update(JSON.stringify(finding)).digest("hex"),
          ]),
        );
        const changed = [...retainedFindings].flatMap(([id, digest]) =>
          current.get(id) === digest ? [] : [id],
        );
        if (changed.length) {
          message = `Scope correction must retain the original actionable findings unchanged. Restore finding IDs ${JSON.stringify(changed)} and correct only the missing scope attestation. Do not remove or downgrade findings to obtain acceptance.`;
          await recordRejectedSubmission(result, message);
          return { accepted: false, message };
        }
      }
      let validation =
        result.schema_version === "2"
          ? await validateNativeAdjudicationSubmission(
              options.reviewer,
              options.context,
              result,
              options.signal,
            )
          : validateNativeSubmission(options.reviewer, options.context, result);
      if (validation.accepted && options.validateAdditional)
        validation = await options.validateAdditional(result);
      if (!validation.accepted) {
        message = validation.message;
        if (result.schema_version === "2")
          for (const decision of result.decisions)
            if (!retainedDecisions.has(decision.source_finding_id))
              retainedDecisions.set(decision.source_finding_id, {
                kind: decision.decision,
                core: decisionCore(decision),
                unresolvedCore: decisionCore(decision, true),
              });
        if (result.schema_version === "4")
          for (const finding of result.actionable_findings)
            retainedFindings.set(
              finding.id,
              createHash("sha256")
                .update(JSON.stringify(finding))
                .digest("hex"),
            );
        await recordRejectedSubmission(result, message);
        return { accepted: false, message };
      }
      return { accepted: true };
    },
  };
}
