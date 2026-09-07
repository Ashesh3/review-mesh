import { expect, it } from "vitest";
import type { AdjudicationResultV2 } from "../../src/protocol/v9.js";
import { resolvedContext, resolvedReviewer } from "../helpers/fixtures.js";
import { validateNativeAdjudicationSubmission } from "../../src/protocol/native-submission.js";
const reviewer = () =>
  resolvedReviewer({
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
const result = (): AdjudicationResultV2 => ({
  schema_version: "2",
  kind: "review-mesh.adjudication-result",
  verdict: "fail",
  review_markdown: "Review conclusion",
  summary: "Candidates reviewed",
  actionable_findings: [],
  informational_notes: [],
  decisions: ["one", "two"].map((id) => ({
    source_finding_id: id,
    decision: "confirmed",
    rationale: "Reviewer conclusion",
    cited_evidence: [],
    unverified_assumptions: [],
  })),
});
it("accepts agent adjudication without imposing file, base/head, or ordered proof reads", async () => {
  expect(
    await validateNativeAdjudicationSubmission(
      reviewer(),
      resolvedContext({ workspace: "Z:/nonexistent-review-workspace" }),
      result(),
      new AbortController().signal,
    ),
  ).toEqual({ accepted: true });
});
it.each(["missing", "duplicate", "unknown"])(
  "still rejects %s assigned candidate IDs",
  async (mode) => {
    const value = result();
    if (mode === "missing") value.decisions.pop();
    if (mode === "duplicate") value.decisions.push({ ...value.decisions[0]! });
    if (mode === "unknown") value.decisions[0]!.source_finding_id = "unknown";
    expect(
      await validateNativeAdjudicationSubmission(
        reviewer(),
        resolvedContext(),
        value,
        new AbortController().signal,
      ),
    ).toMatchObject({ accepted: false, message: expect.any(String) });
  },
);
it("honors cancellation without starting evidence inspection", async () => {
  const controller = new AbortController();
  controller.abort(new Error("Cancelled"));
  await expect(
    validateNativeAdjudicationSubmission(
      reviewer(),
      resolvedContext(),
      result(),
      controller.signal,
    ),
  ).rejects.toThrow("Cancelled");
});
