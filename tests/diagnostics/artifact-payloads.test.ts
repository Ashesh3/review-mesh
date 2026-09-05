import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRunArtifact,
  readRunArtifact,
} from "../../src/diagnostics/run-artifact.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "review-mesh-payloads-"));
  roots.push(root);
  return join(root, "run.jsonl");
}

const summary = {
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
    completed_results: 0,
    artifact: "complete",
    planned_public_stream: "references_only",
  },
  lens_summaries: [],
  exclusions: [],
  warnings: [],
  deficit_samples: [],
};

const finding = {
  provenance: "reviewer_result_v4",
  source_ref: "reviewer-1#finding-1",
  reviewer_id: "reviewer-1",
  lens_id: "security",
  finding_id: "finding-1",
  severity: "high",
  title: "Unsafe fallback",
  description: "The fallback accepts an invalid record.",
  evidence: [
    {
      path: "src/example.ts",
      start_line: 1,
      end_line: 1,
      detail: "Invalid input is accepted.",
    },
  ],
  suggested_direction: "Reject the invalid record.",
  confidence: "high",
  classification: "confirmed_defect",
  external_assumptions: [],
  source_findings: [{ reviewer_id: "reviewer-1", finding_id: "finding-1" }],
  duplicate_finding_ids: [],
};

const findings = {
  raw: [finding],
  proof_by_source_ref: {
    "reviewer-1#finding-1": {
      evidence_verified: true,
      source_coverage_verified: true,
    },
  },
  adjudication_outcomes: [
    {
      adjudicator_reviewer_id: "judge-1",
      source_reviewer_id: "reviewer-1",
      complete: false,
      decisions: [
        {
          source_finding_id: "candidate-1",
          requested_decision: "missing",
          effective_decision: "needs_verification",
          gate_eligible: false,
          issues: ["decision_required"],
        },
      ],
      unknown_source_finding_ids: [],
    },
  ],
  gate_policies: {
    security: { minimumSeverity: "medium", minimumConfidence: "medium" },
  },
  canonical_counts: {
    raw_source_findings: 1,
    atomic_subfindings: 1,
    canonical_roots: 1,
    gate_eligible_subfindings: 1,
    advisory_subfindings: 0,
    rejected_subfindings: 0,
    needs_verification_subfindings: 0,
    out_of_scope_subfindings: 0,
    policy_non_gating_subfindings: 0,
    non_gating_subfindings: 0,
  },
};

async function rewriteRecord(
  path: string,
  kind: string,
  mutate: (record: Record<string, any>) => void,
) {
  const records = (await readFile(path, "utf8"))
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  const record = records.find((value) => value.record === kind);
  if (record === undefined) throw new Error(`Missing ${kind} record.`);
  mutate(record);
  const prefix =
    records
      .slice(0, -1)
      .map((value) => JSON.stringify(value))
      .join("\n") + "\n";
  records.at(-1).content_sha256 = createHash("sha256")
    .update(prefix)
    .digest("hex");
  records.at(-1).content_byte_count = Buffer.byteLength(prefix);
  await writeFile(path, prefix + JSON.stringify(records.at(-1)) + "\n");
}

