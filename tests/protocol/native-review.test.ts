import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  providerReviewerResultV4Schema,
  reviewerResultV4Schema,
  type ActionableFindingV4,
  type AdjudicationResultV2,
} from "../../src/protocol/v9.js";
import {
  buildCanonicalRawFindings,
  canonicalizeFindings,
} from "../../src/findings/canonical.js";
import { resolvedContext, resolvedReviewer } from "../helpers/fixtures.js";
import {
  createRunArtifact,
  readRunArtifact,
} from "../../src/diagnostics/run-artifact.js";

const finding: ActionableFindingV4 = {
  id: "f1",
  severity: "high",
  title: "Stale return",
  description: "The new branch returns the previous value.",
  evidence: [
    {
      path: "worker.ts",
      start_line: 1,
      end_line: 1,
      detail: "The old value is returned.",
    },
  ],
  suggested_direction: "Return the updated value.",
  confidence: "high",
  classification: "confirmed_defect",
  external_assumptions: [],
  category: "correctness",
  verification: "Trace the changed return value.",
  change_impact: "The changed return branch exposes stale data.",
  claim: {
    trigger: "The value changes.",
    affected_behavior: "The return branch uses the old value.",
    outcome: "The caller gets stale data.",
  },
};
const result = () => ({
  schema_version: "4",
  verdict: "fail",
  review_markdown: "# Review\nOne finding.",
  summary: "One finding.",
  actionable_findings: [structuredClone(finding)],
  informational_notes: [],
  native_scope_attestation: {
    reviewed_paths: ["worker.ts"],
    complete: true,
    limitations: [],
  },
});
const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true });
});

