import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { readNormalizedRun, type NormalizedRun } from "./normalize-run.js";
import { resolveRunArtifact } from "./run-index.js";
import {
  dashboardReviewerSummary,
  projectDashboardRun,
  sanitizeDashboardValue,
} from "./dashboard-projection.js";

export async function loadV9Run(
  runsDirectory: string,
  runId: string,
  options: { maximumBytes?: number } = {},
): Promise<NormalizedRun | undefined> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(runId))
    throw new Error("Invalid run ID.");
  const indexed = await lstat(join(runsDirectory, `${runId}.index.json`)).then(
    () => true,
    () => false,
  );
  const candidate = join(runsDirectory, `${runId}.jsonl`);
  if (!indexed) {
    const handle = await open(candidate, "r").catch(() => undefined);
    if (!handle) return undefined;
    try {
      if (
        options.maximumBytes !== undefined &&
        (await handle.stat()).size > options.maximumBytes
      )
        throw new Error("Artifact exceeds the dashboard byte budget.");
      const buffer = Buffer.alloc(4096);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (
        !buffer
          .subarray(0, bytesRead)
          .toString("utf8")
          .startsWith('{"record":"run.artifact"')
      )
        return undefined;
    } finally {
      await handle.close();
    }
    return readNormalizedRun(candidate, { allowActive: true });
  }
  const resolved = await resolveRunArtifact(runId, {
    runsDirectory,
    ...options,
  });
  return readNormalizedRun(resolved.artifact.path, {
    ...(resolved.digest_status === "verified"
      ? { expectedSha256: resolved.artifact.sha256 }
      : {}),
    expectedIdentity: resolved.expected_identity,
    ...(resolved.observed_public_stream
      ? { observedPublicStream: resolved.observed_public_stream }
      : {}),
  });
}
export function v9Headline(run: NormalizedRun): string {
  const counts = run.canonical.counts;
  const title =
    run.run_outcome === "inconclusive"
      ? "Inconclusive"
      : run.run_outcome === "cancelled"
        ? "Cancelled"
        : run.run_outcome === "gate_findings"
          ? "Gate findings"
          : "Clear";
  return `${title}: ${run.coverage_outcome} coverage; ${counts.gate_eligible_subfindings} gate findings; ${counts.non_gating_subfindings} non-gating subfindings; ${run.summary.incomplete_lenses ?? 0} lenses incomplete.`;
}
export function v9Report(run: NormalizedRun) {
  return {
    ...run,
    schema_version: "2",
    kind: "review-mesh.run-report",
    status: run.active
      ? "running"
      : run.run_outcome === "clear"
        ? "passed"
        : run.run_outcome === "gate_findings"
          ? "findings"
          : "incomplete",
    report_path: run.artifact.path,
    total_elapsed_ms: run.summary.total_elapsed_ms,
    logical_lenses: {
      total: run.summary.total_lens_summaries ?? 0,
      incomplete: run.summary.incomplete_lenses ?? 0,
    },
    model_runs: run.summary.model_runs,
    raw_findings: run.canonical.raw,
    findings: run.canonical.atomics,
    roots: run.canonical.roots,
    finding_counts: run.canonical.counts,
    incomplete_lenses: run.reviewers
      .filter((reviewer) => reviewer.status === "incomplete")
      .map((reviewer) => reviewer.lens_id),
    attempts: run.records.filter(
      (record) => record.record === "reviewer.attempt",
    ),
    headline: v9Headline(run),
  };
}
export function v9Status(
  run: NormalizedRun,
  reviewerId?: string,
  details = false,
): Record<string, unknown> {
  const reviewers = run.reviewers.map((reviewer) => ({
    ...reviewer,
    state: reviewer.status,
    complete_result: reviewer.result,
    result_digest: reviewer.digest,
    result_byte_count: reviewer.byte_count,
  }));
  if (reviewerId !== undefined) {
    const reviewer = reviewers.find((item) => item.reviewer_id === reviewerId);
    if (!reviewer) throw new Error("Reviewer not found.");
    return {
      schema_version: "3",
      kind: "review-mesh.run-status",
      run_id: run.run_id,
      ...reviewer,
    };
  }
  if (details)
    return {
      ...v9Report(run),
      schema_version: "3",
      kind: "review-mesh.run-status",
      reviewers,
    };
  const live = projectDashboardRun(run);
  return sanitizeDashboardValue({
    schema_version: "3",
    kind: "review-mesh.run-status",
    run_id: run.run_id,
    terminal: !run.active,
    active: run.active,
    status: run.active ? "running" : run.run_outcome,
    stale: live.stale,
    stage: live.stage,
    started_at: live.started_at,
    updated_at: live.updated_at,
    total_elapsed_ms: live.total_elapsed_ms,
    deadline: live.deadline,
    logical_lenses: live.logical_lenses,
    model_runs: live.model_runs,
    reviewers: live.reviewers.map(dashboardReviewerSummary),
    artifact: run.artifact,
    details_file_policy: "published_at_finalization",
    ...(!run.active
      ? {
          run_outcome: run.run_outcome,
          gate_outcome: run.gate_outcome,
          coverage_outcome: run.coverage_outcome,
          exit_code: run.exit_code,
          change_coverage: run.change_coverage,
          finding_counts: run.canonical.counts,
        }
      : {}),
  });
}
export function v9DashboardRun(run: NormalizedRun, fileUpdatedAt?: string) {
  const report = v9Report(run);
  const live = projectDashboardRun(run, Date.now(), fileUpdatedAt);
  const git = run.context?.git as Record<string, unknown> | undefined;
  const {
    records: _records,
    request: _request,
    resolution: _resolution,
    context: _context,
    ...safeReport
  } = report;
  return sanitizeDashboardValue({
    ...safeReport,
    ...live,
    active: run.active && !live.stale,
    status: live.stale ? "stale" : report.status,
    context: {
      project_name: run.context?.project_name,
      workspace: run.context?.workspace,
      review_scope: run.context?.review_scope,
      git:
        git?.is_repository === true
          ? {
              is_repository: true,
              branch: git.branch,
              head: git.head,
              changed_files_count: Array.isArray(git.changed_files)
                ? git.changed_files.length
                : 0,
            }
          : { is_repository: false },
    },
    schema_version: "2",
    findings: run.canonical.atomics,
    roots: run.canonical.roots,
    activity_notice:
      "Activity is coalesced; complete results are stored in the artifact.",
  });
}
export function v9RunSummary(run: NormalizedRun, updatedAt?: string) {
  const git = run.context?.git as Record<string, unknown> | undefined;
  const live = projectDashboardRun(run, Date.now(), updatedAt);
  return sanitizeDashboardValue({
    run_id: run.run_id,
    active: run.active && !live.stale,
    status: live.stale ? "stale" : run.active ? "running" : run.run_outcome,
    stale: live.stale,
    run_outcome: run.run_outcome,
    gate_outcome: run.gate_outcome,
    coverage_outcome: run.coverage_outcome,
    execution_coverage: run.execution_coverage,
    change_coverage: run.change_coverage,
    updated_at: live.updated_at ?? updatedAt ?? new Date().toISOString(),
    started_at: live.started_at,
    finished_at: live.finished_at,
    stage: live.stage,
    project_name: run.context?.project_name,
    workspace: run.context?.workspace,
    branch: git?.branch,
    changed_files_count: Array.isArray(git?.changed_files)
      ? git.changed_files.length
      : 0,
    scope: (run.context?.review_scope as { mode?: string } | undefined)?.mode,
    total_elapsed_ms: live.total_elapsed_ms,
    findings: run.canonical.counts.atomic_subfindings,
    ...run.canonical.counts,
    logical_lenses: live.logical_lenses,
    lenses: live.lenses,
    model_runs: live.model_runs,
    reviewers: live.reviewers.map(dashboardReviewerSummary),
    deadline: live.deadline,
    artifact: run.artifact,
    digest_status: run.digest_status,
    headline: v9Headline(run),
  });
}
export async function listV9Runs(runsDirectory: string): Promise<string[]> {
  const entries = await readdir(runsDirectory, { withFileTypes: true }).catch(
    () => [],
  );
  return [
    ...new Set(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".index.json"))
        .map((entry) => entry.name.slice(0, -11)),
    ),
  ].sort();
}
