import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
      gate_outcome: "findings",
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
});
