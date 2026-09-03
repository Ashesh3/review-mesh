import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { readRunStatus } from "../../src/diagnostics/run-status.js";
import type { ReviewerResultV3 } from "../../src/protocol/schemas.js";
import { reviewerResultDigest } from "../../src/results/digest.js";

const temporaryRoots: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "review-mesh-status-"));
  temporaryRoots.push(root);
  const runsDirectory = join(root, "runs");
  await mkdir(runsDirectory, { recursive: true });
  return { root, runsDirectory };
}

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("readRunStatus", () => {
  it("loads and verifies the complete private v3 result for compact artifacts", async () => {
    const { runsDirectory } = await fixture();
    const runId = "run-private-result";
    const result: ReviewerResultV3 = {
      schema_version: "3",
      verdict: "pass",
      review_markdown: "# Complete private review",
      summary: "No findings.",
      actionable_findings: [],
      informational_notes: [],
    };
    const digest = reviewerResultDigest(result);
    const byteCount = Buffer.byteLength(JSON.stringify(result), "utf8");
    await writeFile(
      join(runsDirectory, `${runId}.jsonl`),
      [
        line({
          record: "reviewer.result",
          run_id: runId,
          reviewer_id: "security",
          digest,
          byte_count: byteCount,
          result,
        }),
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
            result: { ...result, review_markdown: "[truncated]" },
          },
        }),
      ].join(""),
    );

    await expect(
      readRunStatus({ runsDirectory, runId }),
    ).resolves.toMatchObject({
      reviewers: [
        {
          reviewer_id: "security",
          complete_result: result,
          result_digest: digest,
          result_byte_count: byteCount,
        },
      ],
    });
  });

  it("rejects a private v3 result whose digest does not match", async () => {
    const { runsDirectory } = await fixture();
    const runId = "run-private-result-mismatch";
    const result: ReviewerResultV3 = {
      schema_version: "3",
      verdict: "pass",
      review_markdown: "# Complete private review",
      summary: "No findings.",
      actionable_findings: [],
      informational_notes: [],
    };
    await writeFile(
      join(runsDirectory, `${runId}.jsonl`),
      line({
        record: "reviewer.result",
        run_id: runId,
        reviewer_id: "security",
        digest: "0".repeat(64),
        byte_count: Buffer.byteLength(JSON.stringify(result), "utf8"),
        result,
      }),
    );

    await expect(readRunStatus({ runsDirectory, runId })).rejects.toMatchObject(
      {
        code: "invalid_run_record",
        line: 1,
        recordType: "reviewer.result",
        schemaPaths: ["digest"],
      },
    );
  });

  it("rejects a conflicting public v3 result instead of mixing it with private integrity metadata", async () => {
    const { runsDirectory } = await fixture();
    const runId = "run-conflicting-public-result";
    const privateResult: ReviewerResultV3 = {
      schema_version: "3",
      verdict: "pass",
      review_markdown: "# Authoritative private review",
      summary: "No findings.",
      actionable_findings: [],
      informational_notes: [],
    };
    const publicResult = {
      ...privateResult,
      review_markdown: "# Conflicting public review",
    };
    await writeFile(
      join(runsDirectory, `${runId}.jsonl`),
      [
        line({
          record: "reviewer.result",
          run_id: runId,
          reviewer_id: "security",
          digest: reviewerResultDigest(privateResult),
          byte_count: Buffer.byteLength(JSON.stringify(privateResult), "utf8"),
          result: privateResult,
        }),
        line({
          schema_version: "5",
          event: "reviewer.result",
          run_id: runId,
          seq: 1,
          timestamp: "2026-09-03T00:00:01.000Z",
          reviewer_id: "security",
          data: {
            digest: reviewerResultDigest(privateResult),
            byte_count: Buffer.byteLength(
              JSON.stringify(privateResult),
              "utf8",
            ),
            result: publicResult,
          },
        }),
      ].join(""),
    );

    await expect(readRunStatus({ runsDirectory, runId })).rejects.toMatchObject(
      {
        code: "invalid_run_record",
        line: 2,
        recordType: "reviewer.result",
        schemaPaths: ["digest"],
      },
    );
  });

  it("rejects a conflicting private v3 result that follows a verified public result", async () => {
    const { runsDirectory } = await fixture();
    const runId = "run-conflicting-private-result";
    const publicResult: ReviewerResultV3 = {
      schema_version: "3",
      verdict: "pass",
      review_markdown: "# Verified public review",
      summary: "No findings.",
      actionable_findings: [],
      informational_notes: [],
    };
    const privateResult = {
      ...publicResult,
      review_markdown: "# Conflicting private review",
    };
    await writeFile(
      join(runsDirectory, `${runId}.jsonl`),
      [
        line({
          schema_version: "5",
          event: "reviewer.result",
          run_id: runId,
          seq: 1,
          timestamp: "2026-09-03T00:00:01.000Z",
          reviewer_id: "security",
          data: {
            digest: reviewerResultDigest(publicResult),
            byte_count: Buffer.byteLength(JSON.stringify(publicResult), "utf8"),
            result: publicResult,
          },
        }),
        line({
          record: "reviewer.result",
          run_id: runId,
          reviewer_id: "security",
          digest: reviewerResultDigest(privateResult),
          byte_count: Buffer.byteLength(JSON.stringify(privateResult), "utf8"),
          result: privateResult,
        }),
      ].join(""),
    );

    await expect(readRunStatus({ runsDirectory, runId })).rejects.toMatchObject(
      {
        code: "invalid_run_record",
        line: 2,
        recordType: "reviewer.result",
        schemaPaths: ["digest"],
      },
    );
  });

  it("summarizes one active reviewer without returning unrelated reviewers", async () => {
    const { runsDirectory } = await fixture();
    const runId = "run-active";
    await writeFile(
      join(runsDirectory, `${runId}.jsonl.active.12.1.owner`),
      [
        line({
          record: "resolution",
          run_id: runId,
          resolution: {
            reviewers: [
              { id: "first", purpose: "First", adapter: "gateway", model: "a" },
              {
                id: "second",
                purpose: "Second",
                adapter: "gateway",
                model: "b",
              },
            ],
          },
        }),
        line({
          schema_version: "3",
          event: "run.started",
          run_id: runId,
          seq: 1,
          timestamp: "2026-09-03T00:00:00.000Z",
          data: { consistency_mode: "live_worktree" },
        }),
        line({
          schema_version: "5",
          event: "suite.resolved",
          run_id: runId,
          seq: 2,
          timestamp: "2026-09-03T00:00:00.500Z",
          data: {
            logical_lenses: 2,
            model_runs: 2,
            execution: {
              max_concurrency: 2,
              heartbeat_interval_ms: 15_000,
              shutdown_grace_period_ms: 5_000,
            },
          },
        }),
        line({
          schema_version: "3",
          event: "reviewer.progress",
          run_id: runId,
          seq: 3,
          timestamp: "2026-09-03T00:00:01.000Z",
          reviewer_id: "second",
          data: { phase: "reviewing", message: "Inspecting files." },
        }),
        line({
          schema_version: "3",
          event: "reviewer.heartbeat",
          run_id: runId,
          seq: 4,
          timestamp: "2026-09-03T00:00:02.000Z",
          reviewer_id: "second",
          data: {
            phase: "reviewing",
            elapsed_ms: 2_000,
            last_activity_at: "2026-09-03T00:00:01.000Z",
            last_activity_message: "Completed inspection tool.",
            suite: {
              total: 2,
              queued: 1,
              running: 1,
              completed: 0,
              incomplete: 0,
            },
          },
        }),
        '{"schema_version":"3","event":"reviewer.progress"',
      ].join(""),
    );

    await expect(
      readRunStatus({ runsDirectory, runId, reviewerId: "second" }),
    ).resolves.toMatchObject({
      kind: "review-mesh.run-status",
      run_id: runId,
      active: true,
      status: "running",
      last_seq: 4,
      reviewers: [
        {
          reviewer_id: "second",
          purpose: "Second",
          adapter: "gateway",
          model: "b",
          state: "reviewing",
          elapsed_ms: 2_000,
          last_activity_message: "Completed inspection tool.",
        },
      ],
    });
  });

  it("prefers the final record and returns terminal failures", async () => {
    const { runsDirectory } = await fixture();
    const runId = "run-complete";
    await writeFile(
      join(runsDirectory, `${runId}.jsonl`),
      line({
        schema_version: "3",
        event: "run.completed",
        run_id: runId,
        seq: 1,
        timestamp: "2026-09-03T00:00:02.000Z",
        data: {
          status: "incomplete",
          exit_code: 3,
          consistency_mode: "live_worktree",
          total_elapsed_ms: 10,
          suite: {
            total: 1,
            queued: 0,
            running: 0,
            completed: 0,
            incomplete: 1,
          },
          reviewers: [
            {
              reviewer_id: "kimi",
              status: "incomplete",
              adapter: "gateway",
              model: "kimi",
              elapsed_ms: 10,
              reason: "adapter_unavailable",
              message: "Endpoint unavailable.",
              retryable: true,
            },
          ],
        },
      }),
    );

    await expect(
      readRunStatus({ runsDirectory, runId }),
    ).resolves.toMatchObject({
      active: false,
      status: "incomplete",
      exit_code: 3,
      reviewers: [
        {
          reviewer_id: "kimi",
          state: "incomplete",
          failure: { reason: "adapter_unavailable", retryable: true },
        },
      ],
    });
  });

  it("returns a compact completed-result summary instead of replaying findings", async () => {
    const { runsDirectory } = await fixture();
    const runId = "run-result";
    await writeFile(
      join(runsDirectory, `${runId}.jsonl`),
      line({
        schema_version: "4",
        event: "reviewer.completed",
        run_id: runId,
        seq: 1,
        timestamp: "2026-09-03T00:00:01.000Z",
        reviewer_id: "reviewer",
        data: {
          adapter: "gateway",
          model: "model",
          isolation: "runtime_read_only",
          elapsed_ms: 10,
          result: {
            schema_version: "1",
            verdict: "fail",
            summary: "One issue found.",
            actionable_findings: [
              {
                id: "secret-detail",
                severity: "high",
                title: "Large finding",
                description: "Do not replay this in status.",
                evidence: [{ detail: "Evidence." }],
                suggested_direction: "Fix it.",
              },
            ],
            informational_notes: [],
          },
        },
      }),
    );

    const status = await readRunStatus({ runsDirectory, runId });
    expect(status).toMatchObject({
      reviewers: [
        {
          result: {
            verdict: "fail",
            summary: "One issue found.",
            actionable_findings: 1,
            informational_notes: 0,
          },
        },
      ],
    });
    expect(JSON.stringify(status)).not.toContain("secret-detail");
  });

  it("reports v4 skipped fallback runs and compact suite counts", async () => {
    const { runsDirectory } = await fixture();
    const runId = "run-skipped";
    await writeFile(
      join(runsDirectory, `${runId}.jsonl`),
      line({
        schema_version: "4",
        event: "reviewer.skipped",
        run_id: runId,
        seq: 1,
        timestamp: "2026-09-03T00:00:01.000Z",
        reviewer_id: "agent::fallback",
        data: {
          adapter: "gateway",
          model: "fallback",
          elapsed_ms: 0,
          reason: "prior_incomplete",
          blocked_by_reviewer_id: "agent::primary",
        },
      }),
    );

    await expect(
      readRunStatus({ runsDirectory, runId }),
    ).resolves.toMatchObject({
      suite: { total: 1, deferred: 0, skipped: 1 },
      reviewers: [
        {
          reviewer_id: "agent::fallback",
          state: "skipped",
          skipped: {
            reason: "prior_incomplete",
            blocked_by_reviewer_id: "agent::primary",
          },
        },
      ],
    });
  });

  it("exposes bounded attempt history and separates root failures from circuit effects", async () => {
    const { runsDirectory } = await fixture();
    const runId = "run-causal-status";
    const records = [
      line({
        record: "resolution",
        run_id: runId,
        resolution: {
          execution: {
            max_concurrency: 2,
            heartbeat_interval_ms: 15_000,
            shutdown_grace_period_ms: 5_000,
            distribute_primaries: true,
          },
          reviewers: [
            {
              id: "security::primary",
              agent_id: "security",
              model_index: 0,
              configured_model_index: 1,
            },
            {
              id: "security::fallback",
              agent_id: "security",
              model_index: 1,
              configured_model_index: 0,
            },
          ],
          future_resolution_field: true,
        },
      }),
    ];
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      records.push(
        line({
          record: "reviewer.attempt",
          run_id: runId,
          reviewer_id: "security::primary",
          attempt,
          startedAt: `2026-09-03T00:00:${String(attempt).padStart(2, "0")}.000Z`,
          elapsedMs: attempt,
          failure: {
            reason: "adapter_unavailable",
            message: "Gateway failed.",
            retryable: true,
            fallback_eligible: true,
            diagnostics: { failure_stage: "http_response", http_status: 503 },
          },
        }),
      );
    }
    records.push(
      line({
        record: "reviewer.terminal",
        run_id: runId,
        data: {
          reviewer_id: "security::primary",
          status: "incomplete",
          adapter: "gateway",
          model: "primary",
          elapsed_ms: 10,
          reason: "adapter_unavailable",
          message: "Gateway failed.",
          retryable: true,
          fallback_eligible: true,
        },
      }),
      line({
        record: "reviewer.terminal",
        run_id: runId,
        terminal: {
          reviewer_id: "security::fallback",
          status: "skipped",
          adapter: "gateway",
          model: "fallback",
          elapsed_ms: 0,
          reason: "circuit_open",
          blocked_by_reviewer_id: "security::primary",
        },
      }),
    );
    await writeFile(join(runsDirectory, `${runId}.jsonl`), records.join(""));

    const status = await readRunStatus({ runsDirectory, runId });
    expect(status).toMatchObject({
      reviewers: [
        {
          reviewer_id: "security::primary",
          state: "incomplete",
          cause: {
            kind: "root_failure",
            reviewer_id: "security::primary",
            reason: "adapter_unavailable",
          },
        },
        {
          reviewer_id: "security::fallback",
          state: "skipped",
          cause: {
            kind: "downstream_effect",
            reviewer_id: "security::primary",
            reason: "adapter_unavailable",
          },
        },
      ],
    });
    const reviewers = status.reviewers as Array<Record<string, unknown>>;
    expect(reviewers[0]?.attempts).toHaveLength(8);
    expect(reviewers[0]?.attempts).toEqual([
      expect.objectContaining({ attempt: 3 }),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ attempt: 10 }),
    ]);
  });

  it("labels a circuit-blocked incomplete retry as a downstream effect", async () => {
    const { runsDirectory } = await fixture();
    const runId = "run-circuit-blocked-retry";
    await writeFile(
      join(runsDirectory, `${runId}.jsonl`),
      [
        line({
          record: "resolution",
          run_id: runId,
          resolution: {
            reviewers: [
              { id: "first", adapter: "gateway", model: "a" },
              { id: "second", adapter: "gateway", model: "b" },
            ],
          },
        }),
        line({
          record: "reviewer.terminal",
          run_id: runId,
          terminal: {
            reviewer_id: "first",
            status: "incomplete",
            adapter: "gateway",
            model: "a",
            elapsed_ms: 1,
            reason: "timeout",
            message: "Gateway timed out.",
            retryable: true,
          },
        }),
        line({
          record: "reviewer.terminal",
          run_id: runId,
          terminal: {
            reviewer_id: "second",
            status: "incomplete",
            adapter: "gateway",
            model: "b",
            elapsed_ms: 1,
            reason: "adapter_unavailable",
            message: "Retry blocked by circuit.",
            retryable: false,
            diagnostics: {
              retry_blocked_by_circuit: true,
              circuit_caused_by_reviewer_id: "first",
            },
          },
        }),
      ].join(""),
    );

    const status = await readRunStatus({ runsDirectory, runId });
    expect(status).toMatchObject({
      reviewers: [
        { reviewer_id: "first", cause: { kind: "root_failure" } },
        {
          reviewer_id: "second",
          cause: {
            kind: "downstream_effect",
            reviewer_id: "first",
            reason: "timeout",
          },
        },
      ],
    });
  });

  it("includes the one-based JSONL line and record type for invalid JSON", async () => {
    const { runsDirectory } = await fixture();
    const runId = "run-status-invalid-json";
    await writeFile(
      join(runsDirectory, `${runId}.jsonl`),
      `${line({ record: "context", run_id: runId, context: {} })}{bad`,
    );

    await expect(readRunStatus({ runsDirectory, runId })).rejects.toMatchObject(
      {
        code: "invalid_run_record",
        line: 2,
        recordType: "invalid_json",
        message: expect.stringContaining("JSONL line 2 (invalid_json)"),
      },
    );
  });

  it("rejects unsafe ids and missing records", async () => {
    const { runsDirectory } = await fixture();
    await expect(
      readRunStatus({ runsDirectory, runId: "../outside" }),
    ).rejects.toMatchObject({ code: "invalid_run_id" });
    await expect(
      readRunStatus({ runsDirectory, runId: "run-missing" }),
    ).rejects.toMatchObject({ code: "run_not_found" });
  });

  it("returns an empty reviewer selection for an unknown exact reviewer id", async () => {
    const { runsDirectory } = await fixture();
    const runId = "run-known";
    await writeFile(
      join(runsDirectory, `${runId}.jsonl`),
      line({
        schema_version: "4",
        event: "run.started",
        run_id: runId,
        seq: 1,
        timestamp: "2026-09-03T00:00:00.000Z",
        data: { consistency_mode: "live_worktree" },
      }),
    );

    await expect(
      readRunStatus({ runsDirectory, runId, reviewerId: "missing" }),
    ).resolves.toMatchObject({ reviewer_id: "missing", reviewers: [] });
  });
});
