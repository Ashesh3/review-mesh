import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRunArtifact } from "../../src/diagnostics/run-artifact.js";
import { readNormalizedRun } from "../../src/diagnostics/normalize-run.js";
import {
  v9DashboardRun,
  v9RunSummary,
  v9Status,
} from "../../src/diagnostics/v9-views.js";
import {
  readDashboardRun,
  readDashboardSnapshot,
} from "../../src/server/dashboard-data.js";
import type { ReviewerResultV4 } from "../../src/protocol/v9.js";
import {
  indexRunArtifact,
  resolveRunArtifact,
} from "../../src/diagnostics/run-index.js";

const roots: string[] = [];
const writers: Array<Awaited<ReturnType<typeof createRunArtifact>>> = [];
const startedAt = "2026-09-05T00:00:00.000Z";
const at = (milliseconds: number) =>
  new Date(Date.parse(startedAt) + milliseconds).toISOString();
const deadline = {
  mode: "fixed",
  tier: "fixed",
  duration_ms: 60_000,
  started_at: startedAt,
  deadline_at: at(60_000),
  inputs: {
    review_scope: "full",
    changed_file_count: 0,
    raw_diff_byte_count: 0,
    changed_files_truncated: false,
    diff_truncated: false,
  },
};
const result: ReviewerResultV4 = {
  schema_version: "4",
  verdict: "pass",
  summary: "Review complete",
  review_markdown: "Review complete",
  actionable_findings: [],
  informational_notes: [],
  change_coverage: {
    status: "not_applicable",
    inspected_count: 0,
    deficit_count: 0,
    deficit_sample: [],
  },
};
afterEach(async () => {
  vi.restoreAllMocks();
  for (const writer of writers.splice(0)) await writer.close();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture(
  ids = ["quality::primary", "quality::backup", "security::primary"],
) {
  const root = await mkdtemp(join(tmpdir(), "review-mesh-dashboard-v9-"));
  roots.push(root);
  const path = join(root, "timeline.jsonl");
  const writer = await createRunArtifact({
    path,
    runId: "timeline",
    toolVersion: "9.0.0",
    createdAt: startedAt,
  });
  writers.push(writer);
  let seq = 0;
  const event = (
    event: string,
    data: Record<string, unknown>,
    milliseconds = 0,
    reviewer_id?: string,
  ) =>
    writer.record({
      schema_version: "6",
      run_id: "timeline",
      seq: ++seq,
      timestamp: at(milliseconds),
      event,
      data,
      ...(reviewer_id ? { reviewer_id } : {}),
    });
  const resolve = async () => {
    await writer.record({
      record: "context",
      context: {
        project_name: "Demo",
        review_scope: { mode: "full" },
        instructions: "PRIVATE INSTRUCTIONS",
        caller_context: { private: "PRIVATE CONTEXT" },
        git: { is_repository: false },
      },
    });
    await writer.record({
      record: "resolution",
      resolution: {
        reviewers: ids.map((id) => ({ id, agent_id: id.split("::")[0] })),
        deadline,
      },
    });
    await event(
      "context.resolved",
      {
        project_name: "Demo",
        review_scope: "full",
        changed_files_count: 0,
        diff_byte_count: 0,
        truncated: false,
        detail_ref: "context",
      },
      100,
    );
    await event(
      "suite.resolved",
      {
        logical_lenses: new Set(ids.map((id) => id.split("::")[0])).size,
        model_runs: ids.length,
        deadline,
        warnings: [],
        detail_ref: "resolution",
      },
      200,
    );
  };
  const start = (id: string, milliseconds = 1_000, attempt = 1) =>
    event(
      "reviewer.started",
      {
        lens_id: id.split("::")[0],
        mode: "full_review",
        adapter: "gateway",
        model: "model-a",
        provider_group: "provider-a",
        attempt,
        maximum_attempts: 2,
        timeout_ms: 30_000,
        run_deadline_remaining_ms: 59_000,
        lens_deadline_remaining_ms: 59_000,
        progress_observable: true,
        proof: "observed",
      },
      milliseconds,
      id,
    );
  const heartbeat = (
    id: string,
    milliseconds: number,
    phase = "reviewing",
    attempt = 1,
  ) =>
    event(
      "suite.heartbeat",
      {
        elapsed_ms: milliseconds,
        active_count: 2,
        omitted_active_count: 1,
        active: [
          {
            reviewer_id: id,
            lens_id: id.split("::")[0],
            mode: "full_review",
            attempt,
            maximum_attempts: 2,
            phase,
            attempt_elapsed_ms: milliseconds - 1_000,
            lens_elapsed_ms: milliseconds,
            run_deadline_remaining_ms: 60_000 - milliseconds,
            lens_deadline_remaining_ms: 60_000 - milliseconds,
            attempt_deadline_remaining_ms: 30_000 - milliseconds,
            last_progress_age_ms: 1_000,
            coalesced_activity_count: 3,
          },
        ],
      },
      milliseconds,
    );
  await event("run.started", { consistency_mode: "live_worktree" });
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(at(10_000)));
  return {
    writer,
    event,
    resolve,
    start,
    heartbeat,
    path,
    appPaths: {
      configFile: join(root, "config.toml"),
      reviewersDirectory: join(root, "reviewers"),
      runsDirectory: root,
    },
  };
}

describe("v9 live dashboard projection", () => {
  it("shows the whole configured roster and distinguishes logical lenses from sequential model slots", async () => {
    const f = await fixture();
    await f.resolve();
    await f.start("quality::primary");
    const run = await readDashboardRun({
      appPaths: f.appPaths,
      runId: "timeline",
    });
    expect(run).toMatchObject({
      stage: "execute_lenses",
      started_at: startedAt,
      total_elapsed_ms: 10_000,
      logical_lenses: { total: 2, running: 1, queued: 1 },
      model_runs: { total: 3, running: 1, queued: 1, deferred: 1 },
    });
    expect(run.reviewers).toMatchObject([
      {
        reviewer_id: "quality::primary",
        lens_id: "quality",
        state: "running",
        phase: "reviewing",
        adapter: "gateway",
        model: "model-a",
        attempt: 1,
        started_at: at(1_000),
        elapsed_ms: 9_000,
      },
      {
        reviewer_id: "quality::backup",
        state: "deferred",
        phase: "deferred",
        model_index: 1,
      },
      { reviewer_id: "security::primary", state: "queued", phase: "queued" },
    ]);
    const snapshot = await readDashboardSnapshot({
      appPaths: f.appPaths,
      server: { host: "127.0.0.1", port: 1, startedAt },
    });
    expect(snapshot.counts).toMatchObject({
      active_runs: 1,
      running_reviewers: 1,
      queued_reviewers: 2,
    });
    expect(snapshot.runs[0]?.reviewers).toHaveLength(3);
    expect(snapshot.runs[0]?.reviewers?.[0]).not.toHaveProperty("activity");
  });

  it("keeps running reviewers omitted from sampled and minimal heartbeats", async () => {
    const f = await fixture();
    await f.resolve();
    await f.start("quality::primary");
    await f.start("security::primary", 2_000);
    await f.heartbeat("quality::primary", 5_000, "validating");
    await f.event(
      "suite.heartbeat",
      {
        elapsed_ms: 7_000,
        active: [],
        active_count: 2,
        minimal: true,
        detail_ref: "resolution",
      },
      7_000,
    );
    const run = v9DashboardRun(
      await readNormalizedRun(f.path, { allowActive: true }),
    );
    expect(run.reviewers).toMatchObject([
      {
        reviewer_id: "quality::primary",
        state: "running",
        phase: "validating",
        last_activity_at: at(4_000),
      },
      { reviewer_id: "quality::backup", state: "deferred" },
      {
        reviewer_id: "security::primary",
        state: "running",
        phase: "reviewing",
        last_activity_at: at(2_000),
      },
    ]);
    expect(run.model_runs).toMatchObject({ running: 2, deferred: 1 });
  });

  it("shows live public progress and coalesces its later persisted activity record", async () => {
    const f = await fixture(["quality::primary"]);
    await f.resolve();
    await f.start("quality::primary");
    await f.event(
      "reviewer.progress",
      {
        lens_id: "quality",
        mode: "full_review",
        phase: "validating",
        attempt: 1,
        message: "Checking evidence",
      },
      4_000,
      "quality::primary",
    );
    const project = async () =>
      v9DashboardRun(await readNormalizedRun(f.path, { allowActive: true }));
    expect((await project()).reviewers[0]?.activity).toMatchObject([
      {
        phase: "validating",
        message: "Checking evidence",
        timestamp: at(4_000),
      },
    ]);
    await f.writer.record({
      record: "reviewer.activity",
      reviewer_id: "quality::primary",
      data: {
        reviewer_id: "quality::primary",
        phase: "validating",
        at: Date.parse(at(4_000)),
        meaningful_progress: true,
        message: "Checking evidence",
      },
    });
    expect((await project()).reviewers[0]?.activity).toHaveLength(1);
  });

  it("retains terminal authority over late progress and keeps partial result delivery distinct from completion", async () => {
    const f = await fixture(["quality::primary"]);
    await f.resolve();
    await f.start("quality::primary");
    await f.writer.result("quality::primary", result);
    await f.writer.record({
      record: "reviewer.terminal",
      reviewer_id: "quality::primary",
      data: {
        status: "incomplete",
        lens_id: "quality",
        reason: "change_coverage_incomplete",
      },
    });
    await f.event(
      "reviewer.incomplete",
      {
        lens_id: "quality",
        reason: "change_coverage_incomplete",
        failure_stage: "validating",
        attempt_count: 1,
        retryable: false,
        fallback_eligible: true,
        detail_ref: "reviewer.terminal",
        elapsed_ms: 3_000,
      },
      4_000,
      "quality::primary",
    );
    await f.heartbeat("quality::primary", 6_000, "reviewing");
    const normalized = await readNormalizedRun(f.path, { allowActive: true });
    const run = v9DashboardRun(normalized);
    expect(run.reviewers[0]).toMatchObject({
      state: "incomplete",
      phase: "terminal",
      finished_at: at(4_000),
      elapsed_ms: 3_000,
      result: { verdict: "pass" },
      reason: "change_coverage_incomplete",
    });
    expect(run).toMatchObject({
      stage: "consolidate",
      logical_lenses: { incomplete: 1, completed: 0 },
      model_runs: { incomplete: 1, running: 0 },
    });
    expect(v9Status(normalized)).toMatchObject({
      reviewers: [{ status: "incomplete" }],
    });
  });

  it("uses artifact lifecycle milestones and freezes finalized elapsed time", async () => {
    const f = await fixture(["quality::primary"]);
    const project = async () =>
      v9RunSummary(await readNormalizedRun(f.path, { allowActive: true }));
    expect(await project()).toMatchObject({ stage: "resolve_context" });
    await f.writer.record({
      record: "context",
      context: { review_scope: { mode: "full" } },
    });
    expect(await project()).toMatchObject({ stage: "resolve_suite" });
    await f.resolve();
    expect(await project()).toMatchObject({ stage: "execute_lenses" });
    await f.start("quality::primary");
    await f.writer.result("quality::primary", result);
    await f.writer.record({
      record: "reviewer.terminal",
      reviewer_id: "quality::primary",
      data: { status: "completed", lens_id: "quality" },
    });
    await f.event(
      "reviewer.completed",
      {
        lens_id: "quality",
        mode: "full_review",
        verdict: "pass",
        elapsed_ms: 2_000,
        actionable_findings: 0,
        summary: "Complete",
        detail_ref: "reviewer.result",
      },
      3_000,
      "quality::primary",
    );
    expect(await project()).toMatchObject({ stage: "consolidate" });
    await f.writer.finalize({
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
      total_elapsed_ms: 4_000,
      total_lens_summaries: 1,
      lens_summaries: [{ lens_id: "quality", outcome: "passed" }],
      exclusions: [],
      warnings: [],
      deficit_samples: [],
      result_delivery: {
        completed_results: 1,
        artifact: "complete",
        planned_public_stream: "references_only",
      },
    });
    expect(await project()).toMatchObject({
      stage: "complete",
      active: false,
      total_elapsed_ms: 4_000,
      finished_at: at(4_000),
      logical_lenses: { total: 1, completed: 1 },
      model_runs: { total: 1, completed: 1 },
    });
  });

  it("exposes sanitized activity, results, and retry context without leaking private request context", async () => {
    const f = await fixture(["quality::primary"]);
    await f.resolve();
    await f.start("quality::primary");
    await f.writer.record({
      record: "reviewer.attempt",
      reviewer_id: "quality::primary",
      data: {
        attempt: 1,
        started_at: at(1_000),
        elapsed_ms: 1_000,
        failure: {
          reason: "adapter_unavailable",
          message: "Bearer PRIVATE_CREDENTIAL",
          retryable: true,
        },
      },
    });
    await f.start("quality::primary", 3_000, 2);
    await f.writer.record({
      record: "reviewer.activity",
      reviewer_id: "quality::primary",
      data: {
        reviewer_id: "quality::primary",
        phase: "validating",
        at: Date.parse(at(4_000)),
        meaningful_progress: true,
        message: "Read https://example.test/file?q=PRIVATE_QUERY",
      },
    });
    await f.writer.result("quality::primary", {
      ...result,
      summary: "Bearer RESULT_CREDENTIAL",
      review_markdown:
        "https://example.test/result?search=PRIVATE_RESULT_QUERY",
    });
    const run = v9DashboardRun(
      await readNormalizedRun(f.path, { allowActive: true }),
    );
    expect(run.reviewers[0]).toMatchObject({
      attempt: 2,
      attempts: [{ attempt: 1, failure: { retryable: true } }, { attempt: 2 }],
      last_activity_at: at(4_000),
    });
    const encoded = JSON.stringify(run);
    for (const secret of [
      "PRIVATE INSTRUCTIONS",
      "PRIVATE CONTEXT",
      "PRIVATE_CREDENTIAL",
      "RESULT_CREDENTIAL",
      "PRIVATE_QUERY",
      "PRIVATE_RESULT_QUERY",
    ])
      expect(encoded).not.toContain(secret);
    expect(run.context.git.is_repository).toBe(false);
    expect(run.reviewers[0]?.activity).toHaveLength(1);
  });

  it("reads older resolution records and new queued model metadata without inventing an execution mode", async () => {
    const f = await fixture(["quality::primary"]);
    await f.writer.record({
      record: "resolution",
      resolution: {
        reviewers: [
          {
            id: "quality::primary",
            agent_id: "quality",
            model: "future-model",
            adapter: "gateway",
            effort: "high",
            model_index: 0,
            configured_model_index: 2,
            model_count: 1,
          },
        ],
      },
    });
    const detail = v9DashboardRun(
      await readNormalizedRun(f.path, { allowActive: true }),
    );
    expect(detail.reviewers[0]).toMatchObject({
      model: "future-model",
      adapter: "gateway",
      effort: "high",
      configured_model_index: 2,
      state: "queued",
    });
    expect(detail.reviewers[0]).not.toHaveProperty("mode");
    await f.writer.close();
    const records = (await readFile(f.path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    records[0].private_record_versions.resolution = "1";
    const resolution = records.find((record) => record.record === "resolution");
    resolution.schema_version = "1";
    resolution.resolution.reviewers = [
      { id: "quality::primary", agent_id: "quality" },
    ];
    await writeFile(
      f.path,
      records.map((record) => JSON.stringify(record)).join("\n") + "\n",
    );
    expect(
      v9DashboardRun(await readNormalizedRun(f.path, { allowActive: true }))
        .reviewers,
    ).toMatchObject([{ reviewer_id: "quality::primary", state: "queued" }]);
  });

  it("does not count a lens complete when a failed model leaves its pass quorum unsatisfied", async () => {
    const f = await fixture(["quality::primary", "quality::backup"]);
    await f.resolve();
    await f.start("quality::primary");
    await f.writer.result("quality::primary", result);
    await f.writer.record({
      record: "reviewer.terminal",
      reviewer_id: "quality::primary",
      data: { status: "completed", lens_id: "quality" },
    });
    await f.writer.record({
      record: "reviewer.terminal",
      reviewer_id: "quality::backup",
      data: {
        status: "incomplete",
        lens_id: "quality",
        reason: "adapter_unavailable",
      },
    });
    const run = v9DashboardRun(
      await readNormalizedRun(f.path, { allowActive: true }),
    );
    expect(run).toMatchObject({
      logical_lenses: { total: 1, completed: 0, incomplete: 1 },
      model_runs: { completed: 1, incomplete: 1 },
    });
    expect(run.lenses).toEqual([
      {
        lens_id: "quality",
        state: "incomplete",
        reviewer_ids: ["quality::primary", "quality::backup"],
      },
    ]);
  });

  it("tracks a delivered result as finalizing and includes every retry in reviewer elapsed time", async () => {
    const f = await fixture(["quality::primary"]);
    await f.resolve();
    await f.start("quality::primary");
    await f.start("quality::primary", 3_000, 2);
    await f.writer.result("quality::primary", result);
    const pending = v9DashboardRun(
      await readNormalizedRun(f.path, { allowActive: true }),
    );
    expect(pending.reviewers[0]).toMatchObject({
      state: "running",
      phase: "finalizing",
      result: { verdict: "pass" },
    });
    expect(pending.logical_lenses.completed).toBe(0);
    await f.writer.record({
      record: "reviewer.terminal",
      reviewer_id: "quality::primary",
      data: { status: "completed", lens_id: "quality" },
    });
    await f.event(
      "reviewer.completed",
      {
        lens_id: "quality",
        mode: "full_review",
        verdict: "pass",
        elapsed_ms: 1_000,
        actionable_findings: 0,
        summary: "Complete",
        detail_ref: "reviewer.result",
      },
      4_000,
      "quality::primary",
    );
    expect(
      v9DashboardRun(await readNormalizedRun(f.path, { allowActive: true }))
        .reviewers[0],
    ).toMatchObject({
      state: "completed",
      elapsed_ms: 3_000,
      attempts: [{ attempt: 1 }, { attempt: 2, elapsed_ms: 1_000 }],
    });
  });

  it("marks old active artifacts stale without claiming their reviewers finished", async () => {
    const f = await fixture(["quality::primary"]);
    await f.resolve();
    await f.start("quality::primary");
    await f.writer.close();
    await utimes(f.path, new Date(at(2_000)), new Date(at(2_000)));
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(at(10 * 60_000)));
    const run = await readDashboardRun({
      appPaths: f.appPaths,
      runId: "timeline",
    });
    expect(run).toMatchObject({
      active: false,
      stale: true,
      status: "stale",
      stage: "execute_lenses",
      reviewers: [{ state: "running", phase: "reviewing" }],
    });
    expect(run.finished_at).toBeUndefined();
    const snapshot = await readDashboardSnapshot({
      appPaths: f.appPaths,
      server: { host: "127.0.0.1", port: 1, startedAt },
    });
    expect(snapshot.counts.active_runs).toBe(0);
  });

  it("does not reload an indexed artifact excluded by the dashboard snapshot byte budget", async () => {
    const f = await fixture(["quality::primary"]);
    await f.resolve();
    await f.writer.close();
    const normalized = await readNormalizedRun(f.path, { allowActive: true });
    await indexRunArtifact({
      runsDirectory: f.appPaths.runsDirectory,
      runId: "timeline",
      artifact: normalized.artifact,
    });
    const snapshot = await readDashboardSnapshot({
      appPaths: f.appPaths,
      maximumTotalBytes: 1,
      server: { host: "127.0.0.1", port: 1, startedAt },
    });
    expect(snapshot.runs).toHaveLength(1);
    expect(snapshot.runs[0]).toMatchObject({
      run_id: "timeline",
      unreadable: true,
      error: "Run omitted from the bounded dashboard snapshot.",
    });
    await expect(
      resolveRunArtifact("timeline", {
        runsDirectory: f.appPaths.runsDirectory,
        maximumBytes: 1,
      }),
    ).rejects.toThrow(/byte budget/i);
  });
});