describe("native review contract", () => {
  it("keeps a large original diff in the readable native context instead of duplicating it in every model prompt", async () => {
    const native = await import("../../src/protocol/native-review.js");
    const diff =
      "diff --git a/source.ts b/source.ts\n" +
      "+ORIGINAL_RETAINED_DIFF_LINE\n".repeat(6000);
    const context = resolvedContext({
      git: {
        is_repository: true,
        root: "F:/review",
        head: "a".repeat(40),
        branch: "review",
        merge_base: "b".repeat(40),
        status_entries: [],
        changed_files: ["source.ts"],
        diff_stat: "1 file",
        diff,
        raw_diff: {
          byte_count: Buffer.byteLength(diff),
          sha256: "c".repeat(64),
        },
        truncated: {
          status_entries: false,
          changed_files: false,
          diff_stat: false,
          diff: false,
        },
      },
    });
    const prompt = native.buildNativeReviewPrompt(resolvedReviewer(), context);
    expect(prompt.user).not.toContain("ORIGINAL_RETAINED_DIFF_LINE");
    expect(prompt.user).toContain("retained_native_diff");
    expect(prompt.system).toContain("retained original diff");
    expect(context.git.is_repository && context.git.diff).toBe(diff);
  });
  it("lets native reviewers choose inspection without attestation or read checklists", async () => {
    const native = await import("../../src/protocol/native-review.js");
    const reviewer = resolvedReviewer({
      instruction_layers: [
        { source: "trusted", content: "Configured review instructions" },
      ],
      policy: {
        passQuorum: 1,
        minimumProviderGroups: 1,
        adjudication: "required",
        gateMinimumSeverity: "medium",
        gateMinimumConfidence: "medium",
        changeCoverage: {
          relevantPaths: ["**"],
          minimumInspection: "full_file",
          proof: "native_attested",
        },
      },
    });
    const context = resolvedContext({
      git: {
        is_repository: true,
        root: "F:/repo",
        head: "abc",
        merge_base: "base",
        branch: "feature",
        status_entries: [],
        changed_files: ["a.ts", "b.ts"],
        diff_stat: "",
        diff: "original-diff-marker",
        truncated: {
          status_entries: false,
          changed_files: false,
          diff_stat: false,
          diff: false,
        },
      },
    });
    const prompt = native.buildNativeReviewPrompt(reviewer, context);
    expect(prompt.system).toContain("Configured review instructions");
    expect(prompt.system).toContain("read-only");
    expect(prompt.system).toContain("Git");
    expect(prompt.system).toContain("plain-text");
    expect(prompt.system).not.toMatch(
      /mandatory|checklist|full.file inspection|Read each required|batch|next-offset|native_scope_attestation|ordered_execution_proof|base_head_comparison/,
    );
    expect(prompt.user).toContain("original-diff-marker");
    expect(prompt.user).toContain('"branch": "feature"');
    const schema = native.nativeResultJsonSchema(reviewer);
    expect(schema.required).not.toContain("native_scope_attestation");
    expect(schema.properties).not.toHaveProperty("native_scope_attestation");
    expect(schema.properties).not.toHaveProperty("coverage_attestation");
    const { native_scope_attestation: _old, ...without } = result();
    expect(
      native.validateNativeSubmission(
        reviewer,
        context,
        providerReviewerResultV4Schema.parse(without),
      ),
    ).toEqual({ accepted: true });
    for (const complete of [true, false])
      expect(
        native.validateNativeSubmission(
          reviewer,
          context,
          providerReviewerResultV4Schema.parse({
            ...result(),
            native_scope_attestation: {
              complete,
              reviewed_paths: [],
              limitations: ["Historical metadata only"],
            },
          }),
        ),
      ).toEqual({ accepted: true });
  });

  it("represents agent-selected inspection without an invented coverage claim", async () => {
    const native = await import("../../src/protocol/native-review.js");
    expect(native.createAgentSelectedChangeCoverage()).toEqual({
      status: "not_applicable",
      proof_kind: "unknown",
      contract: "native_review_v1",
      inspected_count: 0,
      deficit_count: 0,
      deficit_sample: [],
    });
  });

  it("validates every native adjudication candidate without requiring an unrelated full review", async () => {
    const native = await import("../../src/protocol/native-review.js");
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
    const decision = {
      source_finding_id: "one",
      decision: "rejected" as const,
      rationale: "The cited behavior is unchanged.",
      cited_evidence: [],
      unverified_assumptions: [],
    };
    const report: AdjudicationResultV2 = {
      schema_version: "2",
      kind: "review-mesh.adjudication-result",
      verdict: "pass",
      review_markdown: "Checked the candidates",
      summary: "No defects",
      actionable_findings: [],
      decisions: [decision],
      informational_notes: [],
    };
    const context = resolvedContext();
    expect(
      native.validateNativeSubmission(reviewer, context, report),
    ).toMatchObject({
      accepted: false,
      message: expect.stringContaining("two"),
    });
    report.decisions.push({ ...decision, source_finding_id: "two" });
    expect(native.validateNativeSubmission(reviewer, context, report)).toEqual({
      accepted: true,
    });
    report.decisions.push(decision);
    expect(
      native.validateNativeSubmission(reviewer, context, report),
    ).toMatchObject({
      accepted: false,
      message: expect.stringContaining("duplicate"),
    });
    report.decisions = [{ ...decision, source_finding_id: "unknown" }];
    expect(
      native.validateNativeSubmission(reviewer, context, report),
    ).toMatchObject({
      accepted: false,
      message: expect.stringContaining("unknown"),
    });
    const prompt = native.buildNativeReviewPrompt(reviewer, context);
    expect(prompt.system).not.toContain("Review the declared changed paths");
    expect(prompt.system).toContain("assigned candidate");
    expect(prompt.system).toContain("ADJUDICATION CANDIDATES");
    expect(prompt.system).toContain('"id": "one"');
    expect(prompt.user).not.toContain("REQUIRED CHANGED PATH CHECKLIST");
  });

  it("retains more than sixteen native findings without requiring scope attestation", () => {
    const value = result();
    value.actionable_findings = Array.from({ length: 17 }, (_, index) => ({
      ...structuredClone(finding),
      id: `f${index}`,
    })) as typeof value.actionable_findings;
    expect(providerReviewerResultV4Schema.safeParse(value).success).toBe(true);
    const { native_scope_attestation: _attestation, ...unattested } = value;
    expect(providerReviewerResultV4Schema.safeParse(unattested).success).toBe(
      true,
    );
  });

  it("round trips native execution provenance through the strict artifact writer", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mesh-native-artifact-"));
    directories.push(directory);
    const path = join(directory, "native.jsonl");
    const artifact = await createRunArtifact({
      path,
      runId: "native-contract",
      toolVersion: "test",
    });
    try {
      await artifact.record({
        record: "reviewer.native_execution",
        reviewer_id: "native",
        data: {
          contract: "native_review_v1",
          harness: "codex",
          model: "test",
          sdk_version: "1",
          execution_mode: "managed_process",
          consistency_mode: "live_worktree",
          coverage_basis: "model_attested",
          sdk_completed: true,
        },
      });
      await artifact.record({
        record: "run.native_consistency",
        data: {
          contract: "native_review_v1",
          consistency_mode: "live_worktree",
          initial: { sha256: "a".repeat(64), file_count: 1, complete: true },
          final: { sha256: "b".repeat(64), file_count: 1, complete: true },
          changed: true,
        },
      });
    } finally {
      await artifact.close();
    }
    const loaded = await readRunArtifact(path, { allowActive: true });
    expect(
      loaded.records.find(
        (record) => record.record === "reviewer.native_execution",
      )?.data,
    ).toMatchObject({ coverage_basis: "model_attested", sdk_completed: true });
    expect(
      loaded.records.find(
        (record) => record.record === "run.native_consistency",
      )?.data,
    ).toMatchObject({ changed: true });
  });
  it("accepts explicit model scope attestation without snapshot digests", () => {
    expect(providerReviewerResultV4Schema.safeParse(result()).success).toBe(
      true,
    );
    expect(
      providerReviewerResultV4Schema.safeParse({ ...result(), verdict: "pass" })
        .success,
    ).toBe(false);
  });

  it("rejects native attestation paths that escape the workspace", () => {
    expect(
      providerReviewerResultV4Schema.safeParse({
        ...result(),
        native_scope_attestation: {
          reviewed_paths: ["../secret"],
          complete: true,
          limitations: [],
        },
      }).success,
    ).toBe(false);
  });

  it("preserves partial scope instead of promoting SDK completion to coverage", async () => {
    const native = await import("../../src/protocol/native-review.js");
    const context = resolvedContext({
      git: {
        is_repository: true,
        root: "F:/Projects/demo",
        branch: "main",
        head: "abc",
        merge_base: "abc",
        status_entries: [],
        changed_files: ["worker.ts", "support.ts"],
        diff_stat: "",
        diff: "",
        truncated: {
          status_entries: false,
          changed_files: false,
          diff_stat: false,
          diff: false,
        },
      },
    });
    expect(
      native.createNativeChangeCoverage(context, {
        scopeAttested: true,
        inspectedPaths: ["worker.ts"],
        relevantPaths: ["worker.ts", "support.ts"],
      }),
    ).toMatchObject({
      status: "incomplete",
      proof_kind: "native_attested",
      contract: "native_review_v1",
      inspected_count: 1,
      deficit_count: 1,
    });
    expect(
      native.createNativeChangeCoverage(context, {
        scopeAttested: false,
        relevantPaths: [],
      }),
    ).toMatchObject({ status: "incomplete", proof_kind: "unknown" });
  });

  it("requires an explicit whole-workspace attestation for full review", async () => {
    const native = await import("../../src/protocol/native-review.js");
    const context = resolvedContext({
      review_scope: { mode: "full", source: "request" },
    });
    expect(
      native.createNativeChangeCoverage(context, {
        scopeAttested: true,
        inspectedPaths: ["worker.ts"],
      }),
    ).toMatchObject({
      status: "complete",
      proof_kind: "native_attested",
      contract: "native_review_v1",
    });
    expect(
      native.createNativeChangeCoverage(context, { scopeAttested: false }),
    ).toMatchObject({ status: "incomplete", proof_kind: "unknown" });
  });

  it("does not claim a change scope when a non-Git workspace supplies no obligations", async () => {
    const native = await import("../../src/protocol/native-review.js");
    expect(
      native.createNativeChangeCoverage(resolvedContext(), {
        scopeAttested: true,
        inspectedPaths: [],
        relevantPaths: [],
      }),
    ).toMatchObject({
      status: "incomplete",
      deficit_sample: [
        { path: "<change_scope>", reason: "change_scope_unknown" },
      ],
    });
  });

  it("keeps valid native findings gate eligible without inventing observed bytes", async () => {
    const native = await import("../../src/protocol/native-review.js");
    const workspace = await mkdtemp(join(tmpdir(), "mesh-native-proof-"));
    directories.push(workspace);
    await writeFile(join(workspace, "worker.ts"), "return oldValue;\n");
    const context = resolvedContext({
      workspace,
      review_scope: { mode: "full", source: "request" },
    });
    const provider = providerReviewerResultV4Schema.parse(result());
    const proofs = await native.validateNativeEvidence(
      workspace,
      provider,
      context,
    );
    expect(proofs.f1).toMatchObject({
      native_evidence: {
        contract: "native_review_v1",
        citation_valid: true,
        scope_attested: true,
        scope_related: true,
      },
    });
    expect(proofs.f1).not.toHaveProperty("evidence_verified");
    expect(proofs.f1).not.toHaveProperty("source_coverage_verified");
    const final = reviewerResultV4Schema.parse({
      ...provider,
      change_coverage: native.createNativeChangeCoverage(context, {
        scopeAttested: true,
        inspectedPaths: ["worker.ts"],
      }),
    });
    const raw = buildCanonicalRawFindings({
      reviewer_id: "native",
      lens_id: "lens",
      result: final,
    });
    expect(
      canonicalizeFindings(raw, {
        proofBySourceRef: { "native#f1": proofs.f1! },
      }).counts.gate_eligible_subfindings,
    ).toBe(1);
  });

  it("keeps a nonexistent cited line unverified even when the model attests completion", async () => {
    const native = await import("../../src/protocol/native-review.js");
    const workspace = await mkdtemp(join(tmpdir(), "mesh-native-line-"));
    directories.push(workspace);
    await writeFile(join(workspace, "worker.ts"), "return oldValue;");
    const value = result();
    value.actionable_findings[0]!.evidence[0] = {
      ...value.actionable_findings[0]!.evidence[0]!,
      start_line: 99,
      end_line: 99,
    };
    const context = resolvedContext({
      workspace,
      review_scope: { mode: "full", source: "request" },
    });
    const proofs = await native.validateNativeEvidence(
      workspace,
      providerReviewerResultV4Schema.parse(value),
      context,
    );
    expect(proofs.f1?.native_evidence?.citation_valid).toBe(false);
  });

  it("asks adjudication for v2 decisions and retains the caller context", async () => {
    const native = await import("../../src/protocol/native-review.js");
    const reviewer = resolvedReviewer({
      policy: {
        mode: "adjudication",
        candidateFindings: [{ id: "candidate-1" }],
        passQuorum: 1,
        minimumProviderGroups: 1,
        adjudication: "required",
        gateMinimumSeverity: "medium",
        gateMinimumConfidence: "medium",
      },
    });
    const prompt = native.buildNativeReviewPrompt(
      reviewer,
      resolvedContext({
        instructions: "Review the queue ordering.",
        caller_context: { unique_context_marker: 12 },
      }),
    );
    const schema = native.nativeResultJsonSchema(reviewer) as {
      properties: {
        schema_version: { const: string };
        decisions: {
          items: { properties: { source_finding_id: { enum: string[] } } };
        };
      };
    };
    expect(schema.properties.schema_version.const).toBe("2");
    expect(
      schema.properties.decisions.items.properties.source_finding_id.enum,
    ).toEqual(["candidate-1"]);
    expect(prompt.user).toContain("unique_context_marker");
    expect(prompt.user).toContain("Review the queue ordering.");
    expect(prompt.system).not.toMatch(
      /core-assigned result page|Review Mesh-mediated reads|exact coverage attestation/u,
    );
  });
});
