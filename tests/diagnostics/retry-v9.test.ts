import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ResolvedConfig } from "../../src/config/schemas.js";
import type { ResolvedContext } from "../../src/context/resolve.js";
import { createRunArtifact } from "../../src/diagnostics/run-artifact.js";
import { indexRunArtifact } from "../../src/diagnostics/run-index.js";
import { prepareV9Retry } from "../../src/diagnostics/retry-v9.js";
import {
  buildCanonicalRawFindings,
  canonicalizeFindings,
} from "../../src/findings/canonical.js";
import type { ReviewerResultV4 } from "../../src/protocol/v9.js";
import { roundInput, resolvedContext } from "../helpers/fixtures.js";
import { runV9Review } from "../../src/orchestrator/run-v9.js";
import { AdapterRegistry } from "../../src/adapters/registry.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const result = (verdict: "pass" | "fail"): ReviewerResultV4 => ({
  schema_version: "4",
  verdict,
  review_markdown: verdict === "pass" ? "Clean." : "Known issue.",
  summary: verdict === "pass" ? "Clean." : "Known issue remains.",
  actionable_findings:
    verdict === "pass"
      ? []
      : [
          {
            id: "known-finding",
            severity: "high",
            title: "Known defect",
            description: "The parent found a defect.",
            evidence: [{ path: "worker.ts", detail: "Broken behavior." }],
            suggested_direction: "Fix the defect.",
            confidence: "high",
            classification: "confirmed_defect",
            external_assumptions: [],
            category: "correctness",
            verification: "The broken behavior is directly visible.",
            claim: {
              trigger: "The changed code runs",
              affected_behavior: "It returns the wrong value",
              outcome: "The caller observes the defect",
            },
          },
        ],
  informational_notes: [],
  change_coverage: {
    status: "complete",
    proof_kind: "observed",
    scope_digest: "b".repeat(64),
    inspected_count: 1,
    deficit_count: 0,
    deficit_sample: [],
  },
});

function policy(config: ResolvedConfig, lensId: string) {
  return config.reviewers.find(
    (reviewer) => (reviewer.agentId ?? reviewer.id) === lensId,
  )!.policy;
}

async function parentFixture(options: {
  context: ResolvedContext;
  config: ResolvedConfig;
  completed: Array<{
    reviewerId: string;
    lensId: string;
    result: ReviewerResultV4;
  }>;
  incompleteLensIds?: string[];
}) {
  const root = await mkdtemp(join(tmpdir(), "review-mesh-v9-retry-"));
  roots.push(root);
  const runsDirectory = join(root, "runs");
  const runId = "parent-run";
  const path = join(runsDirectory, `${runId}.jsonl`);
  const writer = await createRunArtifact({ path, runId, toolVersion: "9.0.0" });
  await writer.record({
    record: "request",
    request: {
      schema_version: "3",
      project_name: options.context.project_name,
      workspace: options.context.workspace,
      instructions: options.context.instructions,
      review_scope: { mode: options.context.review_scope.mode },
    },
  });
  await writer.record({ record: "context", context: options.context });
  await writer.record({
    record: "resolution",
    resolution: {
      reviewers: options.config.reviewers.map((reviewer) => ({
        id: reviewer.id,
        agent_id: reviewer.agentId ?? reviewer.id,
        ...(reviewer.policy === undefined ? {} : { policy: reviewer.policy }),
      })),
    },
  });
  for (const completed of options.completed) {
    await writer.result(completed.reviewerId, completed.result);
    await writer.record({
      record: "reviewer.coverage",
      reviewer_id: completed.reviewerId,
      data: {
        index: 0,
        entries: [
          {
            path: "worker.ts",
            kind: "tracked",
            relevant: true,
            required_method: "full_file",
            proof_kind: "observed",
            snapshot_digest: "a".repeat(64),
            snapshot_byte_count: 10,
            snapshot_read: "satisfied",
            diff_delivery: "satisfied",
            disposition: "satisfied",
          },
        ],
      },
    });
    await writer.record({
      record: "reviewer.terminal",
      reviewer_id: completed.reviewerId,
      data: {
        status: "completed",
        lens_id: completed.lensId,
        mode: "full_review",
        finding_proofs: completed.result.actionable_findings.length
          ? {
              "known-finding": {
                evidence_verified: true,
                source_coverage_verified: true,
              },
            }
          : {},
      },
    });
  }
  for (const lensId of options.incompleteLensIds ?? [])
    await writer.record({
      record: "reviewer.terminal",
      reviewer_id: `${lensId}::retry`,
      data: { status: "incomplete", lens_id: lensId, reason: "timeout" },
    });
  const completedResults = options.completed.length;
  const raw = options.completed.flatMap((item) =>
    buildCanonicalRawFindings({
      reviewer_id: item.reviewerId,
      lens_id: item.lensId,
      result: item.result,
    }),
  );
  const canonical = canonicalizeFindings(raw, {
    proofBySourceRef: Object.fromEntries(
      raw.map((finding) => [
        finding.source_ref,
        { evidence_verified: true, source_coverage_verified: true },
      ]),
    ),
  });
  await writer.record({
    record: "run.findings",
    data: {
      raw,
      proof_by_source_ref: Object.fromEntries(
        raw.map((finding) => [
          finding.source_ref,
          { evidence_verified: true, source_coverage_verified: true },
        ]),
      ),
      adjudication_outcomes: [],
      gate_policies: {},
      canonical_counts: Object.fromEntries(
        Object.entries(canonical.counts).filter(
          ([key]) => !["raw", "unique", "gate", "advisory"].includes(key),
        ),
      ),
    },
  });
  const {
    raw: _raw,
    unique: _unique,
    gate: _gate,
    advisory: _advisory,
    ...canonicalCounts
  } = canonical.counts;
  const reference = await writer.finalize({
    run_outcome: "inconclusive",
    gate_outcome: options.completed.some(
      (item) => item.result.verdict === "fail",
    )
      ? "gate_findings"
      : "no_gate_findings",
    coverage_outcome: "partial",
    exit_code: 3,
    ...canonicalCounts,
    incomplete_lenses: options.incompleteLensIds?.length ?? 0,
    execution_coverage: { status: "partial" },
    change_coverage: { status: "complete" },
    result_delivery: {
      completed_results: completedResults,
      artifact: "complete",
      planned_public_stream: "references_only",
    },
    lens_summaries: [],
    exclusions: [],
    warnings: [],
    deficit_samples: [],
  });
  await indexRunArtifact({ runsDirectory, runId, artifact: reference });
  return { runsDirectory, runId };
}