async function artifactWithStrictPayloads() {
  const path = await fixture();
  const writer = await createRunArtifact({
    path,
    runId: "run-1",
    toolVersion: "9.0.0",
  });
  await writer.record({
    record: "request",
    request: {
      schema_version: "3",
      project_name: "project",
      workspace: "C:/workspace",
      instructions: "Review the change.",
      review_scope: { mode: "changes", base: "main" },
      context: { deliberately_open: { nested: [1, true, null] } },
    },
  });
  await writer.record({
    record: "context",
    context: {
      consistency_mode: "live_worktree",
      workspace: "C:/workspace",
      project_name: "project",
      instructions: "Review the change.",
      caller_context: { deliberately_open: { nested: [1, true, null] } },
      request: { schema_version: "3", request_id: "request-1" },
      review_scope: { mode: "changes", source: "request", base: "main" },
      git: {
        is_repository: true,
        root: "C:/workspace",
        branch: "feature",
        head: "a".repeat(40),
        merge_base: "b".repeat(40),
        status_entries: [],
        changed_files: ["src/example.ts"],
        changed_paths: [{ path: "src/example.ts", kind: "tracked" }],
        diff_stat: "1 file changed",
        diff: "diff --git a/src/example.ts b/src/example.ts",
        raw_diff: { byte_count: 47, sha256: "c".repeat(64) },
        shallow: false,
        truncated: {
          status_entries: false,
          changed_files: false,
          diff_stat: false,
          diff: false,
        },
      },
    },
  });
  await writer.record({
    record: "resolution",
    resolution: {
      reviewers: [
        {
          id: "reviewer-1",
          agent_id: "security",
          policy: {
            passQuorum: 1,
            minimumProviderGroups: 1,
            adjudication: "off",
            gateMinimumSeverity: "medium",
            gateMinimumConfidence: "medium",
          },
        },
      ],
    },
  });
  await writer.record({
    record: "reviewer.attempt",
    reviewer_id: "reviewer-1",
    data: {
      attempt: 1,
      started_at: "2026-09-05T00:00:00.000Z",
      elapsed_ms: 1,
      failure: {
        reason: "provider_response_invalid",
        message: "Invalid response.",
        retryable: false,
        diagnostics: {
          failure_code: "provider_response_invalid",
          failure_stage: "structured_result_validation",
          scope: "model",
          validation_issues: [
            {
              path: "actionable_findings",
              code: "invalid_type",
              message: "Expected an array.",
            },
          ],
        },
      },
    },
  });
  await writer.record({ record: "run.findings", data: findings });
  await writer.finalize(summary);
  return path;
}

describe("strict format-two private payloads", () => {
  it("accepts deliberate arbitrary caller context", async () => {
    const path = await artifactWithStrictPayloads();
    await expect(readRunArtifact(path)).resolves.toMatchObject({
      run_id: "run-1",
      active: false,
    });
  });

  it.each([
    [
      "canonical raw finding",
      "run.findings",
      (record: any) => {
        record.data.raw[0].severity = "urgent";
      },
    ],
    [
      "canonical proof",
      "run.findings",
      (record: any) => {
        record.data.proof_by_source_ref[
          "reviewer-1#finding-1"
        ].evidence_verified = "yes";
      },
    ],
    [
      "effective adjudication decision",
      "run.findings",
      (record: any) => {
        record.data.adjudication_outcomes[0].decisions[0].issues = [
          "future_issue",
        ];
      },
    ],
    [
      "adjudication outcome",
      "run.findings",
      (record: any) => {
        record.data.adjudication_outcomes[0].complete = "no";
      },
    ],
    [
      "captured Git context",
      "context",
      (record: any) => {
        record.context.git.changed_paths[0].kind = "renamed";
      },
    ],
    [
      "normalized request metadata",
      "context",
      (record: any) => {
        record.context.request.schema_version = "999";
      },
    ],
    [
      "request",
      "request",
      (record: any) => {
        record.request.review_scope.mode = "partial";
      },
    ],
    [
      "resolution",
      "resolution",
      (record: any) => {
        record.resolution.reviewers[0].policy.passQuorum = 0;
      },
    ],
    [
      "failure diagnostics",
      "reviewer.attempt",
      (record: any) => {
        record.data.failure.diagnostics.http_status = 42;
      },
    ],
    [
      "unknown diagnostic field",
      "reviewer.attempt",
      (record: any) => {
        record.data.failure.diagnostics.provider_blob = { arbitrary: true };
      },
    ],
    [
      "unknown nested finding field",
      "run.findings",
      (record: any) => {
        record.data.raw[0].future_field = true;
      },
    ],
  ])(
    "rejects malformed %s during artifact replay",
    async (_name, kind, mutate) => {
      const path = await artifactWithStrictPayloads();
      await rewriteRecord(path, kind, mutate);
      await expect(readRunArtifact(path)).rejects.toMatchObject({
        code: "invalid_artifact_record",
      });
    },
  );
});
