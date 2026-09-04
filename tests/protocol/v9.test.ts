import { describe, expect, it } from "vitest";
import {
  adjudicationResultV2Schema,
  changeCoverageResultSchema,
  providerReviewerResultV4Schema,
  publicEventV6Schema,
  publicEventV5Schema,
  reviewRequestV3Schema,
  reviewerResultV4Schema,
} from "../../src/protocol/schemas.js";

const sha256 = "a".repeat(64);

const validCoverage = {
  status: "complete" as const,
  proof_kind: "observed" as const,
  scope_digest: sha256,
  inspected_count: 1,
  deficit_count: 0,
  deficit_sample: [],
};

const validFinding = {
  id: "finding-1",
  severity: "high" as const,
  title: "Incorrect result",
  description: "The operation returns stale data.",
  evidence: [
    { path: "src/index.ts", start_line: 1, end_line: 2, detail: "Stale read." },
  ],
  suggested_direction: "Refresh the value before returning it.",
  confidence: "high" as const,
  classification: "confirmed_defect" as const,
  external_assumptions: [],
  category: "correctness" as const,
  verification: "Run the focused regression test.",
  change_impact: "The changed cache path can return old state.",
  claim: {
    trigger: "A cached value exists.",
    affected_behavior: "The read operation uses the cached value.",
    outcome: "The caller receives stale data.",
  },
};

const validProviderResult = {
  schema_version: "4" as const,
  verdict: "fail" as const,
  review_markdown: "# Review\n\nOne finding.",
  summary: "One actionable finding.",
  actionable_findings: [validFinding],
  informational_notes: [],
};

describe("v9 review request schema", () => {
  it("accepts typed pull request metadata and rejects unknown pull request keys", () => {
    expect(
      reviewRequestV3Schema.safeParse({
        schema_version: "3",
        project_name: "demo",
        workspace: "/work/demo",
        instructions: "Review",
        review_scope: { mode: "changes" },
        pull_request: {
          id: "16936099",
          url: "https://dev.azure.com/example/project/_git/repo/pullrequest/16936099",
          title: "Bounded metadata",
          description: "Review the supplied change.",
          work_items: [{ id: "12345", title: "Tracked work" }],
          validation: [
            {
              name: "unit tests",
              status: "passed",
              details: "521 tests passed",
            },
          ],
          contract_impact: {
            status: "none",
            summary: "No published contract changes.",
            references: [],
          },
        },
      }).success,
    ).toBe(true);

    expect(
      reviewRequestV3Schema.safeParse({
        schema_version: "3",
        project_name: "demo",
        workspace: "/work/demo",
        instructions: "Review",
        review_scope: { mode: "changes" },
        pull_request: { id: "1", unexpected: true },
      }).success,
    ).toBe(false);
  });

  it("keeps absent and value-invalid readiness strings distinguishable from shape errors", () => {
    const absent = reviewRequestV3Schema.safeParse({
      schema_version: "3",
      project_name: "demo",
      workspace: "/work/demo",
      instructions: "Review",
      review_scope: { mode: "changes" },
      pull_request: {
        work_items: [{}],
        validation: [{}],
        contract_impact: {},
      },
    });
    const valueInvalid = reviewRequestV3Schema.safeParse({
      schema_version: "3",
      project_name: "demo",
      workspace: "/work/demo",
      instructions: "Review",
      review_scope: { mode: "changes" },
      pull_request: { id: "", url: "http://invalid.example", title: "" },
    });
    const wrongType = reviewRequestV3Schema.safeParse({
      schema_version: "3",
      project_name: "demo",
      workspace: "/work/demo",
      instructions: "Review",
      review_scope: { mode: "changes" },
      pull_request: { id: 1 },
    });

    expect(absent.success).toBe(true);
    expect(valueInvalid.success).toBe(true);
    expect(wrongType.success).toBe(false);
  });

  it("measures named request field limits as UTF-8 bytes", () => {
    const request = {
      schema_version: "3" as const,
      project_name: "demo",
      workspace: "/work/demo",
      instructions: "Review",
      review_scope: { mode: "changes" as const },
      pull_request: { id: "é".repeat(64), description: "😀".repeat(8_192) },
    };

    expect(Buffer.byteLength(request.pull_request.id, "utf8")).toBe(128);
    expect(Buffer.byteLength(request.pull_request.description, "utf8")).toBe(
      32 * 1_024,
    );
    expect(reviewRequestV3Schema.safeParse(request).success).toBe(true);
    expect(
      reviewRequestV3Schema.safeParse({
        ...request,
        pull_request: {
          ...request.pull_request,
          id: `${request.pull_request.id}a`,
        },
      }).success,
    ).toBe(false);
  });
});

