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
  it("lists concrete full-file obligations separately from supporting scope", async () => {
    const native = await import("../../src/protocol/native-review.js");
    const reviewer = resolvedReviewer({
      policy: {
        passQuorum: 1,
        minimumProviderGroups: 1,
        adjudication: "required",
        gateMinimumSeverity: "medium",
        gateMinimumConfidence: "medium",
        changeCoverage: {
          relevantPaths: ["src/**"],
          minimumInspection: "full_file",
          proof: "native_attested",
        },
      },
    });
    const context = resolvedContext({
      git: {
        is_repository: true,
        root: "F:/Projects/demo",
        branch: "main",
        head: "abc",
        merge_base: "abc",
        status_entries: [],
        changed_files: ["test/worker.ts", "src/worker.ts", "src/support.ts"],
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
    expect(native.nativeRequiredPaths(reviewer, context)).toEqual([
      "src/support.ts",
      "src/worker.ts",
    ]);
    const prompt = native.buildNativeReviewPrompt(reviewer, context);
    expect(prompt.system).toContain("Read each required changed file in full");
    expect(prompt.system).toContain("DURABLE NATIVE REVIEW SCOPE");
    expect(prompt.system).toContain(
      '"required_paths": [\n    "src/support.ts",\n    "src/worker.ts"',
    );
    expect(prompt.system).toContain(
      "Internal SDK compaction is not the final review answer",
    );
    expect(prompt.system).toContain(
      "preserve the exact inspected and remaining path lists",
    );
    expect(prompt.user).toContain("REQUIRED CHANGED PATH CHECKLIST");
    expect(prompt.user).toContain(
      '"required_paths": [\n    "src/support.ts",\n    "src/worker.ts"',
    );
    const partial = providerReviewerResultV4Schema.parse({
      ...result(),
      native_scope_attestation: {
        complete: true,
        reviewed_paths: ["src/worker.ts"],
        limitations: [],
      },
    });
    expect(
      native.validateNativeSubmission(reviewer, context, partial),
    ).toMatchObject({
      accepted: false,
      message: expect.stringContaining("src/support.ts"),
    });
    partial.native_scope_attestation!.reviewed_paths.push("src/support.ts");
    expect(native.validateNativeSubmission(reviewer, context, partial)).toEqual(
      { accepted: true },
    );
    partial.native_scope_attestation = {
      complete: false,
      reviewed_paths: ["src/worker.ts"],
      limitations: ["Supporting file could not be read."],
    };
    expect(native.validateNativeSubmission(reviewer, context, partial)).toEqual(
      { accepted: true },
    );
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
    expect(prompt.system).toContain("not a second full-scope review");
    expect(prompt.system).toContain("DURABLE ADJUDICATION CANDIDATES");
    expect(prompt.system).toContain('"id": "one"');
    expect(prompt.user).not.toContain("REQUIRED CHANGED PATH CHECKLIST");
  });

  it("retains more than sixteen native findings while preserving the legacy limit", () => {
    const value = result();
    value.actionable_findings = Array.from({ length: 17 }, (_, index) => ({
      ...structuredClone(finding),
      id: `f${index}`,
    })) as typeof value.actionable_findings;
    expect(providerReviewerResultV4Schema.safeParse(value).success).toBe(true);
    const { native_scope_attestation: _attestation, ...legacy } = value;
    expect(providerReviewerResultV4Schema.safeParse(legacy).success).toBe(
      false,
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
