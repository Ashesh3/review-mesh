import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readDashboardReviewer,
  readDashboardRun,
  readDashboardSnapshot,
} from "../../src/server/dashboard-data.js";
import { createAdjudicationValidationAttestation } from "../../src/findings/attestation.js";
import type {
  AdjudicationResult,
  ReviewerResultV3,
} from "../../src/protocol/schemas.js";
import { reviewerResultDigest } from "../../src/results/digest.js";

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "review-mesh-dashboard-data-"));
  roots.push(root);
  const appPaths = {
    configFile: join(root, "config", "config.toml"),
    reviewersDirectory: join(root, "config", "reviewers"),
    runsDirectory: join(root, "data", "runs"),
  };
  await mkdir(join(root, "config"), { recursive: true });
  await mkdir(appPaths.runsDirectory, { recursive: true });
  await writeFile(
    appPaths.configFile,
    `schema_version = "5"
[execution]
max_concurrency = 2
heartbeat_interval_ms = 15000
shutdown_grace_period_ms = 5000
retry_attempts = 2
retry_backoff_ms = 1000
[diagnostics]
persist_runs = true
max_runs = 50
[adapters.command]
type = "command"
command = "secret-command"
args = ["secret-arg"]
protocol = "review-mesh-command-v1"
[agents.architecture]
adapter = "command"
purpose = "Review architecture"
instructions = "secret instructions"
isolation = "prefer_enforced"
timeout_ms = 5000
model = "model-a"
runtime = { secret = "runtime-secret" }
[defaults]
agents = ["architecture"]
[projects.demo]
agents = ["architecture"]
instructions = "project secret"
context = { token = "project-token" }
`,
  );
  return { root, appPaths };
}

function event(
  eventName: string,
  seq: number,
  timestamp: string,
  data: Record<string, unknown>,
  reviewerId?: string,
) {
  return {
    schema_version: "5",
    event: eventName,
    run_id: "run-demo",
    seq,
    timestamp,
    ...(reviewerId === undefined ? {} : { reviewer_id: reviewerId }),
    data,
  };
}