describe("v9 result schemas", () => {
  it("keeps provider content separate from core-owned change coverage", () => {
    expect(
      providerReviewerResultV4Schema.safeParse(validProviderResult).success,
    ).toBe(true);
    expect(
      reviewerResultV4Schema.safeParse({
        ...validProviderResult,
        change_coverage: validCoverage,
      }).success,
    ).toBe(true);
    expect(
      providerReviewerResultV4Schema.safeParse({
        ...validProviderResult,
        change_coverage: validCoverage,
      }).success,
    ).toBe(false);
    expect(changeCoverageResultSchema.safeParse(validCoverage).success).toBe(
      true,
    );
  });

  it("enforces finding and informational note limits in UTF-8 bytes", () => {
    expect(
      providerReviewerResultV4Schema.safeParse({
        ...validProviderResult,
        actionable_findings: [{ ...validFinding, title: "😀".repeat(64) }],
      }).success,
    ).toBe(true);
    expect(
      providerReviewerResultV4Schema.safeParse({
        ...validProviderResult,
        actionable_findings: [
          { ...validFinding, title: `${"😀".repeat(64)}a` },
        ],
      }).success,
    ).toBe(false);
  });

  it("accepts adjudication v2 with one bounded decision per candidate", () => {
    expect(
      adjudicationResultV2Schema.safeParse({
        schema_version: "2",
        kind: "review-mesh.adjudication-result",
        verdict: "fail",
        review_markdown: "Confirmed.",
        summary: "The candidate is confirmed.",
        actionable_findings: [],
        decisions: [
          {
            source_finding_id: "finding-1",
            decision: "confirmed",
            rationale: "The cited line demonstrates the stale read.",
            cited_evidence: [
              {
                path: "src/index.ts",
                start_line: 1,
                end_line: 2,
                detail: "Stale read.",
              },
            ],
            ordered_execution_proof: {
              steps: [
                {
                  order: 1,
                  description: "Read the cached value.",
                  citation: {
                    path: "src/index.ts",
                    start_line: 1,
                    end_line: 1,
                    detail: "Cache read.",
                  },
                },
                {
                  order: 2,
                  description: "Return it to the caller.",
                  citation: {
                    path: "src/index.ts",
                    start_line: 2,
                    end_line: 2,
                    detail: "Stale return.",
                  },
                },
              ],
              failure_point: { step_order: 2, detail: "No refresh occurs." },
            },
            base_head_comparison: {
              base: {
                behavior: "The value is refreshed.",
                citation: {
                  path: "src/index.ts",
                  start_line: 1,
                  end_line: 1,
                  detail: "Refresh.",
                },
              },
              head: {
                behavior: "The cached value is returned directly.",
                citation: {
                  path: "src/index.ts",
                  start_line: 2,
                  end_line: 2,
                  detail: "Direct return.",
                },
              },
              impact: "The change introduces stale reads.",
            },
            unverified_assumptions: [],
          },
        ],
        informational_notes: [],
      }).success,
    ).toBe(true);
  });
});

describe("public event v6", () => {
  it("uses coverage-first outcomes while leaving a frozen v5 event unchanged", () => {
    const legacy = {
      schema_version: "5",
      event: "run.completed",
      run_id: "legacy-run",
      seq: 1,
      timestamp: "2026-09-05T09:00:00.000Z",
      data: {
        gate_outcome: "no_findings",
        coverage_outcome: "complete",
        exit_code: 0,
        consistency_mode: "live_worktree",
        total_elapsed_ms: 1,
        results_complete: true,
        suite: {
          total: 0,
          deferred: 0,
          queued: 0,
          running: 0,
          completed: 0,
          incomplete: 0,
          skipped: 0,
        },
      },
    };
    const event = {
      schema_version: "6",
      event: "run.completed",
      run_id: "run-1",
      seq: 9,
      timestamp: "2026-09-05T10:00:00.000Z",
      data: {
        run_outcome: "inconclusive",
        gate_outcome: "no_gate_findings",
        coverage_outcome: "partial",
        exit_code: 3,
        raw_source_findings: 11,
        atomic_subfindings: 11,
        canonical_roots: 0,
        gate_eligible_subfindings: 0,
        advisory_subfindings: 11,
        rejected_subfindings: 0,
        needs_verification_subfindings: 0,
        non_gating_subfindings: 11,
        incomplete_lenses: 2,
        result_delivery: {
          completed_results: 26,
          artifact: "complete",
          planned_public_stream: "references_only",
        },
        artifact: {
          path: ".review-mesh/runs/run-1.jsonl",
          sha256,
          byte_count: 1234,
          completed_results: 26,
        },
        lens_summaries: [],
        exclusions: [],
        warnings: [],
        deficit_samples: [],
      },
    };
    expect(publicEventV5Schema.safeParse(legacy).success).toBe(true);
    expect(publicEventV6Schema.safeParse(legacy).success).toBe(false);
    expect(legacy.data.gate_outcome).toBe("no_findings");
    expect(publicEventV6Schema.safeParse(event).success).toBe(true);
  });

  it("uses a strict bounded aggregate heartbeat entry", () => {
    const heartbeat = {
      schema_version: "6",
      event: "suite.heartbeat",
      run_id: "run-1",
      seq: 2,
      timestamp: "2026-09-05T10:00:01.000Z",
      data: {
        elapsed_ms: 1_000,
        active: [
          {
            reviewer_id: "r1",
            lens_id: "l1",
            mode: "full_review",
            attempt: 1,
            maximum_attempts: 2,
            phase: "reviewing",
            attempt_elapsed_ms: 900,
            lens_elapsed_ms: 900,
            run_deadline_remaining_ms: 10_000,
            lens_deadline_remaining_ms: 9_000,
            attempt_deadline_remaining_ms: 8_000,
            last_progress_age_ms: 50,
            coalesced_activity_count: 3,
          },
        ],
      },
    };
    expect(publicEventV6Schema.safeParse(heartbeat).success).toBe(true);
    expect(
      publicEventV6Schema.safeParse({
        ...heartbeat,
        data: {
          ...heartbeat.data,
          active: [{ ...heartbeat.data.active[0], transcript: "unbounded" }],
        },
      }).success,
    ).toBe(false);
  });
});