describe("v9 retry inheritance", () => {
  it("inherits digest-verified completed parent results and preserves known findings", async () => {
    const base = roundInput();
    const security = structuredClone(base.config.reviewers[0]!);
    security.id = "security::0";
    security.agentId = "security";
    security.policy = {
      passQuorum: 1,
      minimumProviderGroups: 1,
      adjudication: "off",
      gateMinimumSeverity: "medium",
      gateMinimumConfidence: "medium",
    };
    const readiness = structuredClone(base.config.reviewers[0]!);
    readiness.id = "readiness::0";
    readiness.agentId = "readiness";
    readiness.policy = structuredClone(security.policy);
    const config = { ...base.config, reviewers: [security, readiness] };
    const context = resolvedContext({
      review_scope: { mode: "full", source: "request" },
    });
    const parent = await parentFixture({
      context,
      config,
      completed: [
        { reviewerId: security.id, lensId: "security", result: result("fail") },
      ],
      incompleteLensIds: ["readiness"],
    });

    const retry = await prepareV9Retry({
      runsDirectory: parent.runsDirectory,
      parentRunId: parent.runId,
      selectedLensIds: ["readiness"],
      config,
      context,
    });

    expect(retry.runLensIds).toEqual(["readiness"]);
    expect(retry.inherited).toHaveLength(1);
    expect(retry.inherited[0]).toMatchObject({
      reviewerId: security.id,
      lensId: "security",
      result: { verdict: "fail" },
    });
    expect(retry.inherited[0]?.coverageEntries).toHaveLength(1);
    expect(retry.rawFindings).toHaveLength(1);
    expect(retry.proofBySourceRef).toHaveProperty(
      `${security.id}#known-finding`,
    );
  });

  it("reruns every configured lens when the captured scope or policy differs", async () => {
    const base = roundInput();
    const reviewer = base.config.reviewers[0]!;
    reviewer.id = "security::0";
    reviewer.agentId = "security";
    const readiness = structuredClone(reviewer);
    readiness.id = "readiness::0";
    readiness.agentId = "readiness";
    base.config.reviewers = [reviewer, readiness];
    reviewer.policy = {
      passQuorum: 1,
      minimumProviderGroups: 1,
      adjudication: "off",
      gateMinimumSeverity: "medium",
      gateMinimumConfidence: "medium",
    };
    const context = resolvedContext({
      review_scope: { mode: "full", source: "request" },
    });
    const parent = await parentFixture({
      context,
      config: base.config,
      completed: [
        { reviewerId: reviewer.id, lensId: "security", result: result("pass") },
      ],
      incompleteLensIds: ["security"],
    });
    const drifted = structuredClone(base.config);
    drifted.reviewers[0]!.policy = {
      ...policy(drifted, "security")!,
      gateMinimumSeverity: "critical",
    };

    const retry = await prepareV9Retry({
      runsDirectory: parent.runsDirectory,
      parentRunId: parent.runId,
      selectedLensIds: ["security"],
      config: drifted,
      context: { ...context, instructions: "A new captured instruction." },
    });

    expect(retry.inherited).toEqual([]);
    expect(retry.runLensIds).toEqual(["security", "readiness"]);
  });

  it("rejects a selected lens that no longer exists instead of allowing a zero-run success", async () => {
    const base = roundInput();
    const context = resolvedContext({
      review_scope: { mode: "full", source: "request" },
    });
    const parent = await parentFixture({
      context,
      config: base.config,
      completed: [],
      incompleteLensIds: ["removed-lens"],
    });

    await expect(
      prepareV9Retry({
        runsDirectory: parent.runsDirectory,
        parentRunId: parent.runId,
        selectedLensIds: ["removed-lens"],
        config: base.config,
        context,
      }),
    ).rejects.toThrow(/unknown selected retry lens/i);
  });

  it("rejects a retry request that omits an incomplete parent lens", async () => {
    const base = roundInput();
    const reviewer = base.config.reviewers[0]!;
    reviewer.id = "security::0";
    reviewer.agentId = "security";
    const readiness = structuredClone(reviewer);
    readiness.id = "readiness::0";
    readiness.agentId = "readiness";
    base.config.reviewers = [reviewer, readiness];
    const context = resolvedContext({
      review_scope: { mode: "full", source: "request" },
    });
    const parent = await parentFixture({
      context,
      config: base.config,
      completed: [],
      incompleteLensIds: ["security"],
    });

    await expect(
      prepareV9Retry({
        runsDirectory: parent.runsDirectory,
        parentRunId: parent.runId,
        selectedLensIds: ["readiness"],
        config: base.config,
        context,
      }),
    ).rejects.toThrow(/not selected for retry/i);
  });

  it("keeps inherited parent findings in the child gate while rerunning only selected lenses", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "review-mesh-v9-child-"));
    roots.push(workspace);
    const base = roundInput();
    const security = structuredClone(base.config.reviewers[0]!);
    security.id = "security::0";
    security.agentId = "security";
    security.policy = {
      passQuorum: 1,
      minimumProviderGroups: 1,
      adjudication: "off",
      gateMinimumSeverity: "medium",
      gateMinimumConfidence: "medium",
    };
    const readiness = structuredClone(security);
    readiness.id = "readiness::0";
    readiness.agentId = "readiness";
    base.config.reviewers = [security, readiness];
    const registry = new AdapterRegistry();
    registry.register("command", () => ({
      id: "selected-only",
      async probe() {
        return {
          available: true,
          authenticated: true,
          model_available: true,
          streaming: true,
          cancellation: true,
          maximumIsolation: "runtime_read_only",
          observed_file_access: false,
          progress_observable: false,
        };
      },
      async *run() {
        yield {
          type: "result" as const,
          isolation: "runtime_read_only" as const,
          result: {
            schema_version: "4" as const,
            verdict: "pass" as const,
            review_markdown: "Clear.",
            summary: "Clear.",
            actionable_findings: [],
            informational_notes: [],
          },
        };
      },
    }));
    const inheritedResult = {
      reviewerId: security.id,
      lensId: "security",
      result: result("fail"),
      resultDigest: "unused-by-runner",
      resultByteCount: 1,
      coverageEntries: [],
      terminal: {
        status: "completed",
        lens_id: "security",
        mode: "full_review",
        finding_proofs: {
          "known-finding": {
            evidence_verified: true,
            source_coverage_verified: true,
          },
        },
      },
    };
    const stored: string[] = [];
    const records: Record<string, unknown>[] = [];
    const events: Array<Record<string, unknown>> = [];

    const completion = await runV9Review({
      runId: "child-run",
      config: base.config,
      context: resolvedContext({
        workspace,
        review_scope: { mode: "full", source: "request" },
      }),
      registry,
      signal: new AbortController().signal,
      writer: {
        emit: async (event) => {
          events.push(event as unknown as Record<string, unknown>);
        },
        finish: async () => ({
          path: "/artifact",
          sha256: "a".repeat(64),
          byte_count: 1,
          completed_results: 2,
        }),
        outputFailed: () => false,
        close: async () => undefined,
      },
      record: async (record) => {
        records.push(record);
      },
      recordResult: async (reviewerId) => {
        stored.push(reviewerId);
      },
      retry: {
        parentRunId: "parent-run",
        runLensIds: ["readiness"],
        inherited: [inheritedResult],
        inheritance: "exact",
        rawFindings: buildCanonicalRawFindings({
          reviewer_id: security.id,
          lens_id: "security",
          result: inheritedResult.result,
        }),
        proofBySourceRef: {
          [`${security.id}#known-finding`]: {
            evidence_verified: true,
            source_coverage_verified: true,
          },
        },
        adjudicationOutcomes: [],
      },
    });

    expect(stored.sort()).toEqual(["readiness::0", "security::0"]);
    expect(completion.exitCode).toBe(1);
    expect(completion.canonical.atomics).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "run.started",
      data: { parent_run_id: "parent-run" },
    });
    expect(records).toContainEqual(
      expect.objectContaining({
        record: "reviewer.terminal",
        reviewer_id: "security::0",
        data: expect.objectContaining({ status: "completed" }),
      }),
    );
  });
});
