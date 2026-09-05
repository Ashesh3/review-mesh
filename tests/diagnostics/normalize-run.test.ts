import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRunArtifact } from "../../src/diagnostics/run-artifact.js";
import { readNormalizedRun } from "../../src/diagnostics/normalize-run.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
describe("one normalized run model", () => {
  it("preserves incomplete terminal change coverage even beside complete accepted results", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "review-mesh-normalize-partial-"),
    );
    roots.push(root);
    const path = join(root, "run-1.jsonl");
    const writer = await createRunArtifact({
      path,
      runId: "run-1",
      toolVersion: "9.0.0",
    });
    await writer.record({
      record: "context",
      context: { review_scope: { mode: "changes" } },
    });
    for (const [reviewer, status] of [
      ["complete", "complete"],
      ["partial", "incomplete"],
    ] as const) {
      await writer.result(reviewer, {
        schema_version: "4",
        verdict: "pass",
        review_markdown: "Review",
        summary: "Review",
        actionable_findings: [],
        informational_notes: [],
        change_coverage: {
          status,
          proof_kind: "observed",
          scope_digest: "a".repeat(64),
          inspected_count: status === "complete" ? 1 : 0,
          deficit_count: status === "complete" ? 0 : 1,
          deficit_sample: [],
        },
      });
      await writer.record({
        record: "reviewer.terminal",
        reviewer_id: reviewer,
        data: {
          lens_id: reviewer,
          status: status === "complete" ? "completed" : "incomplete",
        },
      });
    }
    await writer.finalize({
      run_outcome: "inconclusive",
      gate_outcome: "no_gate_findings",
      coverage_outcome: "partial",
      exit_code: 3,
      raw_source_findings: 0,
      atomic_subfindings: 0,
      canonical_roots: 0,
      gate_eligible_subfindings: 0,
      advisory_subfindings: 0,
      rejected_subfindings: 0,
      needs_verification_subfindings: 0,
      non_gating_subfindings: 0,
      incomplete_lenses: 1,
      execution_coverage: { status: "complete" },
      change_coverage: { status: "incomplete" },
      result_delivery: {
        completed_results: 2,
        artifact: "complete",
        planned_public_stream: "references_only",
      },
      lens_summaries: [],
      exclusions: [],
      warnings: [],
      deficit_samples: [],
    });
    expect(await readNormalizedRun(path)).toMatchObject({
      run_outcome: "inconclusive",
      coverage_outcome: "partial",
      exit_code: 3,
      change_coverage: { status: "incomplete" },
    });
  });
  it("retains exact accepted results and derives a coverage-first canonical view", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-mesh-normalize-"));
    roots.push(root);
    const path = join(root, "run-1.jsonl");
    const writer = await createRunArtifact({
      path,
      runId: "run-1",
      toolVersion: "9.0.0",
    });
    await writer.record({
      record: "context",
      context: { review_scope: { mode: "full" } },
    });
    await writer.result("lens::model", {
      schema_version: "4",
      verdict: "pass",
      review_markdown: "A complete review",
      summary: "Complete",
      actionable_findings: [],
      informational_notes: [],
      change_coverage: {
        status: "not_applicable",
        inspected_count: 0,
        deficit_count: 0,
        deficit_sample: [],
      },
    });
    await writer.record({
      record: "reviewer.terminal",
      reviewer_id: "lens::model",
      data: { lens_id: "lens", status: "completed" },
    });
    const reference = await writer.finalize({
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
      lens_summaries: [{ lens_id: "lens", outcome: "passed" }],
      exclusions: [],
      warnings: [],
      deficit_samples: [],
    });
    const normalized = await readNormalizedRun(path, {
      expectedSha256: reference.sha256,
    });
    expect(normalized).toMatchObject({
      run_outcome: "clear",
      gate_outcome: "no_gate_findings",
      coverage_outcome: "complete",
      artifact: reference,
      digest_status: "verified",
    });
    expect(normalized.reviewers[0]?.result?.review_markdown).toBe(
      "A complete review",
    );
    expect(normalized.canonical.counts.atomic_subfindings).toBe(0);
    expect(normalized.change_coverage.status).toBe("not_applicable");
  });
});
