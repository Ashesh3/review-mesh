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
  consolidateFindings,
  persistedReviewerResultRecordType,
  readRunFindings,
  readRunReport,
  renderRunReportJson,
  renderRunReportMarkdown,
  RunReportError,
  type RawRunFinding,
} from "../../src/diagnostics/run-report.js";
import type { ReviewerResultV3 } from "../../src/protocol/schemas.js";
import { reviewerResultDigest } from "../../src/results/digest.js";
import { createAdjudicationValidationAttestation } from "../../src/findings/attestation.js";

const temporaryRoots: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "review-mesh-report-"));
  temporaryRoots.push(root);
  const runsDirectory = join(root, "runs");
  await mkdir(runsDirectory, { recursive: true });
  return { root, runsDirectory };
}

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function legacyResult(
  findings: unknown[],
  summary = findings.length === 0 ? "No findings." : "Findings were found.",
) {
  return {
    schema_version: "1",
    verdict: findings.length === 0 ? "pass" : "fail",
    summary,
    actionable_findings: findings,
    informational_notes: [],
  };
}

function resultV2(
  findings: unknown[],
  summary = findings.length === 0 ? "No findings." : "Findings were found.",
) {
  return {
    schema_version: "2",
    verdict: findings.length === 0 ? "pass" : "fail",
    summary,
    actionable_findings: findings,
    informational_notes: [],
  };
}

function resultV3(reviewMarkdown: string): ReviewerResultV3 {
  return {
    schema_version: "3",
    verdict: "pass",
    review_markdown: reviewMarkdown,
    summary: "No findings.",
    actionable_findings: [],
    informational_notes: [],
  };
}

function persistedResultV3(
  runId: string,
  result: ReviewerResultV3,
  overrides: Record<string, unknown> = {},
) {
  return {
    record: persistedReviewerResultRecordType,
    run_id: runId,
    reviewer_id: "security",
    digest: reviewerResultDigest(result),
    byte_count: Buffer.byteLength(JSON.stringify(result), "utf8"),
    result,
    ...overrides,
  };
}

function legacyFinding(overrides: Record<string, unknown> = {}) {
  return {
    id: "mapping-failure",
    severity: "high",
    title: "Mapping failure blocks the batch",
    description: "The primary batch aborts when one mapping fails.",
    evidence: [
      {
        path: "src/processor.ts",
        start_line: 41,
        end_line: 44,
        detail: "The exception escapes the mapping loop.",
      },
    ],
    suggested_direction: "Isolate mapping failures and continue safe work.",
    ...overrides,
  };
}

