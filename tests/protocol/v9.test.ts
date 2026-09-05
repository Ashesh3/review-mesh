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
import {
  providerReviewerResultV4JsonSchema,
  resultPageJsonSchema,
} from "../../src/protocol/json-schema.js";
import type {
  ResultKind,
  ResultPageKind,
  V9CoverageProofKind,
  V9CoverageStatus,
  V9FindingCategory,
  V9FindingClassification,
  V9FindingConfidence,
  V9FindingSeverity,
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
      pull_request: {},
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
    expect(
      reviewRequestV3Schema.safeParse({
        schema_version: "3",
        project_name: "demo",
        workspace: "/work/demo",
        instructions: "Review",
        review_scope: { mode: "changes" },
        pull_request: { work_items: [{}] },
      }).success,
    ).toBe(false);
    expect(
      reviewRequestV3Schema.safeParse({
        schema_version: "3",
        project_name: "demo",
        workspace: "/work/demo",
        instructions: "Review",
        review_scope: { mode: "changes" },
        pull_request: { validation: [{}] },
      }).success,
    ).toBe(false);
    expect(
      reviewRequestV3Schema.safeParse({
        schema_version: "3",
        project_name: "demo",
        workspace: "/work/demo",
        instructions: "Review",
        review_scope: { mode: "changes" },
        pull_request: { contract_impact: {} },
      }).success,
    ).toBe(false);
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
  it("exports inferred types for every v9 enum and page discriminant", () => {
    const values: [
      V9FindingSeverity,
      V9FindingConfidence,
      V9FindingClassification,
      V9FindingCategory,
      V9CoverageProofKind,
      V9CoverageStatus,
      ResultKind,
      ResultPageKind,
    ] = [
      "high",
      "high",
      "confirmed_defect",
      "correctness",
      "observed",
      "complete",
      "reviewer",
      "header",
    ];
    expect(values).toHaveLength(8);
  });

  it("declares provider-facing character and UTF-8 byte bounds in JSON Schema", () => {
    const provider = JSON.stringify(providerReviewerResultV4JsonSchema);
    const pages = JSON.stringify(resultPageJsonSchema);
    for (const serialized of [provider, pages]) {
      expect(serialized).toContain('"maxLength"');
      expect(serialized).toContain('"x-review-mesh-max-utf8-bytes"');
    }
    expect(provider).toContain('"x-review-mesh-max-utf8-bytes":1024');
    expect(provider).toContain('"x-review-mesh-max-utf8-bytes":768');
    expect(pages).toContain('"x-review-mesh-max-utf8-bytes":24576');
  });
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

  it("requires workspace-relative evidence and canonical attestation paths", () => {
    for (const path of ["/src/index.ts", "../src/index.ts", "src\\index.ts"]) {
      expect(
        providerReviewerResultV4Schema.safeParse({
          ...validProviderResult,
          actionable_findings: [
            {
              ...validFinding,
              evidence: [{ ...validFinding.evidence[0], path }],
            },
          ],
        }).success,
      ).toBe(false);
    }
    const decomposed = "cafe\u0301.ts";
    expect(decomposed).not.toBe(decomposed.normalize("NFC"));
    expect(
      providerReviewerResultV4Schema.safeParse({
        ...validProviderResult,
        coverage_attestation: {
          scope_digest: sha256,
          entries: [
            { path: decomposed, method: "full_file", snapshot_digest: sha256 },
          ],
        },
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

  it.each([
    [
      "clear with partial coverage",
      { run_outcome: "clear", coverage_outcome: "partial" },
    ],
    [
      "clear with gate findings",
      { run_outcome: "clear", gate_outcome: "gate_findings" },
    ],
    ["clear with exit one", { run_outcome: "clear", exit_code: 1 }],
    ["wrong non-gating count", { non_gating_subfindings: 10 }],
    [
      "gate outcome without eligible findings",
      { gate_outcome: "gate_findings", run_outcome: "inconclusive" },
    ],
    ["more atomics than sources", { raw_source_findings: 10 }],
  ])("rejects contradictory terminal outcome: %s", (_name, override) => {
    const base = {
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
    expect(
      publicEventV6Schema.safeParse({
        ...base,
        data: { ...base.data, ...override },
      }).success,
    ).toBe(false);
  });

  it("rejects unbounded lens summaries and terminal events at 16 KiB", () => {
    const event = {
      schema_version: "6",
      event: "run.completed",
      run_id: "run-1",
      seq: 9,
      timestamp: "2026-09-05T10:00:00.000Z",
      data: {
        run_outcome: "clear",
        gate_outcome: "no_gate_findings",
        coverage_outcome: "complete",
        exit_code: 0,
        raw_source_findings: 0,
        atomic_subfindings: 0,
        canonical_roots: 0,
        gate_eligible_subfindings: 0,
        advisory_subfindings: 0,
        rejected_subfindings: 0,
        needs_verification_subfindings: 0,
        non_gating_subfindings: 0,
        incomplete_lenses: 0,
        result_delivery: {
          completed_results: 1,
          artifact: "complete",
          planned_public_stream: "references_only",
        },
        artifact: {
          path: ".review-mesh/runs/run-1.jsonl",
          sha256,
          byte_count: 1234,
          completed_results: 1,
        },
        lens_summaries: [
          { lens_id: "l1", outcome: "passed", message: "x".repeat(129) },
        ],
        exclusions: [],
        warnings: [],
        deficit_samples: [],
      },
    };
    expect(publicEventV6Schema.safeParse(event).success).toBe(false);
    expect(
      publicEventV6Schema.safeParse({
        ...event,
        data: {
          ...event.data,
          lens_summaries: [],
          warnings: ["x".repeat(16 * 1_024)],
        },
      }).success,
    ).toBe(false);
  });

  it("keeps a maximally populated bounded terminal event below 16 KiB", () => {
    const id = "x".repeat(128);
    const event = {
      schema_version: "6",
      event: "run.completed",
      run_id: id,
      request_id: id,
      seq: 9,
      timestamp: "2026-09-05T10:00:00.000Z",
      data: {
        run_outcome: "clear",
        gate_outcome: "no_gate_findings",
        coverage_outcome: "complete",
        exit_code: 0,
        raw_source_findings: 0,
        atomic_subfindings: 0,
        canonical_roots: 0,
        gate_eligible_subfindings: 0,
        advisory_subfindings: 0,
        rejected_subfindings: 0,
        needs_verification_subfindings: 0,
        non_gating_subfindings: 0,
        incomplete_lenses: 0,
        result_delivery: {
          completed_results: 1,
          artifact: "complete",
          planned_public_stream: "references_only",
        },
        artifact: {
          path: "p".repeat(4_096),
          sha256,
          byte_count: 1234,
          completed_results: 1,
        },
        lens_summaries: Array.from({ length: 8 }, () => ({
          lens_id: id,
          outcome: "passed",
          message: id,
        })),
        exclusions: Array.from({ length: 8 }, () => id),
        warnings: Array.from({ length: 8 }, () => id),
        deficit_samples: Array.from({ length: 8 }, () => id),
      },
    };
    expect(Buffer.byteLength(JSON.stringify(event), "utf8")).toBeLessThan(
      16 * 1_024,
    );
    expect(publicEventV6Schema.safeParse(event).success).toBe(true);
  });

  it("accepts out-of-scope and policy counts as disjoint non-gating components", () => {
    const event = {
      schema_version: "6",
      event: "run.completed",
      run_id: "run-1",
      seq: 9,
      timestamp: "2026-09-05T10:00:00.000Z",
      data: {
        run_outcome: "clear",
        gate_outcome: "no_gate_findings",
        coverage_outcome: "complete",
        exit_code: 0,
        raw_source_findings: 5,
        atomic_subfindings: 5,
        canonical_roots: 1,
        gate_eligible_subfindings: 0,
        advisory_subfindings: 1,
        rejected_subfindings: 1,
        needs_verification_subfindings: 1,
        out_of_scope_subfindings: 1,
        policy_non_gating_subfindings: 1,
        non_gating_subfindings: 5,
        incomplete_lenses: 0,
        result_delivery: {
          completed_results: 1,
          artifact: "complete",
          planned_public_stream: "references_only",
        },
        artifact: {
          path: ".review-mesh/runs/run-1.jsonl",
          sha256,
          byte_count: 1234,
          completed_results: 1,
        },
        lens_summaries: [],
        exclusions: [],
        warnings: [],
        deficit_samples: [],
      },
    };
    expect(publicEventV6Schema.safeParse(event).success).toBe(true);
  });

  it("rejects a terminal event whose named non-gating components contradict the total", () => {
    const event = {
      schema_version: "6",
      event: "run.completed",
      run_id: "run-1",
      seq: 9,
      timestamp: "2026-09-05T10:00:00.000Z",
      data: {
        run_outcome: "clear",
        gate_outcome: "no_gate_findings",
        coverage_outcome: "complete",
        exit_code: 0,
        raw_source_findings: 5,
        atomic_subfindings: 5,
        canonical_roots: 1,
        gate_eligible_subfindings: 0,
        advisory_subfindings: 5,
        rejected_subfindings: 1,
        needs_verification_subfindings: 0,
        non_gating_subfindings: 5,
        incomplete_lenses: 0,
        result_delivery: {
          completed_results: 1,
          artifact: "complete",
          planned_public_stream: "references_only",
        },
        artifact: {
          path: ".review-mesh/runs/run-1.jsonl",
          sha256,
          byte_count: 1234,
          completed_results: 1,
        },
        lens_summaries: [],
        exclusions: [],
        warnings: [],
        deficit_samples: [],
      },
    };
    expect(publicEventV6Schema.safeParse(event).success).toBe(false);
  });
});
