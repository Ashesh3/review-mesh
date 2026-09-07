import { expect, it } from "vitest";
import { createNativeSubmissionGuard } from "../../src/runtime/native-submission-guard.js";
import { resolvedContext, resolvedReviewer } from "../helpers/fixtures.js";
import type { ProviderReviewerResultV4 } from "../../src/protocol/v9.js";
import type { AdapterDiagnostic } from "../../src/adapters/types.js";

function report(): ProviderReviewerResultV4 {
  return {
    schema_version: "4",
    verdict: "fail",
    summary: "Retain original finding",
    review_markdown: "Full report",
    informational_notes: [],
    native_scope_attestation: {
      complete: true,
      reviewed_paths: ["a.ts", "b.ts"],
      limitations: [],
    },
    actionable_findings: [
      {
        id: "f1",
        severity: "high",
        confidence: "high",
        classification: "confirmed_defect",
        title: "Retained finding",
        description: "Original claim",
        evidence: [
          { path: "a.ts", start_line: 1, end_line: 1, detail: "Evidence" },
        ],
        suggested_direction: "Correct original claim",
        external_assumptions: [],
        category: "correctness",
        verification: "Read source",
        claim: {
          trigger: "Trigger",
          affected_behavior: "Behavior",
          outcome: "Outcome",
        },
      },
    ],
  };
}

it("preserves rejected findings when additional native-read validation catches a false complete attestation", async () => {
  let inspected = false;
  const drafts: AdapterDiagnostic[] = [];
  const guard = createNativeSubmissionGuard({
    reviewer: resolvedReviewer(),
    context: resolvedContext({
      review_scope: { mode: "full", source: "request" },
    }),
    signal: new AbortController().signal,
    recordDiagnostic: async (draft) => {
      drafts.push(draft);
    },
    validateAdditional: () =>
      inspected
        ? { accepted: true }
        : { accepted: false, message: "Native reads do not cover b.ts." },
  });
  const original = report();
  expect(await guard.validate(original)).toEqual({
    accepted: false,
    message: "Native reads do not cover b.ts.",
  });
  inspected = true;
  expect(
    await guard.validate({
      ...original,
      verdict: "pass",
      actionable_findings: [],
    }),
  ).toMatchObject({ accepted: false, message: expect.stringContaining("f1") });
  expect(drafts).toContainEqual(
    expect.objectContaining({
      kind: "unverified_result_draft",
      candidate_ids: ["f1"],
      candidate: expect.objectContaining({
        actionable_findings: original.actionable_findings,
      }),
    }),
  );
  expect(await guard.validate(original)).toEqual({ accepted: true });
});

it("keeps honest incomplete reports and preserves literal credential redaction", async () => {
  const drafts: AdapterDiagnostic[] = [];
  const value = report();
  value.review_markdown = "Report private-fixture-secret";
  const redact = (input: unknown): unknown =>
    JSON.parse(
      JSON.stringify(input).replaceAll("private-fixture-secret", "[redacted]"),
    );
  const guard = createNativeSubmissionGuard({
    reviewer: resolvedReviewer(),
    context: resolvedContext({
      review_scope: { mode: "full", source: "request" },
    }),
    signal: new AbortController().signal,
    recordDiagnostic: async (draft) => {
      drafts.push(draft);
    },
    redactLiteralValues: redact,
    validateAdditional: (result) =>
      result.schema_version === "4" && result.native_scope_attestation?.complete
        ? { accepted: false, message: "missing b.ts" }
        : { accepted: true },
  });
  expect(await guard.validate(value)).toMatchObject({ accepted: false });
  expect(JSON.stringify(drafts)).not.toContain("private-fixture-secret");
  expect(
    await guard.validate({
      ...value,
      native_scope_attestation: {
        complete: false,
        reviewed_paths: ["a.ts"],
        limitations: ["b.ts could not be read"],
      },
    }),
  ).toEqual({ accepted: true });
});