function findingV2(overrides: Record<string, unknown> = {}) {
  return {
    ...legacyFinding(),
    confidence: "high",
    classification: "confirmed_defect",
    external_assumptions: [],
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("readRunReport", () => {
  function currentIntegrityFixture(runId: string) {
    const result = resultV3("# Complete review\n\nOne confirmed defect.");
    result.verdict = "fail";
    result.summary = "One confirmed defect.";
    result.actionable_findings = [
      {
        ...findingV2({ id: "confirmed" }),
        severity: "high" as const,
        confidence: "high" as const,
        classification: "confirmed_defect" as const,
        category: "correctness",
        verification: "The evidence directly confirms the defect.",
      },
    ];
    const digest = reviewerResultDigest(result);
    const byteCount = Buffer.byteLength(JSON.stringify(result), "utf8");
    const completion = {
      schema_version: "5",
      event: "run.completed",
      run_id: runId,
      seq: 1,
      timestamp: "2026-09-04T00:00:00.000Z",
      data: {
        gate_outcome: "findings",
        coverage_outcome: "complete",
        exit_code: 1,
        consistency_mode: "live_worktree",
        total_elapsed_ms: 1,
        raw_findings: 1,
        unique_findings: 1,
        gate_findings: 1,
        advisory_findings: 0,
        result_manifest: [
          {
            reviewer_id: "security",
            lens_id: "security",
            digest,
            byte_count: byteCount,
          },
        ],
        results_complete: true,
        status: "findings",
        model_runs: {
          total: 1,
          deferred: 0,
          queued: 0,
          running: 0,
          completed: 1,
          incomplete: 0,
          skipped: 0,
        },
        suite: {
          total: 1,
          deferred: 0,
          queued: 0,
          running: 0,
          completed: 1,
          incomplete: 0,
          skipped: 0,
        },
      },
    };
    return { result, digest, byteCount, completion };
  }

  it("accepts a current completion whose manifest and canonical counts match verified results", async () => {
    const { runsDirectory } = await fixture();
    const runId = "run-valid-integrity";
    const { result, completion } = currentIntegrityFixture(runId);
    await writeFile(
      join(runsDirectory, `${runId}.jsonl`),
      [line(persistedResultV3(runId, result)), line(completion)].join(""),
    );

    await expect(
      readRunReport({ runsDirectory, runId }),
    ).resolves.toMatchObject({
      finding_counts: { raw: 1, unique: 1, gate: 1, advisory: 0 },
    });
  });

  it.each([
    ["missing reviewer", (data: any) => (data.result_manifest = [])],
    [
      "duplicate reviewer",
      (data: any) => data.result_manifest.push({ ...data.result_manifest[0] }),
    ],
    [
      "unknown reviewer",
      (data: any) => (data.result_manifest[0].reviewer_id = "unknown"),
    ],
    [
      "wrong digest",
      (data: any) => (data.result_manifest[0].digest = "0".repeat(64)),
    ],
    [
      "wrong byte count",
      (data: any) => (data.result_manifest[0].byte_count += 1),
    ],
    ["wrong lens", (data: any) => (data.result_manifest[0].lens_id = "wrong")],
    ["missing lens", (data: any) => delete data.result_manifest[0].lens_id],
    [
      "wrong artifact path",
      (data: any) =>
        (data.result_manifest[0].artifact_path = "C:\\wrong.jsonl"),
    ],
    [
      "missing required artifact path",
      (data: any) => {
        data.report_path = "C:\\run.jsonl";
        delete data.result_manifest[0].artifact_path;
      },
    ],
    ["false completeness", (data: any) => (data.results_complete = false)],
    [
      "true completeness for partial coverage",
      (data: any) => (data.coverage_outcome = "partial"),
    ],
    ["missing manifest", (data: any) => delete data.result_manifest],
    ["missing completeness", (data: any) => delete data.results_complete],
    ["wrong raw count", (data: any) => (data.raw_findings = 2)],
    ["wrong unique count", (data: any) => (data.unique_findings = 2)],
    ["wrong gate count", (data: any) => (data.gate_findings = 0)],
    ["wrong advisory count", (data: any) => (data.advisory_findings = 1)],
    ["incomplete count tuple", (data: any) => delete data.raw_findings],
  ])(
    "rejects current completion integrity corruption: %s",
    async (_name, mutate) => {
      const { runsDirectory } = await fixture();
      const runId = `run-corrupt-${String(_name).replaceAll(" ", "-")}`;
      const { result, completion } = currentIntegrityFixture(runId);
      mutate(completion.data);
      await writeFile(
        join(runsDirectory, `${runId}.jsonl`),
        [line(persistedResultV3(runId, result)), line(completion)].join(""),
      );

      await expect(
        readRunReport({ runsDirectory, runId }),
      ).rejects.toMatchObject({
        code: "invalid_run_record",
        recordType: "run.completed",
      });
    },
  );

  it("salvages current completion integrity corruption only in best-effort mode", async () => {
    const { runsDirectory } = await fixture();
    const runId = "run-best-effort-integrity";
    const { result, completion } = currentIntegrityFixture(runId);
    completion.data.gate_findings = 0;
    await writeFile(
      join(runsDirectory, `${runId}.jsonl`),
      [line(persistedResultV3(runId, result)), line(completion)].join(""),
    );

    const report = await readRunReport({
      runsDirectory,
      runId,
      bestEffort: true,
    });
    expect(report.finding_counts.gate).toBe(1);
    expect(report.coverage_outcome).toBe("partial");
    expect(report.record_warnings).toEqual([
      expect.objectContaining({ record_type: "run.completed" }),
    ]);
  });

  it("rejects a duplicate current completion contract at its actual JSONL line", async () => {
    const { runsDirectory } = await fixture();
    const runId = "run-duplicate-completion";
    const { result, completion } = currentIntegrityFixture(runId);
    const duplicate = structuredClone(completion);
    duplicate.seq = 2;
    await writeFile(
      join(runsDirectory, `${runId}.jsonl`),
      [
        line(persistedResultV3(runId, result)),
        line(completion),
        line(duplicate),
      ].join(""),
    );

    await expect(readRunReport({ runsDirectory, runId })).rejects.toMatchObject(
      {
        code: "invalid_run_record",
        line: 3,
        recordType: "run.completed",
      },
    );
  });

  it("reports an invalid private summary contract at its actual JSONL line", async () => {
    const { runsDirectory } = await fixture();
    const runId = "run-private-summary-integrity";
    const { result, completion } = currentIntegrityFixture(runId);
    await writeFile(
      join(runsDirectory, `${runId}.jsonl`),
      [
        line(persistedResultV3(runId, result)),
        line({
          record: "run.summary",
          run_id: runId,
          summary: { ...completion.data, gate_findings: 0 },
        }),
      ].join(""),
    );

    await expect(readRunReport({ runsDirectory, runId })).rejects.toMatchObject(
      {
        code: "invalid_run_record",
        line: 2,
        recordType: "run.summary",
      },
    );
  });

  it("allows a legacy summary before the single current completion contract", async () => {
    const { runsDirectory } = await fixture();
    const runId = "run-legacy-then-current-summary";
    const { result, completion } = currentIntegrityFixture(runId);
    completion.seq = 2;
    await writeFile(
      join(runsDirectory, `${runId}.jsonl`),
      [
        line(persistedResultV3(runId, result)),
        line({
          record: "run.summary",
          run_id: runId,
          summary: { gate_outcome: "findings", coverage_outcome: "complete" },
        }),
        line(completion),
      ].join(""),
    );

    await expect(
      readRunReport({ runsDirectory, runId }),
    ).resolves.toMatchObject({
      finding_counts: { raw: 1, unique: 1, gate: 1, advisory: 0 },
    });
  });

  it("reads a v7.2 completion with only legacy unique and advisory counts", async () => {
    const { runsDirectory } = await fixture();
    const runId = "run-v72-legacy-counts";
    await writeFile(
      join(runsDirectory, `${runId}.jsonl`),
      line({
        schema_version: "5",
        event: "run.completed",
        run_id: runId,
        seq: 1,
        timestamp: "2026-09-03T00:00:00.000Z",
        data: {
          gate_outcome: "no_findings",
          coverage_outcome: "complete",
          exit_code: 0,
          consistency_mode: "live_worktree",
          total_elapsed_ms: 1,
          unique_findings: 0,
          advisory_findings: 0,
          status: "passed",
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
      }),
    );
    await expect(
      readRunReport({ runsDirectory, runId }),
    ).resolves.toMatchObject({
      status: "passed",
      finding_counts: { raw: 0, unique: 0, gate: 0, advisory: 0 },
    });
  });

  it("joins a compact mirrored public result reference to the authoritative private result", async () => {
    const { runsDirectory } = await fixture();
    const runId = "run-public-reference";
    const result = resultV3(
      `# Complete review\n\n${"Evidence. ".repeat(2_000)}`,
    );
    const digest = reviewerResultDigest(result);
    const byteCount = Buffer.byteLength(JSON.stringify(result), "utf8");
    await writeFile(
      join(runsDirectory, `${runId}.jsonl`),
      [
        line(persistedResultV3(runId, result)),
        line({
          schema_version: "5",
          event: "reviewer.result",
          run_id: runId,
          seq: 1,
          timestamp: "2026-09-04T00:00:00.000Z",
          reviewer_id: "security",
          data: { digest, byte_count: byteCount },
        }),
      ].join(""),
    );

    await expect(
      readRunReport({ runsDirectory, runId }),
    ).resolves.toMatchObject({
      reviewers: [{ reviewer_id: "security", result }],
    });
  });

  it.each([
    {
      name: "missing private result",
      includePrivate: false,
      digest: "a".repeat(64),
    },
    { name: "mismatched tuple", includePrivate: true, digest: "0".repeat(64) },
  ])(
    "rejects a compact public result reference with $name",
    async ({ includePrivate, digest }) => {
      const { runsDirectory } = await fixture();
      const runId = "run-invalid-public-reference";
      const result = resultV3("# Complete review");
      const byteCount = Buffer.byteLength(JSON.stringify(result), "utf8");
      await writeFile(
        join(runsDirectory, `${runId}.jsonl`),
        [
          ...(includePrivate ? [line(persistedResultV3(runId, result))] : []),
          line({
            schema_version: "5",
            event: "reviewer.result",
            run_id: runId,
            seq: 1,
            timestamp: "2026-09-04T00:00:00.000Z",
            reviewer_id: "security",
            data: { digest, byte_count: byteCount },
          }),
        ].join(""),
      );

      await expect(
        readRunReport({ runsDirectory, runId }),
      ).rejects.toMatchObject({
        code: "invalid_run_record",
        recordType: "reviewer.result",
      });
    },
  );

  it("keeps the authoritative full result when a later terminal contains a truncated copy", async () => {
    const { runsDirectory } = await fixture();
    const runId = "run-authoritative-result";
    const full = resultV3(`# Full review\n\n${"Evidence. ".repeat(2_000)}`);
    const truncated = resultV3("# Full review\n\nEvidence. [truncated]");
    await writeFile(
      join(runsDirectory, `${runId}.jsonl`),
      [
        line(persistedResultV3(runId, full)),
        line({
          record: "reviewer.terminal",
          run_id: runId,
          terminal: {
            reviewer_id: "security",
            status: "completed",
            adapter: "gateway",
            model: "model",
            isolation: "runtime_read_only",
            elapsed_ms: 1,
            result: truncated,
          },
        }),
      ].join(""),
    );

    const report = await readRunReport({ runsDirectory, runId });
    expect(report.reviewers[0]?.result).toEqual(full);
  });

  it("renders every complete reviewer review in Markdown", async () => {
    const { runsDirectory } = await fixture();
    const runId = "run-markdown-full-review";
    const reviewMarkdown = "# Reviewer review\n\nExact complete evidence.";
    const result = resultV3(reviewMarkdown);
    await writeFile(
      join(runsDirectory, `${runId}.jsonl`),
      line(persistedResultV3(runId, result)),
    );

    const report = await readRunReport({ runsDirectory, runId });
    expect(renderRunReportMarkdown(report)).toContain(reviewMarkdown);
  });

  it.each([
    {
      name: "missing digest",
      override: { digest: undefined },
      schemaPath: "digest",
    },
    {
      name: "wrong digest",
      override: { digest: "0".repeat(64) },
      schemaPath: "digest",
    },
    {
      name: "wrong byte count",
      override: { byte_count: 1 },
      schemaPath: "byte_count",
    },
  ])(
    "rejects a v3 result record with $name",
    async ({ override, schemaPath }) => {
      const { runsDirectory } = await fixture();
      const runId = "run-invalid-integrity";
      const result = resultV3("# Complete review");
      await writeFile(
        join(runsDirectory, `${runId}.jsonl`),
        line(persistedResultV3(runId, result, override)),
      );

      await expect(
        readRunReport({ runsDirectory, runId }),
      ).rejects.toMatchObject({
        code: "invalid_run_record",
        line: 1,
        recordType: persistedReviewerResultRecordType,
        schemaPaths: [schemaPath],
      });
    },
  );

  it("separates logical-lens coverage from model executions for a current v4 record", async () => {
    const { runsDirectory } = await fixture();
    const runId = "run-current-v4";
    const finding = legacyFinding();
    const failedResult = legacyResult([finding]);
    const cleanResult = legacyResult([], "Deployment parity is clear.");
    const financialTerminal = {
      reviewer_id: "financial::opus",
      status: "completed",
      adapter: "gateway",
      model: "opus",
      isolation: "runtime_read_only",
      elapsed_ms: 100,
      result: failedResult,
    };
    const deploymentTerminal = {
      reviewer_id: "deployment::opus",
      status: "completed",
      adapter: "gateway",
      model: "opus",
      isolation: "runtime_read_only",
      elapsed_ms: 90,
      result: cleanResult,
    };
    const securityTerminal = {
      reviewer_id: "security::opus",
      status: "incomplete",
      adapter: "gateway",
      model: "opus",
      elapsed_ms: 120,
      reason: "protocol_violation",
      message: "Invalid chat response.",
      retryable: false,
    };
    const financialSkip = {
      reviewer_id: "financial::gpt",
      status: "skipped",
      adapter: "gateway",
      model: "gpt",
      elapsed_ms: 0,
      reason: "prior_findings",
      blocked_by_reviewer_id: "financial::opus",
    };
    const securitySkip = {
      reviewer_id: "security::gpt",
      status: "skipped",
      adapter: "gateway",
      model: "gpt",
      elapsed_ms: 0,
      reason: "prior_incomplete",
      blocked_by_reviewer_id: "security::opus",
    };
    await writeFile(
      join(runsDirectory, `${runId}.jsonl`),
      [
        line({
          record: "resolution",
          run_id: runId,
          resolution: {
            reviewers: [
              { id: "financial::opus", agent_id: "financial" },
              { id: "financial::gpt", agent_id: "financial" },
              { id: "deployment::opus", agent_id: "deployment" },
              { id: "security::opus", agent_id: "security" },
              { id: "security::gpt", agent_id: "security" },
            ],
          },
        }),
        line({
          schema_version: "4",
          event: "reviewer.completed",
          run_id: runId,
          seq: 1,
          timestamp: "2026-09-03T00:00:01.000Z",
          reviewer_id: "financial::opus",
          data: {
            adapter: "gateway",
            model: "opus",
            isolation: "runtime_read_only",
            elapsed_ms: 100,
            result: failedResult,
          },
        }),
        line({
          schema_version: "4",
          event: "reviewer.completed",
          run_id: runId,
          seq: 2,
          timestamp: "2026-09-03T00:00:02.000Z",
          reviewer_id: "deployment::opus",
          data: {
            adapter: "gateway",
            model: "opus",
            isolation: "runtime_read_only",
            elapsed_ms: 90,
            result: cleanResult,
          },
        }),
        line({
          schema_version: "4",
          event: "reviewer.incomplete",
          run_id: runId,
          seq: 3,
          timestamp: "2026-09-03T00:00:03.000Z",
          reviewer_id: "security::opus",
          data: {
            adapter: "gateway",
            model: "opus",
            elapsed_ms: 120,
            reason: "protocol_violation",
            message: "Invalid chat response.",
            retryable: false,
          },
        }),
        line({
          schema_version: "4",
          event: "run.completed",
          run_id: runId,
          seq: 4,
          timestamp: "2026-09-03T00:00:04.000Z",
          data: {
            status: "incomplete",
            exit_code: 3,
            consistency_mode: "live_worktree",
            total_elapsed_ms: 125,
            suite: {
              total: 5,
              deferred: 0,
              queued: 0,
              running: 0,
              completed: 2,
              incomplete: 1,
              skipped: 2,
            },
            reviewers: [
              financialTerminal,
              financialSkip,
              deploymentTerminal,
              securityTerminal,
              securitySkip,
            ],
          },
        }),
      ].join(""),
    );

    const report = await readRunReport({ runsDirectory, runId });

    expect(report).toMatchObject({
      active: false,
      status: "incomplete",
      gate_outcome: "passed",
      coverage_outcome: "partial",
      exit_code: 3,
      logical_lenses: {
        total: 3,
        findings: 1,
        passed: 1,
        incomplete: 1,
      },
      model_runs: { total: 5, completed: 2, incomplete: 1, skipped: 2 },
      incomplete_lenses: ["security"],
    });
    expect(report.raw_findings).toEqual([
      expect.objectContaining({
        reviewer_id: "financial::opus",
        lens_id: "financial",
        confidence: "medium",
        classification: "needs_verification",
        external_assumptions: [],
      }),
    ]);
    expect(report.findings).toHaveLength(1);
    expect(report.finding_counts).toEqual({
      raw: 1,
      unique: 1,
      gate: 0,
      advisory: 1,
    });
    expect(JSON.stringify(report.raw_findings)).not.toContain(
      "Deployment parity is clear",
    );
  });

  it("reads future private result records and honors a compact authoritative summary", async () => {
    const { runsDirectory } = await fixture();
    const runId = "run-private";
    await writeFile(
      join(runsDirectory, `${runId}.jsonl`),
      [
        line({
          record: "resolution",
          run_id: runId,
          resolution: {
            reviewers: [
              { id: "contract::one", agent_id: "contract" },
              { id: "contract::two", agent_id: "contract" },
            ],
          },
        }),
        line({
          record: persistedReviewerResultRecordType,
          run_id: runId,
          reviewer_id: "contract::one",
          agent_id: "contract",
          result: resultV2([
            findingV2({
              id: "contract-one",
              severity: "medium",
              root_issue_id: "published-nullability",
            }),
          ]),
        }),
        line({
          record: persistedReviewerResultRecordType,
          run_id: runId,
          reviewer_id: "contract::two",
          agent_id: "contract",
          result: resultV2([
            findingV2({
              id: "contract-two",
              severity: "critical",
              root_issue_id: "published-nullability",
              confidence: "medium",
              external_assumptions: ["Consumer schema is unchanged."],
              evidence: [
                {
                  path: "src/contract.ts",
                  start_line: 10,
                  end_line: 12,
                  detail: "The published field became nullable.",
                },
              ],
            }),
          ]),
        }),
        line({
          schema_version: "5",
          event: "run.completed",
          run_id: runId,
          seq: 1,
          timestamp: "2026-09-03T00:00:03.000Z",
          data: {
            gate_outcome: "findings",
            coverage_outcome: "complete",
            exit_code: 1,
            consistency_mode: "live_worktree",
            total_elapsed_ms: 200,
            report_path: "C:/reports/run-private.json",
            logical_lenses: {
              total: 1,
              pending: 0,
              findings: 1,
              passed: 0,
              incomplete: 0,
              not_applicable: 0,
              not_evaluated: 0,
            },
            model_runs: {
              total: 2,
              deferred: 0,
              queued: 0,
              running: 0,
              completed: 2,
              incomplete: 0,
              skipped: 0,
            },
            suite: {
              total: 2,
              deferred: 0,
              queued: 0,
              running: 0,
              completed: 2,
              incomplete: 0,
              skipped: 0,
            },
            incomplete_lenses: [],
          },
        }),
      ].join(""),
    );

    const report = await readRunReport({ runsDirectory, runId });

    expect(report).toMatchObject({
      status: "findings",
      gate_outcome: "findings",
      coverage_outcome: "complete",
      report_path: "C:/reports/run-private.json",
      logical_lenses: { total: 1, findings: 1, incomplete: 0 },
      model_runs: { total: 2, completed: 2, incomplete: 0, skipped: 0 },
    });
    expect(report.findings).toEqual([
      expect.objectContaining({
        id: "contract-two",
        severity: "critical",
        confidence: "medium",
        classification: "confirmed_defect",
        external_assumptions: ["Consumer schema is unchanged."],
        source_findings: [
          { reviewer_id: "contract::one", finding_id: "contract-one" },
          { reviewer_id: "contract::two", finding_id: "contract-two" },
        ],
        duplicate_finding_ids: ["contract-one"],
        evidence: [
          expect.objectContaining({ path: "src/contract.ts" }),
          expect.objectContaining({ path: "src/processor.ts" }),
        ],
      }),
    ]);
    expect(report.finding_counts).toEqual({
      raw: 2,
      unique: 1,
      gate: 1,
      advisory: 0,
    });
  });

  it("accepts a partial final line only for an active record", async () => {
    const { runsDirectory } = await fixture();
    const activeRunId = "run-active";
    const contents = [
      line({
        record: "resolution",
        run_id: activeRunId,
        resolution: {
          reviewers: [{ id: "security::primary", agent_id: "security" }],
        },
      }),
      line({
        schema_version: "4",
        event: "reviewer.incomplete",
        run_id: activeRunId,
        seq: 1,
        timestamp: "2026-09-03T00:00:01.000Z",
        reviewer_id: "security::primary",
        data: {
          adapter: "gateway",
          model: "model",
          elapsed_ms: 1,
          reason: "timeout",
          message: "Timed out.",
          retryable: true,
        },
      }),
      '{"schema_version":"4","event":"reviewer.progress"',
    ].join("");
    await writeFile(
      join(runsDirectory, `${activeRunId}.jsonl.active.12.1.owner`),
      contents,
    );
    await expect(
      readRunReport({ runsDirectory, runId: activeRunId }),
    ).resolves.toMatchObject({
      active: true,
      status: "running",
      incomplete_lenses: ["security"],
    });

    const finalRunId = "run-final-invalid";
    await writeFile(
      join(runsDirectory, `${finalRunId}.jsonl`),
      contents.replaceAll(activeRunId, finalRunId),
    );
    await expect(
      readRunReport({ runsDirectory, runId: finalRunId }),
    ).rejects.toMatchObject({
      code: "invalid_run_record",
    });
  });

  it("reads a stable active prefix while the report file grows after open", async () => {
    const { runsDirectory } = await fixture();
    const runId = "run-report-active-growth";
    const path = join(runsDirectory, `${runId}.jsonl.active.12.1.owner`);
    await writeFile(
      path,
      line({
        record: "resolution",
        run_id: runId,
        resolution: { reviewers: [] },
      }),
    );

    await expect(
      readRunReport({
        runsDirectory,
        runId,
        afterOpen: async () => {
          await appendFile(
            path,
            line({ record: "context", run_id: runId, context: {} }),
          );
        },
      }),
    ).resolves.toMatchObject({ active: true });
  });

  it("rejects an active report path replacement after open", async () => {
    const { runsDirectory } = await fixture();
    const runId = "run-report-active-replaced";
    const path = join(runsDirectory, `${runId}.jsonl.active.12.1.owner`);
    await writeFile(
      path,
      line({
        record: "resolution",
        run_id: runId,
        resolution: { reviewers: [] },
      }),
    );

    await expect(
      readRunReport({
        runsDirectory,
        runId,
        afterOpen: async () => {
          await rename(path, `${path}.moved`);
          await writeFile(
            path,
            `${line({ record: "resolution", run_id: runId, resolution: { reviewers: [] } })}replacement`,
          );
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_run_record" });
  });

  it("reports the JSONL line, record type, and bounded schema paths", async () => {
    const { runsDirectory } = await fixture();
    const runId = "run-invalid-details";
    await writeFile(
      join(runsDirectory, `${runId}.jsonl`),
      [
        line({ record: "context", run_id: runId, context: {} }),
        line({
          record: "reviewer.attempt",
          run_id: runId,
          reviewer_id: "security",
          attempt: 0,
          startedAt: "2026-09-03T00:00:00.000Z",
          elapsedMs: 1,
          failure: {
            reason: "timeout",
            message: "Timed out.",
            retryable: true,
          },
        }),
      ].join(""),
    );

    await expect(readRunReport({ runsDirectory, runId })).rejects.toMatchObject(
      {
        code: "invalid_run_record",
        line: 2,
        recordType: "reviewer.attempt",
        schemaPaths: expect.arrayContaining([
          expect.stringContaining("attempt"),
        ]),
        message: expect.stringContaining("JSONL line 2 (reviewer.attempt)"),
      },
    );
  });

  it("salvages validated findings only when best effort is explicit", async () => {
    const { runsDirectory } = await fixture();
    const runId = "run-best-effort";
    await writeFile(
      join(runsDirectory, `${runId}.jsonl`),
      [
        line({
          record: "resolution",
          run_id: runId,
          resolution: {
            reviewers: [{ id: "security", agent_id: "security" }],
          },
        }),
        line({
          record: persistedReviewerResultRecordType,
          run_id: runId,
          reviewer_id: "security",
          result: resultV2([findingV2()]),
        }),
        line({
          record: "future.private-record",
          run_id: runId,
          payload: { ignored: true },
        }),
        line({
          record: "run.summary",
          run_id: runId,
          summary: {
            gate_outcome: "findings",
            coverage_outcome: "complete",
            exit_code: 1,
          },
        }),
      ].join(""),
    );

    await expect(readRunReport({ runsDirectory, runId })).rejects.toMatchObject(
      {
        code: "invalid_run_record",
        line: 3,
        recordType: "future.private-record",
      },
    );
    await expect(
      readRunReport({ runsDirectory, runId, bestEffort: true }),
    ).resolves.toMatchObject({
      status: "incomplete",
      gate_outcome: "findings",
      coverage_outcome: "partial",
      findings: [expect.objectContaining({ id: "mapping-failure" })],
      record_warnings: [
        expect.objectContaining({
          line: 3,
          record_type: "future.private-record",
        }),
      ],
    });
  });

  it("accepts v6 private resolution metadata and ignores future nested fields", async () => {
    const { runsDirectory } = await fixture();
    const runId = "run-v61-compatibility";
    await writeFile(
      join(runsDirectory, `${runId}.jsonl`),
      [
        line({
          record: "resolution",
          run_id: runId,
          resolution: {
            execution: {
              max_concurrency: 2,
              heartbeat_interval_ms: 15_000,
              shutdown_grace_period_ms: 5_000,
              distribute_primaries: true,
              future_scheduler_policy: "rotate",
            },
            reviewers: [
              {
                id: "security::primary",
                agent_id: "security",
                model_index: 0,
                configured_model_index: 1,
                model_count: 2,
              },
            ],
            future_resolution_field: true,
          },
          producer_version: "6.1.0",
        }),
        line({
          record: persistedReviewerResultRecordType,
          run_id: runId,
          reviewer_id: "security::primary",
          result: resultV2([]),
          producer_version: "6.1.0",
        }),
        line({
          record: "run.summary",
          run_id: runId,
          summary: {
            gate_outcome: "no_findings",
            coverage_outcome: "complete",
            model_runs: { total: 1, completed: 1, incomplete: 0, skipped: 0 },
            future_summary_field: "retained by producer",
          },
        }),
      ].join(""),
    );

    await expect(
      readRunReport({ runsDirectory, runId }),
    ).resolves.toMatchObject({
      status: "passed",
      coverage_outcome: "complete",
      model_runs: { total: 1, completed: 1 },
    });
  });

  it("bounds best-effort warning output while continuing artifact salvage", async () => {
    const { runsDirectory } = await fixture();
    const runId = "run-bounded-warnings";
    const invalidRecords = Array.from({ length: 150 }, (_, index) =>
      line({
        record: `future.record.${index}`,
        run_id: runId,
      }),
    );
    await writeFile(
      join(runsDirectory, `${runId}.jsonl`),
      [
        line({
          record: persistedReviewerResultRecordType,
          run_id: runId,
          reviewer_id: "security",
          result: resultV2([findingV2()]),
        }),
        ...invalidRecords,
      ].join(""),
    );

    const report = await readRunReport({
      runsDirectory,
      runId,
      bestEffort: true,
    });

    expect(report.findings).toHaveLength(1);
    expect(report.record_warnings).toHaveLength(100);
    expect(report.omitted_record_warnings).toBe(50);
    expect(renderRunReportMarkdown(report)).toContain(
      "50 additional incompatible records were omitted",
    );
  });

  it("rejects unsafe ids and mismatched records", async () => {
    const { runsDirectory } = await fixture();
    await expect(
      readRunReport({ runsDirectory, runId: "../outside" }),
    ).rejects.toMatchObject({ code: "invalid_run_id" });
    await writeFile(
      join(runsDirectory, "run-safe.jsonl"),
      line({
        schema_version: "4",
        event: "run.started",
        run_id: "different-run",
        seq: 1,
        timestamp: "2026-09-03T00:00:00.000Z",
        data: { consistency_mode: "live_worktree" },
      }),
    );
    await expect(
      readRunReport({ runsDirectory, runId: "run-safe" }),
    ).rejects.toMatchObject({ code: "invalid_run_record" });
  });

  it.each([
    {
      name: "resolution",
      record: (runId: string) => ({
        record: "resolution",
        run_id: runId,
        resolution: { reviewers: [{ id: "security", unknown: true }] },
      }),
    },
    {
      name: "request",
      record: (runId: string) => ({
        record: "request",
        run_id: runId,
        request: {
          schema_version: "2",
          project_name: "demo",
          workspace: "C:/demo",
          instructions: "Review it.",
          review_scope: { mode: "full" },
          unexpected: true,
        },
      }),
    },
    {
      name: "reviewer result",
      record: (runId: string) => ({
        record: persistedReviewerResultRecordType,
        run_id: runId,
        reviewer_id: "security",
        result: resultV2([
          findingV2({ severity: "urgent", title: "Forged severity" }),
        ]),
      }),
    },
    {
      name: "reviewer terminal",
      record: (runId: string) => ({
        record: "reviewer.terminal",
        run_id: runId,
        terminal: {
          reviewer_id: "security",
          status: "completed",
          adapter: "gateway",
          model: "model",
          isolation: "runtime_read_only",
          elapsed_ms: 1,
          result: { ...legacyResult([]), verdict: "fail" },
        },
      }),
    },
    {
      name: "reviewer attempt",
      record: (runId: string) => ({
        record: "reviewer.attempt",
        run_id: runId,
        reviewer_id: "security",
        attempt: 0,
        startedAt: "2026-09-03T00:00:00.000Z",
        elapsedMs: 1,
        failure: {
          reason: "timeout",
          message: "Timed out.",
          retryable: true,
        },
      }),
    },
    {
      name: "run summary",
      record: (runId: string) => ({
        record: "run.summary",
        run_id: runId,
        summary: { gate_outcome: "maybe", exit_code: 1 },
      }),
    },
  ])("rejects a malformed private $name record", async ({ record }) => {
    const { runsDirectory } = await fixture();
    const runId = "run-corrupt-private";
    await writeFile(join(runsDirectory, `${runId}.jsonl`), line(record(runId)));

    await expect(readRunReport({ runsDirectory, runId })).rejects.toMatchObject(
      { code: "invalid_run_record" },
    );
  });

  it.each([
    {
      name: "v4 reviewer result",
      event: (runId: string) => ({
        schema_version: "4",
        event: "reviewer.completed",
        run_id: runId,
        seq: 1,
        timestamp: "2026-09-03T00:00:00.000Z",
        reviewer_id: "security",
        data: {
          adapter: "gateway",
          model: "model",
          isolation: "runtime_read_only",
          elapsed_ms: 1,
          result: legacyResult([
            legacyFinding({ severity: "urgent", title: "Forged severity" }),
          ]),
        },
      }),
    },
    {
      name: "v5 compact completion",
      event: (runId: string) => ({
        schema_version: "5",
        event: "run.completed",
        run_id: runId,
        seq: 1,
        timestamp: "not-a-timestamp",
        data: {
          gate_outcome: "findings",
          coverage_outcome: "complete",
          exit_code: 1,
          consistency_mode: "live_worktree",
          total_elapsed_ms: 1,
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
      }),
    },
  ])("rejects a malformed $name public event", async ({ event }) => {
    const { runsDirectory } = await fixture();
    const runId = "run-corrupt-public";
    await writeFile(join(runsDirectory, `${runId}.jsonl`), line(event(runId)));

    await expect(readRunReport({ runsDirectory, runId })).rejects.toMatchObject(
      { code: "invalid_run_record" },
    );
  });
});

describe("finding consolidation and rendering", () => {
  const raw = (
    reviewerId: string,
    findingId: string,
    overrides: Partial<RawRunFinding> = {},
  ): RawRunFinding => ({
    source_ref: `${reviewerId}#${findingId}`,
    reviewer_id: reviewerId,
    lens_id: reviewerId.split("::")[0]!,
    finding_id: findingId,
    severity: "medium",
    title: "Same root issue",
    description: "The same invariant is broken.",
    evidence: [{ detail: `${reviewerId} evidence` }],
    suggested_direction: "Restore the invariant.",
    confidence: "high",
    classification: "confirmed_defect",
    external_assumptions: [],
    source_findings: [{ reviewer_id: reviewerId, finding_id: findingId }],
    duplicate_finding_ids: [],
    ...overrides,
  });

  it("is deterministic, unions evidence, and disambiguates unrelated duplicate ids", () => {
    const findings = [
      raw("financial::one", "root-a", {
        severity: "high",
        deduplication_key: "root",
      }),
      raw("contract::two", "root-b", {
        severity: "critical",
        confidence: "medium",
        deduplication_key: "root",
      }),
      raw("tests::one", "duplicate-id", {
        title: "First distinct issue",
        description: "First description.",
      }),
      raw("design::one", "duplicate-id", {
        title: "Second distinct issue",
        description: "Second description.",
      }),
    ];

    const forward = consolidateFindings(findings);
    const reverse = consolidateFindings([...findings].reverse());

    expect(reverse).toEqual(forward);
    expect(forward[0]).toMatchObject({
      id: "root-b",
      severity: "critical",
      confidence: "medium",
      duplicate_finding_ids: ["root-a"],
      source_findings: [
        { reviewer_id: "contract::two", finding_id: "root-b" },
        { reviewer_id: "financial::one", finding_id: "root-a" },
      ],
    });
    expect(forward[0]?.evidence).toHaveLength(2);
    expect(forward.map(({ id }) => id)).toEqual([
      "root-b",
      "duplicate-id",
      "duplicate-id~2",
    ]);
  });

  it("exposes raw and consolidated findings and renders stable JSON and Markdown", async () => {
    const { runsDirectory } = await fixture();
    const runId = "run-render";
    await writeFile(
      join(runsDirectory, `${runId}.jsonl`),
      [
        line({
          record: "resolution",
          run_id: runId,
          resolution: {
            reviewers: [{ id: "security", agent_id: "security" }],
          },
        }),
        line({
          record: persistedReviewerResultRecordType,
          run_id: runId,
          reviewer_id: "security",
          result: resultV2([
            findingV2({
              title: "Unsafe `token` handling",
              external_assumptions: ["The upstream payload remains stable."],
            }),
          ]),
        }),
        line({
          record: "run.summary",
          run_id: runId,
          summary: {
            gate_outcome: "findings",
            coverage_outcome: "complete",
            exit_code: 1,
          },
        }),
      ].join(""),
    );

    const report = await readRunReport({ runsDirectory, runId });
    const findings = await readRunFindings({ runsDirectory, runId });
    const json = renderRunReportJson(report);
    const markdown = renderRunReportMarkdown(report);

    expect(findings).toMatchObject({
      run_id: runId,
      raw: [expect.objectContaining({ reviewer_id: "security" })],
      deduplicated: [expect.objectContaining({ id: "mapping-failure" })],
    });
    expect(JSON.parse(json)).toEqual(report);
    expect(markdown).toContain("Gate outcome: **FINDINGS**");
    expect(markdown).toContain("Coverage outcome: **COMPLETE**");
    expect(markdown).toContain("security#mapping-failure");
    expect(markdown).toContain("src/processor.ts:41-44");
    expect(markdown).toContain("The upstream payload remains stable.");
    expect(await readFile(report.report_path, "utf8")).toContain(
      persistedReviewerResultRecordType,
    );
  });

  it("reports the exact canonical count recorded by live completion", async () => {
    const { runsDirectory } = await fixture();
    const runId = "run-canonical-count";
    await writeFile(
      join(runsDirectory, `${runId}.jsonl`),
      [
        line({
          record: "resolution",
          run_id: runId,
          resolution: {
            reviewers: [
              { id: "contract::one", agent_id: "contract" },
              { id: "contract::two", agent_id: "contract" },
            ],
          },
        }),
        line({
          record: persistedReviewerResultRecordType,
          run_id: runId,
          reviewer_id: "contract::one",
          result: resultV2([
            findingV2({ id: "one", root_issue_id: "shared-root" }),
          ]),
        }),
        line({
          record: persistedReviewerResultRecordType,
          run_id: runId,
          reviewer_id: "contract::two",
          result: resultV2([
            findingV2({
              id: "two",
              root_issue_id: "shared-root",
              title: "Different wording",
            }),
          ]),
        }),
        line({
          schema_version: "5",
          event: "run.completed",
          run_id: runId,
          seq: 1,
          timestamp: "2026-09-04T00:00:00.000Z",
          data: {
            gate_outcome: "findings",
            coverage_outcome: "complete",
            exit_code: 1,
            consistency_mode: "live_worktree",
            total_elapsed_ms: 1,
            raw_findings: 2,
            unique_findings: 1,
            gate_findings: 1,
            advisory_findings: 0,
            result_manifest: [],
            results_complete: false,
            status: "findings",
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
        }),
      ].join(""),
    );

    const report = await readRunReport({ runsDirectory, runId });
    const findings = await readRunFindings({ runsDirectory, runId });

    expect(report.finding_counts.unique).toBe(1);
    expect(findings.deduplicated).toHaveLength(1);
    expect(report.finding_counts.unique).toBe(findings.deduplicated.length);
  });

  it("uses the persisted low gate threshold in strict report and findings views", async () => {
    const { runsDirectory } = await fixture();
    const runId = "run-low-threshold";
    const result = resultV3("# Review\n\nConfirmed low defect.");
    result.verdict = "fail";
    result.summary = "Confirmed low defect.";
    result.actionable_findings = [
      {
        ...findingV2({ id: "low-confirmed", severity: "low" }),
        severity: "low" as const,
        confidence: "high" as const,
        classification: "confirmed_defect" as const,
        category: "correctness",
        verification: "The cited evidence confirms the defect.",
      },
    ];
    await writeFile(
      join(runsDirectory, `${runId}.jsonl`),
      [
        line({
          record: "resolution",
          run_id: runId,
          resolution: {
            reviewers: [
              {
                id: "configurable::primary",
                agent_id: "configurable",
                policy: {
                  passQuorum: 1,
                  minimumProviderGroups: 1,
                  adjudication: "off",
                  gateMinimumSeverity: "low",
                  gateMinimumConfidence: "medium",
                },
              },
            ],
          },
        }),
        line({
          ...persistedResultV3(runId, result),
          reviewer_id: "configurable::primary",
          lens_id: "configurable",
        }),
      ].join(""),
    );

    const report = await readRunReport({ runsDirectory, runId });
    const findings = await readRunFindings({ runsDirectory, runId });

    expect(report).toMatchObject({
      gate_outcome: "findings",
      finding_counts: { raw: 1, unique: 1, gate: 1, advisory: 0 },
    });
    expect(findings.deduplicated).toEqual([
      expect.objectContaining({ id: "low-confirmed", gate_eligible: true }),
    ]);
    expect(renderRunReportMarkdown(report)).toContain("LOW — Mapping failure");
  });

  it("derives a passed gate outcome when an unrecognized persisted outcome has only advisories", async () => {
    const { runsDirectory } = await fixture();
    const runId = "run-advisory-fallback";
    await writeFile(
      join(runsDirectory, `${runId}.jsonl`),
      [
        line({
          record: "reviewer.result",
          run_id: runId,
          reviewer_id: "maintainability",
          result: resultV2([
            findingV2({
              id: "advisory-only",
              severity: "low",
              classification: "advisory",
            }),
          ]),
        }),
        line({
          record: "run.summary",
          run_id: runId,
          summary: {
            gate_outcome: "unknown_future_value",
            coverage_outcome: "complete",
            exit_code: 0,
          },
        }),
      ].join(""),
    );

    const report = await readRunReport({ runsDirectory, runId });

    expect(report.finding_counts).toEqual({
      raw: 1,
      unique: 1,
      gate: 0,
      advisory: 1,
    });
    expect(report.gate_outcome).toBe("passed");
    expect(report.status).toBe("passed");
  });

  it("uses persisted non-default gate thresholds for report findings", async () => {
    const { runsDirectory } = await fixture();
    const runId = "run-strict-thresholds";
    await writeFile(
      join(runsDirectory, `${runId}.jsonl`),
      [
        line({
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
        }),
        line({
          record: "reviewer.result",
          run_id: runId,
          reviewer_id: "strict::primary",
          result: resultV2([
            findingV2({
              id: "medium-only",
              severity: "medium",
              confidence: "high",
            }),
          ]),
        }),
      ].join(""),
    );

    const report = await readRunReport({ runsDirectory, runId });

    expect(report.finding_counts).toEqual({
      raw: 1,
      unique: 1,
      gate: 0,
      advisory: 1,
    });
    expect(report.gate_outcome).toBe("passed");
  });

  it("uses persisted validated adjudication after the workspace changes", async () => {
    const { runsDirectory } = await fixture();
    const runId = "run-persisted-adjudication";
    const candidate = resultV3("# Review\n\nCandidate.");
    candidate.verdict = "fail";
    candidate.summary = "Candidate.";
    candidate.actionable_findings = [
      {
        id: "candidate",
        severity: "high",
        title: "Candidate",
        description: "Candidate description.",
        evidence: [
          {
            path: "src/item.ts",
            start_line: 1,
            end_line: 1,
            detail: "Evidence.",
          },
        ],
        suggested_direction: "Fix.",
        confidence: "high",
        classification: "confirmed_defect",
        external_assumptions: [],
        category: "correctness",
        verification: "Verified.",
      },
    ];
    const adjudication = {
      schema_version: "1" as const,
      kind: "review-mesh.adjudication-result" as const,
      verdict: "pass" as const,
      review_markdown: "# Adjudication\n\nRejected.",
      summary: "Rejected.",
      actionable_findings: [] as [],
      decisions: [
        {
          source_finding_id: "candidate",
          decision: "rejected" as const,
          rationale: "Rejected by core validation.",
          cited_evidence: [],
          unverified_assumptions: [],
        },
      ],
      informational_notes: [],
    };
    const validationContext = {
      reviewScope: "full" as const,
      git: { changedFiles: [] as string[], diff: "" },
      evidenceVerification: {
        by_source_finding_id: { candidate: { verified: true, failures: [] } },
      },
    };
    const attestation = createAdjudicationValidationAttestation({
      candidateResult: candidate,
      adjudicationResult: adjudication,
      contextHead: "persisted-head",
      validationContext,
    });
    await writeFile(
      join(runsDirectory, `${runId}.jsonl`),
      [
        line({
          record: "context",
          run_id: runId,
          context: {
            review_scope: { mode: "full" },
            git: {
              is_repository: true,
              head: "persisted-head",
              changed_files: [],
              diff: "",
            },
          },
        }),
        line({
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
        }),
        line({
          record: "reviewer.result",
          run_id: runId,
          reviewer_id: "lens::source",
          digest: reviewerResultDigest(candidate),
          byte_count: Buffer.byteLength(JSON.stringify(candidate)),
          result: candidate,
        }),
        line({
          record: "reviewer.result",
          run_id: runId,
          reviewer_id: "lens::judge",
          mode: "adjudication",
          adjudicates_reviewer_id: "lens::source",
          digest: reviewerResultDigest(adjudication),
          byte_count: Buffer.byteLength(JSON.stringify(adjudication)),
          result: adjudication,
          adjudication_validation: attestation,
        }),
      ].join(""),
    );

    const report = await readRunReport({ runsDirectory, runId });
    expect(report.finding_counts).toEqual({
      raw: 1,
      unique: 0,
      gate: 0,
      advisory: 0,
    });
  });

  it.each(["missing", "invalid"] as const)(
    "downgrades required adjudication with %s validation attestation",
    async (attestationState) => {
      const { runsDirectory } = await fixture();
      const runId = `run-${attestationState}-attestation`;
      const candidate = resultV3("# Review\n\nCandidate.");
      candidate.verdict = "fail";
      candidate.actionable_findings = [
        {
          id: "candidate",
          severity: "high",
          title: "Candidate",
          description: "Candidate description.",
          evidence: [
            {
              path: "src/item.ts",
              start_line: 1,
              end_line: 1,
              detail: "Evidence.",
            },
          ],
          suggested_direction: "Fix.",
          confidence: "high",
          classification: "confirmed_defect",
          external_assumptions: [],
          category: "correctness",
          verification: "Verified.",
        },
      ];
      const adjudication = {
        schema_version: "1" as const,
        kind: "review-mesh.adjudication-result" as const,
        verdict: "fail" as const,
        review_markdown: "# Adjudication\n\nConfirmed.",
        summary: "Confirmed.",
        actionable_findings: [] as [],
        decisions: [
          {
            source_finding_id: "candidate",
            decision: "confirmed" as const,
            rationale: "Confirmed.",
            cited_evidence: [
              {
                path: "src/item.ts",
                start_line: 1,
                end_line: 1,
                detail: "Evidence.",
              },
            ],
            unverified_assumptions: [],
          },
        ],
        informational_notes: [],
      };
      const valid = createAdjudicationValidationAttestation({
        candidateResult: candidate,
        adjudicationResult: adjudication,
        contextHead: "head",
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
        join(runsDirectory, `${runId}.jsonl`),
        [
          line({
            record: "request",
            run_id: runId,
            request: {
              schema_version: "2",
              project_name: "demo",
              workspace: "C:/demo",
              instructions: "Review.",
              review_scope: { mode: "full" },
            },
          }),
          line({
            record: "context",
            run_id: runId,
            context: { git: { head: "head", changed_files: [], diff: "" } },
          }),
          line({
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
          }),
          line({
            record: "reviewer.result",
            run_id: runId,
            reviewer_id: "lens::source",
            digest: reviewerResultDigest(candidate),
            byte_count: Buffer.byteLength(JSON.stringify(candidate)),
            result: candidate,
          }),
          line({
            record: "reviewer.result",
            run_id: runId,
            reviewer_id: "lens::judge",
            mode: "adjudication",
            adjudicates_reviewer_id: "lens::source",
            digest: reviewerResultDigest(adjudication),
            byte_count: Buffer.byteLength(JSON.stringify(adjudication)),
            result: adjudication,
            ...(attestationState === "missing"
              ? {}
              : {
                  adjudication_validation: { ...valid, context_head: "wrong" },
                }),
          }),
        ].join(""),
      );

      const report = await readRunReport({ runsDirectory, runId });
      expect(report.raw_findings).toEqual([
        expect.objectContaining({
          classification: "needs_verification",
          adjudication: "needs_verification",
          gate_eligible: false,
        }),
      ]);
      expect(report.finding_counts).toEqual({
        raw: 1,
        unique: 1,
        gate: 0,
        advisory: 1,
      });
      expect(report.gate_outcome).toBe("passed");
    },
  );
});
