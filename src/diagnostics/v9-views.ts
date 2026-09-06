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
  let candidate = join(runsDirectory, `${runId}.jsonl`);
  if (!indexed) {
    const activeCandidate = `${candidate}.active`;
    let handle = await open(activeCandidate, "r").catch(() => undefined);
    if (handle) candidate = activeCandidate;
    else handle = await open(candidate, "r").catch(() => undefined);
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
    const run = await readNormalizedRun(candidate, { allowActive: true });
    if (candidate === activeCandidate && !run.active) {
      // A sealed staging file has evidence, but publication is not complete.
      run.active = true;
      run.run_outcome = "inconclusive";
      run.coverage_outcome = "partial";
      run.execution_coverage = { status: "partial" };
      run.exit_code = 3;
      run.summary = {
        ...run.summary,
        run_outcome: "inconclusive",
        coverage_outcome: "partial",
        exit_code: 3,
        publication_pending: true,
      };
    }
    return run;
  }
  const resolved = await resolveRunArtifact(runId, {
    runsDirectory,
    ...options,
  });
  const run = await readNormalizedRun(resolved.artifact.path, {
    ...(resolved.digest_status === "verified"
      ? { expectedSha256: resolved.artifact.sha256 }
      : {}),
    expectedIdentity: resolved.expected_identity,
    ...(resolved.observed_public_stream
      ? { observedPublicStream: resolved.observed_public_stream }
      : {}),
    ...(resolved.public_delivery_failure
      ? { publicDeliveryFailure: resolved.public_delivery_failure }
      : {}),
  });
  run.artifact_resolution = resolved.resolution;
  return run;
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

