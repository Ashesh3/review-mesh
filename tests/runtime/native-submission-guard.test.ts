import { expect, it } from "vitest";
import { createNativeSubmissionGuard } from "../../src/runtime/native-submission-guard.js";
import { resolvedContext, resolvedReviewer } from "../helpers/fixtures.js";
import type {
  AdjudicationResultV2,
  ProviderReviewerResultV4,
} from "../../src/protocol/v9.js";
it("accepts optional partial attestation and permits a revised review", async () => {
  const guard = createNativeSubmissionGuard({
    reviewer: resolvedReviewer(),
    context: resolvedContext(),
    signal: new AbortController().signal,
  });
  const value: ProviderReviewerResultV4 = {
    schema_version: "4",
    verdict: "pass",
    summary: "Native conclusion",
    review_markdown: "Review",
    actionable_findings: [],
    informational_notes: [],
    native_scope_attestation: {
      complete: false,
      reviewed_paths: [],
      limitations: ["Optional old metadata"],
    },
  };
  expect(await guard.validate(value)).toEqual({ accepted: true });
  const { native_scope_attestation: _attestation, ...revised } = value;
  expect(await guard.validate(revised)).toEqual({ accepted: true });
});
it("allows the agent to revise a previously incomplete adjudication decision", async () => {
  const reviewer = resolvedReviewer({
    policy: {
      mode: "adjudication",
      candidateFindings: [{ id: "one" }, { id: "two" }],
      passQuorum: 1,
      minimumProviderGroups: 1,
      adjudication: "required",
      gateMinimumSeverity: "medium",
      gateMinimumConfidence: "medium",
    },
  });
  const guard = createNativeSubmissionGuard({
    reviewer,
    context: resolvedContext(),
    signal: new AbortController().signal,
  });
  const value: AdjudicationResultV2 = {
    schema_version: "2",
    kind: "review-mesh.adjudication-result",
    verdict: "fail",
    review_markdown: "Original assessment",
    summary: "Assessment",
    actionable_findings: [],
    informational_notes: [],
    decisions: [
      {
        source_finding_id: "one",
        decision: "confirmed",
        rationale: "Initial conclusion",
        cited_evidence: [],
        unverified_assumptions: [],
      },
    ],
  };
  expect(await guard.validate(value)).toMatchObject({ accepted: false });
  value.verdict = "pass";
  value.decisions = ["one", "two"].map((id) => ({
    source_finding_id: id,
    decision: "rejected",
    rationale: "Revised after further inspection",
    cited_evidence: [],
    unverified_assumptions: [],
  }));
  expect(await guard.validate(value)).toEqual({ accepted: true });
});