async function writeRun(runsDirectory: string): Promise<void> {
  const records = [
    {
      record: "resolution",
      run_id: "run-demo",
      resolution: {
        reviewers: [
          {
            id: "architecture::primary",
            agent_id: "architecture",
            model_index: 0,
            configured_model_index: 0,
            model_count: 2,
            purpose: "Review architecture",
            adapter: "command",
            model: "model-a",
            provider_group: "primary",
            isolation_policy: "prefer_enforced",
            timeout_ms: 5000,
          },
          {
            id: "architecture::fallback",
            agent_id: "architecture",
            model_index: 1,
            configured_model_index: 1,
            model_count: 2,
            purpose: "Review architecture",
            adapter: "command",
            model: "model-b",
            provider_group: "fallback",
            isolation_policy: "prefer_enforced",
            timeout_ms: 5000,
          },
        ],
      },
    },
    event("run.started", 1, "2026-09-03T10:00:00.000Z", {
      consistency_mode: "live_worktree",
    }),
    event("context.resolved", 2, "2026-09-03T10:00:00.100Z", {
      workspace: "C:/demo",
      project_name: "demo",
      review_scope: { mode: "changes" },
      git: {
        is_repository: true,
        branch: "feature/dashboard",
        head: "abc",
        merge_base: "def",
        changed_files_count: 3,
        changed_files: ["a.ts", "b.ts", "c.ts"],
        truncated: false,
      },
    }),
    event("suite.resolved", 3, "2026-09-03T10:00:00.200Z", {
      logical_lenses: 1,
      model_runs: 2,
      execution: {
        max_concurrency: 2,
        heartbeat_interval_ms: 15000,
        shutdown_grace_period_ms: 5000,
      },
      lenses: [
        {
          id: "architecture",
          purpose: "Review architecture",
          model_runs: 2,
          pass_quorum: 1,
          minimum_provider_groups: 1,
          adjudication: "off",
        },
      ],
    }),
    event(
      "reviewer.started",
      4,
      "2026-09-03T10:00:01.000Z",
      {
        lens_id: "architecture",
        purpose: "Review architecture",
        adapter: "command",
        model: "model-a",
        isolation_policy: "prefer_enforced",
      },
      "architecture::primary",
    ),
    {
      record: "reviewer.activity",
      run_id: "run-demo",
      reviewer_id: "architecture::primary",
      lens_id: "architecture",
      phase: "reviewing",
      type: "activity",
      timestamp: "2026-09-03T10:00:02.000Z",
      message: "Inspected the dependency graph.",
    },
    event(
      "reviewer.completed",
      5,
      "2026-09-03T10:00:03.000Z",
      {
        lens_id: "architecture",
        adapter: "command",
        model: "model-a",
        isolation: "enforced",
        elapsed_ms: 2000,
        verdict: "pass",
        summary: "No architecture defects.",
        actionable_findings: 0,
        informational_notes: 0,
      },
      "architecture::primary",
    ),
    event(
      "reviewer.skipped",
      6,
      "2026-09-03T10:00:03.100Z",
      {
        lens_id: "architecture",
        mode: "full_review",
        adapter: "command",
        model: "model-b",
        provider_group: "fallback",
        elapsed_ms: 0,
        reason: "not_needed_after_quorum",
        blocked_by_reviewer_id: "architecture::primary",
      },
      "architecture::fallback",
    ),
    event("run.completed", 7, "2026-09-03T10:00:03.200Z", {
      gate_outcome: "passed",
      coverage_outcome: "complete",
      exit_code: 0,
      consistency_mode: "live_worktree",
      total_elapsed_ms: 3200,
      logical_lenses: {
        total: 1,
        pending: 0,
        findings: 0,
        passed: 1,
        incomplete: 0,
        not_applicable: 0,
        not_evaluated: 0,
      },
      model_runs: {
        total: 2,
        deferred: 0,
        queued: 0,
        running: 0,
        completed: 1,
        incomplete: 0,
        skipped: 1,
      },
      status: "passed",
      suite: {
        total: 2,
        deferred: 0,
        queued: 0,
        running: 0,
        completed: 1,
        incomplete: 0,
        skipped: 1,
      },
    }),
  ];
  await writeFile(
    join(runsDirectory, "run-demo.jsonl"),
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
  );
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("dashboard data", () => {
  it("returns safe configuration, run timelines, and reviewer activity", async () => {
    const { appPaths } = await fixture();
    await writeRun(appPaths.runsDirectory);
    const snapshot = await readDashboardSnapshot({
      appPaths,
      server: {
        host: "127.0.0.1",
        port: 1234,
        startedAt: "2026-09-03T09:00:00.000Z",
      },
    });
    expect(snapshot.runs[0]).toMatchObject({
      run_id: "run-demo",
      status: "passed",
      project_name: "demo",
      branch: "feature/dashboard",
      changed_files_count: 3,
    });
    expect(snapshot.agents[0]).toMatchObject({
      id: "architecture",
      purpose: "Review architecture",
      has_instructions: true,
    });
    const encoded = JSON.stringify(snapshot);
    expect(encoded).not.toContain("secret instructions");
    expect(encoded).not.toContain("secret-command");
    expect(encoded).not.toContain("secret-arg");
    expect(encoded).not.toContain("runtime-secret");
    expect(encoded).not.toContain("project-token");

    const run = await readDashboardRun({ appPaths, runId: "run-demo" });
    expect(run).toMatchObject({
      stage: "complete",
      lenses: [
        {
          id: "architecture",
          reviewers: [
            { reviewer_id: "architecture::primary", state: "completed" },
            { reviewer_id: "architecture::fallback", state: "skipped" },
          ],
        },
      ],
    });
    const reviewer = await readDashboardReviewer({
      appPaths,
      runId: "run-demo",
      reviewerId: "architecture::primary",
    });
    expect(reviewer.activity).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: "Inspected the dependency graph." }),
      ]),
    );
    expect(reviewer.activity_notice).toContain("not the provider's full chat");
  });

  it("redacts credential-like strings again at the HTTP data boundary", async () => {
    const { appPaths } = await fixture();
    await writeFile(
      join(appPaths.runsDirectory, "run-secret.jsonl"),
      `${JSON.stringify({
        schema_version: "5",
        event: "reviewer.progress",
        run_id: "run-secret",
        seq: 1,
        timestamp: new Date().toISOString(),
        reviewer_id: "reviewer",
        data: {
          phase: "reviewing",
          message: "Authorization: Bearer should-not-leak",
        },
      })}\n`,
    );
    const run = await readDashboardRun({ appPaths, runId: "run-secret" });
    expect(JSON.stringify(run)).not.toContain("should-not-leak");
    expect(JSON.stringify(run)).toContain("[redacted]");
  });

  it("redacts credential-like strings from top-level run summary fields", async () => {
    const { appPaths } = await fixture();
    await writeFile(
      join(appPaths.runsDirectory, "run-summary-secret.jsonl"),
      `${JSON.stringify({
        schema_version: "5",
        event: "context.resolved",
        run_id: "run-summary-secret",
        seq: 1,
        timestamp: new Date().toISOString(),
        data: {
          workspace: "C:/repo/secret=workspace-token",
          project_name: "secret=project-token",
          review_scope: { mode: "changes" },
          git: {
            is_repository: true,
            branch: "secret=branch-token",
            head: null,
            merge_base: null,
            changed_files_count: 0,
            changed_files: [],
            truncated: false,
          },
        },
      })}\n`,
    );
    const snapshot = await readDashboardSnapshot({
      appPaths,
      server: {
        host: "127.0.0.1",
        port: 1,
        startedAt: new Date().toISOString(),
      },
    });
    expect(JSON.stringify(snapshot)).not.toMatch(
      /workspace-token|project-token|branch-token/u,
    );
  });

  it("redacts credential-like strings in retained reviewer metadata", async () => {
    const { appPaths } = await fixture();
    await writeFile(
      join(appPaths.runsDirectory, "run-roster-secret.jsonl"),
      `${JSON.stringify({
        record: "resolution",
        run_id: "run-roster-secret",
        resolution: {
          reviewers: [
            {
              id: "reviewer-secret=identifier-token",
              agent_id: "lens-secret=lens-token",
              purpose: "secret=purpose-token",
              adapter: "Bearer adapter-token",
              model: "secret=model-token",
            },
          ],
        },
      })}\n`,
    );
    const run = await readDashboardRun({
      appPaths,
      runId: "run-roster-secret",
    });
    expect(JSON.stringify(run)).not.toMatch(
      /identifier-token|lens-token|purpose-token|adapter-token|model-token/u,
    );
  });

  it("keeps legacy v1 findings with conservative metadata defaults", async () => {
    const { appPaths } = await fixture();
    await writeFile(
      join(appPaths.runsDirectory, "run-v1.jsonl"),
      [
        {
          record: "resolution",
          run_id: "run-v1",
          resolution: {
            reviewers: [
              {
                id: "legacy",
                agent_id: "legacy",
                model: "legacy-model",
                adapter: "command",
              },
            ],
          },
        },
        {
          record: "reviewer.result",
          run_id: "run-v1",
          reviewer_id: "legacy",
          result: {
            schema_version: "1",
            verdict: "fail",
            summary: "Legacy finding",
            actionable_findings: [
              {
                id: "legacy-1",
                severity: "high",
                title: "Legacy defect",
                description: "Legacy detail",
                evidence: [{ detail: "Legacy evidence" }],
                suggested_direction: "Fix it",
              },
            ],
            informational_notes: [],
          },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n") + "\n",
    );
    const run = await readDashboardRun({ appPaths, runId: "run-v1" });
    expect(run).toMatchObject({
      findings: {
        raw: [
          {
            title: "Legacy defect",
            confidence: "medium",
            classification: "needs_verification",
          },
        ],
      },
    });
  });

  it("retains source findings rejected by an adjudicator while excluding them from canonical counts", async () => {
    const { appPaths } = await fixture();
    const finding: ReviewerResultV3["actionable_findings"][number] = {
      id: "candidate",
      severity: "high",
      title: "Rejected candidate",
      description: "The first provider reported this.",
      evidence: [{ detail: "Candidate evidence" }],
      suggested_direction: "Fix candidate",
      confidence: "high",
      classification: "confirmed_defect",
      external_assumptions: [],
      category: "correctness",
      verification: "Candidate verification.",
    };
    const candidateResult: ReviewerResultV3 = {
      schema_version: "3" as const,
      verdict: "fail" as const,
      review_markdown: "# Review\n\nCandidate.",
      summary: "Candidate",
      actionable_findings: [finding],
      informational_notes: [],
    };
    const adjudicationResult: AdjudicationResult = {
      schema_version: "1" as const,
      kind: "review-mesh.adjudication-result" as const,
      verdict: "pass" as const,
      review_markdown: "# Adjudication\n\nRejected.",
      summary: "Rejected",
      actionable_findings: [] as [],
      decisions: [
        {
          source_finding_id: "candidate",
          decision: "rejected" as const,
          rationale: "The candidate is not supported by the code.",
          cited_evidence: [
            {
              path: "src/candidate.ts",
              start_line: 1,
              end_line: 1,
              detail: "Contradictory code evidence.",
            },
          ],
          unverified_assumptions: [],
        },
      ],
      informational_notes: [],
    };
    const adjudicationValidation = createAdjudicationValidationAttestation({
      candidateResult,
      adjudicationResult,
      contextHead: "dashboard-head",
      validationContext: {
        reviewScope: "full",
        git: { changedFiles: [], diff: "" },
        evidenceVerification: {
          by_source_finding_id: {
            candidate: { verified: true, failures: [] },
          },
        },
      },
    });
    await writeFile(
      join(appPaths.runsDirectory, "run-adjudicated.jsonl"),
      [
        {
          record: "context",
          run_id: "run-adjudicated",
          context: {
            review_scope: { mode: "full" },
            git: {
              is_repository: true,
              head: "dashboard-head",
              changed_files: [],
              diff: "",
            },
          },
        },
        {
          record: "resolution",
          run_id: "run-adjudicated",
          resolution: {
            reviewers: [
              { id: "lens::source", agent_id: "lens", model_index: 0 },
              {
                id: "lens::judge",
                agent_id: "lens",
                model_index: 1,
                policy: {
                  passQuorum: 1,
                  minimumProviderGroups: 1,
                  adjudication: "required",
                  gateMinimumSeverity: "medium",
                  gateMinimumConfidence: "medium",
                  mode: "adjudication",
                  adjudicatesReviewerId: "lens::source",
                },
              },
            ],
          },
        },
        {
          record: "reviewer.result",
          run_id: "run-adjudicated",
          reviewer_id: "lens::source",
          digest: reviewerResultDigest(candidateResult),
          byte_count: Buffer.byteLength(
            JSON.stringify(candidateResult),
            "utf8",
          ),
          result: candidateResult,
        },
        {
          record: "reviewer.result",
          run_id: "run-adjudicated",
          reviewer_id: "lens::judge",
          mode: "adjudication",
          adjudicates_reviewer_id: "lens::source",
          digest: reviewerResultDigest(adjudicationResult),
          byte_count: Buffer.byteLength(
            JSON.stringify(adjudicationResult),
            "utf8",
          ),
          result: adjudicationResult,
          adjudication_validation: adjudicationValidation,
        },
        {
          schema_version: "5",
          event: "run.completed",
          run_id: "run-adjudicated",
          seq: 1,
          timestamp: new Date().toISOString(),
          data: {
            gate_outcome: "passed",
            coverage_outcome: "complete",
            exit_code: 0,
            consistency_mode: "live_worktree",
            total_elapsed_ms: 1,
            unique_findings: 0,
            status: "passed",
            suite: {
              total: 2,
              deferred: 0,
              queued: 0,
              running: 0,
              completed: 2,
              incomplete: 0,
              skipped: 0,
            },
          },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n") + "\n",
    );
    const run = await readDashboardRun({
      appPaths,
      runId: "run-adjudicated",
    });
    expect(run).toMatchObject({
      status: "passed",
      findings: {
        raw: [expect.objectContaining({ finding_id: "candidate" })],
        consolidated: [],
        counts: { raw: 1, unique: 0, gate: 0, advisory: 0 },
      },
    });
  });

  it("returns the complete verified reviewer result without dashboard truncation", async () => {
    const { appPaths } = await fixture();
    const runId = "run-complete-dashboard-result";
    const reviewMarkdown = `# Complete review\n\n${"Evidence stays exact. ".repeat(6_000)}`;
    const result: ReviewerResultV3 = {
      schema_version: "3",
      verdict: "pass",
      review_markdown: reviewMarkdown,
      summary: "No findings.",
      actionable_findings: [],
      informational_notes: [],
    };
    const digest = reviewerResultDigest(result);
    const byteCount = Buffer.byteLength(JSON.stringify(result), "utf8");
    await writeFile(
      join(appPaths.runsDirectory, `${runId}.jsonl`),
      [
        {
          record: "reviewer.result",
          run_id: runId,
          reviewer_id: "reviewer-1",
          digest,
          byte_count: byteCount,
          result,
        },
        {
          record: "reviewer.terminal",
          run_id: runId,
          terminal: {
            reviewer_id: "reviewer-1",
            status: "completed",
            adapter: "command",
            model: "model",
            isolation: "prompt_only",
            elapsed_ms: 1,
            result_digest: digest,
            result_byte_count: byteCount,
          },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n") + "\n",
    );

    await expect(
      readDashboardReviewer({ appPaths, runId, reviewerId: "reviewer-1" }),
    ).resolves.toMatchObject({
      result,
      result_digest: digest,
      result_byte_count: byteCount,
    });
  });

  it.each([
    {
      name: "missing authoritative result",
      includePrivate: false,
      mismatch: false,
    },
    { name: "mismatched tuple", includePrivate: true, mismatch: true },
  ])(
    "rejects a compact public result reference with $name",
    async ({ includePrivate, mismatch }) => {
      const { appPaths } = await fixture();
      const runId = `run-dashboard-reference-${mismatch ? "mismatch" : "missing"}`;
      const result: ReviewerResultV3 = {
        schema_version: "3",
        verdict: "pass",
        review_markdown: "# Complete review",
        summary: "No findings.",
        actionable_findings: [],
        informational_notes: [],
      };
      const digest = reviewerResultDigest(result);
      const byteCount = Buffer.byteLength(JSON.stringify(result), "utf8");
      await writeFile(
        join(appPaths.runsDirectory, `${runId}.jsonl`),
        [
          ...(includePrivate
            ? [
                {
                  record: "reviewer.result",
                  run_id: runId,
                  reviewer_id: "reviewer-1",
                  digest,
                  byte_count: byteCount,
                  result,
                },
              ]
            : []),
          {
            schema_version: "5",
            event: "reviewer.result",
            run_id: runId,
            seq: 1,
            timestamp: new Date().toISOString(),
            reviewer_id: "reviewer-1",
            data: {
              digest: mismatch ? "0".repeat(64) : digest,
              byte_count: byteCount,
            },
          },
        ]
          .map((record) => JSON.stringify(record))
          .join("\n") + "\n",
      );

      await expect(readDashboardRun({ appPaths, runId })).rejects.toThrow(
        /result reference/i,
      );
    },
  );

  it("downgrades invalid adjudication proof with the same canonical classification and counts as reports", async () => {
    const { appPaths } = await fixture();
    const runId = "run-invalid-proof";
    const candidate: ReviewerResultV3 = {
      schema_version: "3",
      verdict: "fail",
      review_markdown: "# Review\n\nCandidate reliability defect.",
      summary: "Candidate reliability defect.",
      actionable_findings: [
        {
          id: "candidate",
          severity: "high",
          title: "Post-ingest enum throw",
          description: "The candidate says mapping throws after ingest.",
          evidence: [
            {
              path: "src/ingest.ts",
              start_line: 40,
              end_line: 45,
              detail: "Candidate evidence.",
            },
          ],
          suggested_direction: "Prevent the throw.",
          confidence: "high",
          classification: "confirmed_defect",
          external_assumptions: [],
          category: "reliability",
          verification: "Candidate verification.",
          change_impact: "Candidate claims HEAD introduced the throw.",
        },
      ],
      informational_notes: [],
    };
    const adjudicationResult: AdjudicationResult = {
      schema_version: "1" as const,
      kind: "review-mesh.adjudication-result" as const,
      verdict: "fail" as const,
      review_markdown: "# Adjudication\n\nRepeated without proof.",
      summary: "Repeated candidate.",
      actionable_findings: [] as [],
      decisions: [
        {
          source_finding_id: "candidate",
          decision: "confirmed" as const,
          rationale: "Confirmed by prose only.",
          cited_evidence: [{ detail: "No repository location." }],
          unverified_assumptions: [],
        },
      ],
      informational_notes: [],
    };
    const adjudicationValidation = createAdjudicationValidationAttestation({
      candidateResult: candidate,
      adjudicationResult,
      contextHead: "invalid-proof-head",
      validationContext: {
        reviewScope: "changes",
        git: { changedFiles: [], diff: "" },
        evidenceVerification: {
          by_source_finding_id: {
            candidate: { verified: false, failures: ["read_failed"] },
          },
        },
      },
    });
    await writeFile(
      join(appPaths.runsDirectory, `${runId}.jsonl`),
      [
        {
          record: "request",
          run_id: runId,
          request: {
            schema_version: "2",
            project_name: "demo",
            workspace: "C:/demo",
            instructions: "Review changes.",
            review_scope: { mode: "changes" },
          },
        },
        {
          record: "context",
          run_id: runId,
          context: {
            review_scope: { mode: "changes" },
            git: {
              is_repository: true,
              head: "invalid-proof-head",
              changed_files: [],
              diff: "",
            },
          },
        },
        {
          record: "resolution",
          run_id: runId,
          resolution: {
            reviewers: [
              { id: "lens::source", agent_id: "lens" },
              {
                id: "lens::judge",
                agent_id: "lens",
                policy: {
                  passQuorum: 1,
                  minimumProviderGroups: 1,
                  adjudication: "required",
                  gateMinimumSeverity: "medium",
                  gateMinimumConfidence: "medium",
                  mode: "adjudication",
                  adjudicatesReviewerId: "lens::source",
                },
              },
            ],
          },
        },
        {
          record: "reviewer.result",
          run_id: runId,
          reviewer_id: "lens::source",
          digest: reviewerResultDigest(candidate),
          byte_count: Buffer.byteLength(JSON.stringify(candidate), "utf8"),
          result: candidate,
        },
        {
          record: "reviewer.result",
          run_id: runId,
          reviewer_id: "lens::judge",
          mode: "adjudication",
          adjudicates_reviewer_id: "lens::source",
          digest: reviewerResultDigest(adjudicationResult),
          byte_count: Buffer.byteLength(
            JSON.stringify(adjudicationResult),
            "utf8",
          ),
          result: adjudicationResult,
          adjudication_validation: {
            ...adjudicationValidation,
            context_head: "wrong-head",
          },
        },
        {
          schema_version: "5",
          event: "run.completed",
          run_id: runId,
          seq: 1,
          timestamp: new Date().toISOString(),
          data: {
            unique_findings: 0,
            raw_findings: 1,
            gate_findings: 0,
            advisory_findings: 0,
            status: "findings",
            gate_outcome: "findings",
            coverage_outcome: "complete",
          },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n") + "\n",
    );

    const run = await readDashboardRun({ appPaths, runId });
    const snapshot = await readDashboardSnapshot({
      appPaths,
      server: {
        host: "127.0.0.1",
        port: 0,
        startedAt: new Date().toISOString(),
      },
    });

    expect(run).toMatchObject({
      findings: {
        raw: [
          expect.objectContaining({
            finding_id: "candidate",
            classification: "needs_verification",
            adjudication: "needs_verification",
            gate_eligible: false,
          }),
        ],
        consolidated: [
          expect.objectContaining({ classification: "needs_verification" }),
        ],
        counts: { raw: 1, unique: 1, gate: 0, advisory: 1 },
      },
    });
    expect(snapshot.runs[0]).toMatchObject({
      run_id: runId,
      status: "passed",
      gate_outcome: "passed",
      findings: 1,
      unique_findings: 1,
      raw_findings: 1,
      gate_findings: 0,
      advisory_findings: 1,
    });
  });

  it("uses persisted counts when a legacy compact artifact has no full results", async () => {
    const { appPaths } = await fixture();
    const runId = "run-legacy-count-fallback";
    await writeFile(
      join(appPaths.runsDirectory, `${runId}.jsonl`),
      JSON.stringify({
        schema_version: "5",
        event: "run.completed",
        run_id: runId,
        seq: 1,
        timestamp: new Date().toISOString(),
        data: {
          unique_findings: 7,
          raw_findings: 8,
          gate_findings: 3,
          advisory_findings: 5,
          status: "findings",
          gate_outcome: "findings",
          coverage_outcome: "complete",
        },
      }) + "\n",
    );

    const snapshot = await readDashboardSnapshot({
      appPaths,
      server: {
        host: "127.0.0.1",
        port: 0,
        startedAt: new Date().toISOString(),
      },
    });
    expect(snapshot.runs[0]).toMatchObject({
      run_id: runId,
      status: "findings",
      gate_outcome: "findings",
      findings: 7,
      unique_findings: 7,
      raw_findings: 8,
      gate_findings: 3,
      advisory_findings: 5,
    });
  });

  it("uses persisted non-default gate thresholds for dashboard counts", async () => {
    const { appPaths } = await fixture();
    const runId = "run-dashboard-thresholds";
    await writeFile(
      join(appPaths.runsDirectory, `${runId}.jsonl`),
      [
        {
          record: "resolution",
          run_id: runId,
          resolution: {
            reviewers: [
              {
                id: "strict::primary",
                agent_id: "strict",
                policy: {
                  passQuorum: 1,
                  minimumProviderGroups: 1,
                  adjudication: "off",
                  gateMinimumSeverity: "high",
                  gateMinimumConfidence: "high",
                },
              },
            ],
          },
        },
        {
          record: "reviewer.result",
          run_id: runId,
          reviewer_id: "strict::primary",
          result: {
            schema_version: "2",
            verdict: "fail",
            summary: "Medium finding.",
            actionable_findings: [
              {
                id: "medium-only",
                severity: "medium",
                title: "Medium only",
                description: "Below the configured high threshold.",
                evidence: [{ detail: "Evidence." }],
                suggested_direction: "Consider later.",
                confidence: "high",
                classification: "confirmed_defect",
                external_assumptions: [],
              },
            ],
            informational_notes: [],
          },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n") + "\n",
    );

    const run = await readDashboardRun({ appPaths, runId });

    expect(run).toMatchObject({
      findings: {
        counts: { raw: 1, unique: 1, gate: 0, advisory: 1 },
        gate_effective: [],
      },
    });
  });

  it("isolates one malformed run and accepts a partial active tail", async () => {
    const { appPaths } = await fixture();
    await writeFile(join(appPaths.runsDirectory, "broken.jsonl"), "not json\n");
    await writeFile(
      join(
        appPaths.runsDirectory,
        `active.jsonl.active.${process.pid}.${Math.floor(Date.now() - process.uptime() * 1000)}.owner`,
      ),
      `${JSON.stringify({
        schema_version: "5",
        event: "run.started",
        run_id: "active",
        seq: 1,
        timestamp: new Date().toISOString(),
        data: { consistency_mode: "live_worktree" },
      })}\n{"unfinished"`,
    );
    const snapshot = await readDashboardSnapshot({
      appPaths,
      server: {
        host: "127.0.0.1",
        port: 1,
        startedAt: new Date().toISOString(),
      },
    });
    expect(snapshot.runs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ run_id: "broken", unreadable: true }),
        expect.objectContaining({
          run_id: "active",
          active: true,
          status: "running",
        }),
      ]),
    );
    expect(await readFile(appPaths.configFile, "utf8")).toContain(
      "secret instructions",
    );
  });

  it("reads a stable active dashboard prefix while the file grows after open", async () => {
    const { appPaths } = await fixture();
    const runId = "dashboard-active-growth";
    const path = join(
      appPaths.runsDirectory,
      `${runId}.jsonl.active.${process.pid}.${Math.floor(Date.now() - process.uptime() * 1000)}.owner`,
    );
    await writeFile(
      path,
      `${JSON.stringify({ record: "resolution", run_id: runId, resolution: { reviewers: [] } })}\n`,
    );

    await expect(
      readDashboardRun({
        appPaths,
        runId,
        afterOpen: async () => {
          await appendFile(
            path,
            `${JSON.stringify({ record: "context", run_id: runId, context: {} })}\n`,
          );
        },
      }),
    ).resolves.toMatchObject({ run_id: runId });
  });

  it("rejects an active dashboard path replacement after open", async () => {
    const { appPaths } = await fixture();
    const runId = "dashboard-active-replaced";
    const path = join(
      appPaths.runsDirectory,
      `${runId}.jsonl.active.${process.pid}.${Math.floor(Date.now() - process.uptime() * 1000)}.owner`,
    );
    await writeFile(
      path,
      `${JSON.stringify({ record: "resolution", run_id: runId, resolution: { reviewers: [] } })}\n`,
    );

    await expect(
      readDashboardRun({
        appPaths,
        runId,
        afterOpen: async () => {
          await rename(path, `${path}.moved`);
          await writeFile(
            path,
            `${JSON.stringify({ record: "resolution", run_id: runId, resolution: { reviewers: [] } })}\nreplacement`,
          );
        },
      }),
    ).rejects.toThrow(/identity changed/i);
  });

  it("marks an orphaned active record stale instead of live", async () => {
    const { appPaths } = await fixture();
    await writeFile(
      join(
        appPaths.runsDirectory,
        "orphan.jsonl.active.99999999.1.orphan-owner",
      ),
      `${JSON.stringify({
        schema_version: "5",
        event: "run.started",
        run_id: "orphan",
        seq: 1,
        timestamp: new Date().toISOString(),
        data: { consistency_mode: "live_worktree" },
      })}\n`,
    );
    const snapshot = await readDashboardSnapshot({
      appPaths,
      server: {
        host: "127.0.0.1",
        port: 1,
        startedAt: new Date().toISOString(),
      },
    });
    expect(snapshot.runs[0]).toMatchObject({
      run_id: "orphan",
      active: false,
      stale: true,
      status: "stale",
    });
    expect(snapshot.counts.active_runs).toBe(0);
  });

  it("reports an oversized newest snapshot candidate explicitly and still loads the next run", async () => {
    const { appPaths } = await fixture();
    await writeFile(
      join(appPaths.runsDirectory, "older.jsonl"),
      `${JSON.stringify({ record: "resolution", run_id: "older", resolution: { reviewers: [] } })}\n`,
    );
    await writeFile(
      join(appPaths.runsDirectory, "newer.jsonl"),
      `${JSON.stringify({ record: "resolution", run_id: "newer", resolution: { reviewers: [] }, padding: "x".repeat(2_000) })}\n`,
    );

    const snapshot = await readDashboardSnapshot({
      appPaths,
      maximumTotalBytes: 1_000,
      server: {
        host: "127.0.0.1",
        port: 1,
        startedAt: new Date().toISOString(),
      },
    });

    expect(snapshot.runs[0]).toMatchObject({
      run_id: "newer",
      unreadable: true,
    });
    expect(
      snapshot.runs.find((run) => run.run_id === "older")?.unreadable,
    ).toBeUndefined();
  });
});