function segmentSummary(record: Record<string, unknown>) {
  const envelope = record.data as Record<string, unknown>;
  const data = envelope.data as Record<string, unknown>;
  return {
    reviewer_id: record.reviewer_id,
    attempt: envelope.attempt,
    segment_id: envelope.segment_id,
    index: envelope.index,
    phase: envelope.phase,
    provenance: "model_reasoning",
    summary: data.summary,
    source_refs: data.source_ranges ?? data.source_refs ?? data.sources ?? [],
    runtime_validation: data.runtime_validation ?? "not_executed",
    scenario_checks: Array.isArray(data.scenario_checks)
      ? data.scenario_checks.slice(0, 8)
      : [],
    unresolved_questions: Array.isArray(data.unresolved_questions)
      ? data.unresolved_questions
      : [],
    resolved_question_ids: Array.isArray(data.resolved_question_ids)
      ? data.resolved_question_ids
      : [],
    follow_up_reads: Array.isArray(data.follow_up_reads)
      ? data.follow_up_reads
      : [],
    follow_up_results: Array.isArray(data.follow_up_results)
      ? data.follow_up_results
      : [],
  };
}
export function v9Report(
  run: NormalizedRun,
  options: { includeRaw?: boolean } = {},
) {
  const {
    records,
    request,
    context,
    resolution,
    snapshot_manifests,
    ...compact
  } = run;
  const liveSegments = new Map(
    projectDashboardRun(run).reviewers.map((reviewer) => [
      reviewer.reviewer_id,
      reviewer.segment,
    ]),
  );
  return {
    ...compact,
    ...(options.includeRaw
      ? { records, request, context, resolution, snapshot_manifests }
      : {}),
    reviewers: run.reviewers.map((reviewer) => ({
      ...reviewer,
      ...(liveSegments.get(reviewer.reviewer_id)
        ? { segment: liveSegments.get(reviewer.reviewer_id) }
        : {}),
      ...(reviewer.coverage
        ? {
            coverage: reviewer.coverage.filter(
              (entry) => entry.relevant === true,
            ),
          }
        : {}),
    })),
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
    incomplete_lenses: [
      ...new Set(
        run.reviewers
          .filter((reviewer) => reviewer.status === "incomplete")
          .map((reviewer) => reviewer.lens_id),
      ),
    ],
    attempts: run.records.filter(
      (record) => record.record === "reviewer.attempt",
    ),
    preflight: records.filter(
      (record) => record.record === "reviewer.preflight",
    ),
    segments: records
      .filter((record) => record.record === "reviewer.segment")
      .map(segmentSummary),
    review_profile: run.summary.review_profile,
    clean_pass_unreachable: run.summary.clean_pass_unreachable ?? [],
    total_clean_pass_unreachable: run.summary.total_clean_pass_unreachable ?? 0,
    quorum_failures: records.filter(
      (record) => record.event === "lens.quorum_unreachable",
    ),
    errors: records.filter((record) => record.record === "run.error"),
    unverified_drafts: records
      .filter((record) => record.record === "reviewer.draft")
      .map((record) => {
        if (options.includeRaw) return record;
        const {
          candidate: _candidate,
          decision: _decision,
          raw_excerpt: _excerpt,
          ...summary
        } = record.data as Record<string, unknown>;
        return { ...record, data: summary };
      }),
    headline: v9Headline(run),
  };
}
export function v9Status(
  run: NormalizedRun,
  reviewerId?: string,
  details = false,
): Record<string, unknown> {
  const projected = projectDashboardRun(run);
  const segments = new Map(
    projected.reviewers.map((reviewer) => [
      reviewer.reviewer_id,
      reviewer.segment,
    ]),
  );
  const reviewers = run.reviewers.map((reviewer) => ({
    ...reviewer,
    ...(segments.get(reviewer.reviewer_id)
      ? { segment: segments.get(reviewer.reviewer_id) }
      : {}),
    state: reviewer.status,
    complete_result: reviewer.result,
    result_digest: reviewer.digest,
    result_byte_count: reviewer.byte_count,
  }));
  if (reviewerId !== undefined) {
    // A running reviewer may have no result/private terminal yet. Its attempts
    // still belong to the configured live roster and must remain inspectable.
    const liveReviewer = projected.reviewers.find(
      (item) => item.reviewer_id === reviewerId,
    );
    const reviewer =
      reviewers.find((item) => item.reviewer_id === reviewerId) ?? liveReviewer;
    if (!reviewer) throw new Error("Reviewer not found.");
    const selected = run.records.filter(
      (record) => record.reviewer_id === reviewerId,
    );
    const attempts = selected.filter(
      (record) => record.record === "reviewer.attempt",
    );
    const data = attempts.map(
      (record) => record.data as Record<string, unknown>,
    );
    const latest = data
      .slice()
      .reverse()
      .find((attempt) => attempt.failure !== undefined);
    const first = data[0],
      last = data.at(-1);
    const timing = {
      total_elapsed_ms: data.reduce(
        (total, attempt) =>
          total +
          (typeof attempt.elapsed_ms === "number" ? attempt.elapsed_ms : 0),
        0,
      ),
      ...(first?.started_at === undefined
        ? {}
        : { started_at: first.started_at }),
      ...(last?.ended_at === undefined ? {} : { ended_at: last.ended_at }),
      ...(last?.elapsed_ms === undefined
        ? {}
        : { latest_attempt_elapsed_ms: last.elapsed_ms }),
    };
    return sanitizeDashboardValue({
      schema_version: "3",
      kind: "review-mesh.run-status",
      run_id: run.run_id,
      ...reviewer,
      ...(liveReviewer?.segment ? { segment: liveReviewer.segment } : {}),
      attempt_count: attempts.length,
      timing,
      ...(latest
        ? {
            latest_failure: {
              ...(latest.failure as Record<string, unknown>),
              attempt: latest.attempt,
              elapsed_ms: latest.elapsed_ms,
              ...(latest.started_at === undefined
                ? {}
                : { started_at: latest.started_at }),
              ...(latest.ended_at === undefined
                ? {}
                : { ended_at: latest.ended_at }),
            },
          }
        : {}),
      ...(details
        ? {
            attempts,
            preflight: selected.filter(
              (record) => record.record === "reviewer.preflight",
            ),
            unverified_drafts: selected
              .filter((record) => record.record === "reviewer.draft")
              .map((record) => {
                const {
                  raw_excerpt: _excerpt,
                  candidate: _candidate,
                  decision: _decision,
                  ...metadata
                } = record.data as Record<string, unknown>;
                return { ...record, data: metadata };
              }),
            segments: selected
              .filter((record) => record.record === "reviewer.segment")
              .map(segmentSummary),
          }
        : {}),
    });
  }
  if (details)
    return {
      ...v9Report(run, { includeRaw: true }),
      schema_version: "3",
      kind: "review-mesh.run-status",
      reviewers,
    };
  const live = projected;
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
    ...(run.public_delivery_failure
      ? { public_delivery_failure: run.public_delivery_failure }
      : {}),
    ...(run.artifact_resolution
      ? { artifact_resolution: run.artifact_resolution }
      : {}),
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
    ...(run.artifact_resolution
      ? { artifact_resolution: run.artifact_resolution }
      : {}),
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
        .filter(
          (entry) =>
            entry.isFile() &&
            (entry.name.endsWith(".index.json") ||
              entry.name.endsWith(".jsonl.active")),
        )
        .map((entry) =>
          entry.name.endsWith(".index.json")
            ? entry.name.slice(0, -11)
            : entry.name.slice(0, -13),
        ),
    ),
  ].sort();
}
