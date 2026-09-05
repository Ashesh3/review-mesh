import { sanitizeRunMetadata } from "../results/sanitize.js";
import type { NormalizedRun } from "./normalize-run.js";

const MAX_ACTIVITY = 2_000;
const MAX_EVENTS = 2_000;
const terminalStates = new Set(["completed", "incomplete", "skipped"]);
const phases = new Set([
  "deferred",
  "queued",
  "probing",
  "starting",
  "reviewing",
  "validating",
  "continuing",
  "retry_backoff",
  "finalizing",
  "terminal",
]);

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}
function timestamp(value: unknown): string | undefined {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? value
    : undefined;
}
function iso(value: unknown): string | undefined {
  const milliseconds = count(value);
  return milliseconds !== undefined && milliseconds <= 8.64e15
    ? new Date(milliseconds).toISOString()
    : undefined;
}
function later(left?: string, right?: string): string | undefined {
  return !left || (right && Date.parse(right) > Date.parse(left))
    ? right
    : left;
}

/** Keep full accepted results, but never export request bodies or URL search values. */
export function sanitizeDashboardValue<T>(value: T): T {
  const visit = (child: unknown, depth: number): unknown => {
    if (depth > 24) return "[truncated]";
    if (typeof child === "string")
      return (sanitizeRunMetadata(child) as string).replace(
        /(https?:\/\/[^\s?#]+)\?[^\s#]*/giu,
        "$1?[redacted]",
      );
    if (Array.isArray(child))
      return child.map((entry) => visit(entry, depth + 1));
    const record = object(child);
    if (!record) return child;
    return Object.fromEntries(
      Object.entries(record).map(([key, entry]) => [
        key,
        /token|secret|password|authorization|api[_-]?key/iu.test(key) ||
        /^(?:instructions?|caller_context|runtime|command|args|endpoint|base_url)$/iu.test(
          key,
        )
          ? "[redacted]"
          : visit(entry, depth + 1),
      ]),
    );
  };
  return visit(value, 0) as T;
}

export interface DashboardReviewer extends Record<string, unknown> {
  id: string;
  reviewer_id: string;
  lens_id: string;
  state: string;
  status: string;
  phase: string;
  model_index: number;
  configured_model_index: number;
  model_count: number;
  started_at?: string;
  finished_at?: string;
  elapsed_ms?: number;
  last_activity_at?: string;
  last_activity_message?: string;
  attempt?: number;
  result?: Record<string, unknown>;
  activity: Record<string, unknown>[];
  attempts: Record<string, unknown>[];
}

/** Dashboard-only live projection; report/status outcomes remain normalized by their existing contracts. */
export function projectDashboardRun(
  run: NormalizedRun,
  now = Date.now(),
  fileUpdatedAt?: string,
) {
  const roster = new Map<string, DashboardReviewer>();
  const groups = new Map<string, DashboardReviewer[]>();
  const policies = new Map<string, Record<string, unknown>>();
  const phaseTimes = new Map<string, number>();
  const terminalIds = new Set<string>();
  let updatedAt: string | undefined;
  let startedAt: string | undefined;
  let heartbeatElapsed: number | undefined;
  let suiteData: Record<string, unknown> | undefined;
  let contextResolved = run.context !== undefined;
  let suiteResolved = false;
  let consolidating = false;

  const ensure = (id: string, lensId = id.split("::")[0]!) => {
    let reviewer = roster.get(id);
    if (reviewer) return reviewer;
    const members = groups.get(lensId) ?? [];
    const index = members.length;
    reviewer = {
      id,
      reviewer_id: id,
      lens_id: lensId,
      state: index === 0 ? "queued" : "deferred",
      status: index === 0 ? "queued" : "deferred",
      phase: index === 0 ? "queued" : "deferred",
      model_index: index,
      configured_model_index: index,
      model_count: index + 1,
      activity: [],
      attempts: [],
    };
    roster.set(id, reviewer);
    members.push(reviewer);
    for (const member of members) member.model_count = members.length;
    groups.set(lensId, members);
    return reviewer;
  };
  const setPhase = (
    reviewer: DashboardReviewer,
    phase: unknown,
    at?: string,
  ) => {
    if (
      terminalIds.has(reviewer.id) ||
      typeof phase !== "string" ||
      !phases.has(phase) ||
      phase === "terminal"
    )
      return;
    const time = at ? Date.parse(at) : 0;
    if (time < (phaseTimes.get(reviewer.id) ?? 0)) return;
    phaseTimes.set(reviewer.id, time);
    reviewer.phase = phase;
    reviewer.state = reviewer.status =
      phase === "queued" || phase === "deferred" ? phase : "running";
  };
  const activityAt = (
    reviewer: DashboardReviewer,
    at?: string,
    message?: string,
  ) => {
    const latest = later(reviewer.last_activity_at, at);
    if (latest !== undefined) reviewer.last_activity_at = latest;
    if (message && latest === at) reviewer.last_activity_message = message;
  };
  const addActivity = (
    reviewer: DashboardReviewer,
    entry: Record<string, unknown>,
  ) => {
    const duplicate = reviewer.activity.find(
      (existing) =>
        existing.timestamp === entry.timestamp &&
        existing.phase === entry.phase &&
        existing.message === entry.message,
    );
    if (duplicate) Object.assign(duplicate, entry);
    else reviewer.activity.push(entry);
    if (reviewer.activity.length > MAX_ACTIVITY) reviewer.activity.shift();
  };
  const attempt = (reviewer: DashboardReviewer, number: number) => {
    reviewer.attempt = Math.max(reviewer.attempt ?? 0, number);
    let item = reviewer.attempts.find((entry) => entry.attempt === number);
    if (!item) {
      item = { attempt: number };
      reviewer.attempts.push(item);
    }
    return item;
  };
  const finish = (
    reviewer: DashboardReviewer,
    state: string,
    data: Record<string, unknown>,
    at?: string,
  ) => {
    terminalIds.add(reviewer.id);
    reviewer.state = reviewer.status = state;
    reviewer.phase = "terminal";
    for (const key of ["reason", "mode", "verdict", "summary", "failure_stage"])
      if (text(data[key])) reviewer[key] = data[key];
    if (at) {
      reviewer.finished_at = at;
      activityAt(reviewer, at, text(data.message) ?? text(data.summary));
    }
    if (count(data.elapsed_ms) !== undefined)
      reviewer.elapsed_ms = count(data.elapsed_ms)!;
    if (count(data.attempt_count) !== undefined)
      reviewer.attempt = count(data.attempt_count)!;
    if (data.change_coverage) reviewer.change_coverage = data.change_coverage;
    if (state === "incomplete")
      reviewer.failure = { ...object(reviewer.failure), ...data };
    if (state === "skipped") reviewer.skipped = data;
    if (reviewer.attempt)
      Object.assign(attempt(reviewer, reviewer.attempt), {
        status: state,
        ...(count(data.elapsed_ms) !== undefined
          ? { elapsed_ms: count(data.elapsed_ms) }
          : {}),
        ...(at ? { finished_at: at } : {}),
      });
  };

  for (const value of Array.isArray(run.resolution?.reviewers)
    ? run.resolution.reviewers
    : []) {
    const configured = object(value);
    const id = text(configured?.id);
    if (!configured || !id) continue;
    const reviewer = ensure(
      id,
      text(configured.agent_id) ?? id.split("::")[0]!,
    );
    for (const key of [
      "purpose",
      "adapter",
      "model",
      "effort",
      "provider_group",
      "isolation",
    ])
      if (text(configured[key])) reviewer[key] = configured[key];
    for (const key of [
      "model_index",
      "configured_model_index",
      "model_count",
      "timeout_ms",
    ])
      if (count(configured[key]) !== undefined) reviewer[key] = configured[key];
    const mode = text(object(configured.policy)?.mode);
    const policy = object(configured.policy);
    if (policy && !policies.has(reviewer.lens_id))
      policies.set(reviewer.lens_id, policy);
    if (mode) reviewer.mode = mode;
  }
  for (const record of run.records) {
    const at = timestamp(record.timestamp);
    updatedAt = later(updatedAt, at);
    const data = object(record.data) ?? {};
    if (record.event === "run.started") startedAt ??= at;
    if (record.event === "context.resolved") contextResolved = true;
    if (record.event === "suite.resolved") {
      suiteResolved = true;
      suiteData = data;
    }
    if (record.record === "run.findings") consolidating = true;
    if (record.event === "suite.heartbeat") {
      heartbeatElapsed = count(data.elapsed_ms) ?? heartbeatElapsed;
      for (const value of Array.isArray(data.active) ? data.active : []) {
        const entry = object(value);
        const id = text(entry?.reviewer_id);
        if (!entry || !id) continue;
        const reviewer = ensure(id, text(entry.lens_id));
        if (terminalIds.has(id)) continue;
        setPhase(reviewer, entry.phase, at);
        if (text(entry.mode)) reviewer.mode = entry.mode;
        if (count(entry.attempt)) attempt(reviewer, count(entry.attempt)!);
        for (const key of [
          "maximum_attempts",
          "attempt_elapsed_ms",
          "lens_elapsed_ms",
          "last_progress_age_ms",
          "coalesced_activity_count",
          "run_deadline_remaining_ms",
          "lens_deadline_remaining_ms",
          "attempt_deadline_remaining_ms",
          "queue_wait_ms",
          "probe_elapsed_ms",
        ])
          if (count(entry[key]) !== undefined) reviewer[key] = entry[key];
        for (const key of ["admitted_at", "queue_reason"])
          if (entry[key] !== undefined) reviewer[key] = entry[key];
        if (at && count(entry.last_progress_age_ms) !== undefined)
          activityAt(
            reviewer,
            iso(
              Math.max(0, Date.parse(at) - count(entry.last_progress_age_ms)!),
            ),
          );
      }
      continue;
    }
    const id = text(record.reviewer_id);
    if (!id) continue;
    const reviewer = ensure(id, text(data.lens_id));
    if (record.record === "reviewer.terminal") {
      if (typeof data.status === "string" && terminalStates.has(data.status))
        finish(reviewer, data.status, data);
    } else if (
      record.event === "reviewer.completed" ||
      record.event === "reviewer.incomplete" ||
      record.event === "reviewer.skipped"
    ) {
      const status = record.event.slice("reviewer.".length);
      // A public lifecycle event can add timing, but cannot replace the private terminal outcome.
      finish(reviewer, terminalIds.has(id) ? reviewer.state : status, data, at);
    } else if (record.event === "reviewer.started") {
      if (terminalIds.has(id)) continue;
      for (const key of [
        "adapter",
        "model",
        "provider_group",
        "mode",
        "maximum_attempts",
        "timeout_ms",
        "progress_observable",
        "proof",
        "admitted_at",
        "queue_wait_ms",
        "probe_elapsed_ms",
      ])
        if (data[key] !== undefined) reviewer[key] = data[key];
      if (at) {
        reviewer.started_at ??= at;
        activityAt(reviewer, at);
      }
      if (count(data.attempt))
        Object.assign(attempt(reviewer, count(data.attempt)!), {
          started_at: at,
          status: "running",
        });
      setPhase(reviewer, "reviewing", at);
      delete reviewer.queue_reason;
    } else if (
      record.event === "reviewer.progress" ||
      record.event === "reviewer.heartbeat"
    ) {
      if (terminalIds.has(id)) continue;
      setPhase(reviewer, data.phase, at);
      for (const key of ["queued_at", "queue_reason"])
        if (data[key] !== undefined) reviewer[key] = data[key];
      if (text(data.mode)) reviewer.mode = data.mode;
      if (count(data.attempt)) attempt(reviewer, count(data.attempt)!);
      if (count(data.maximum_attempts))
        reviewer.maximum_attempts = data.maximum_attempts;
      if (record.event === "reviewer.progress") {
        activityAt(reviewer, at, text(data.message));
        addActivity(reviewer, {
          ...data,
          reviewer_id: id,
          event: record.event,
          seq: record.seq,
          ...(at ? { timestamp: at, at: Date.parse(at) } : {}),
        });
      }
    } else if (record.record === "reviewer.attempt") {
      if (count(data.attempt))
        Object.assign(attempt(reviewer, count(data.attempt)!), data, {
          status: data.failure ? "incomplete" : "completed",
        });
      if (!terminalIds.has(id)) reviewer.failure = data.failure;
    } else if (record.record === "reviewer.activity") {
      const activityTime = iso(data.at);
      addActivity(reviewer, {
        ...data,
        ...(activityTime ? { timestamp: activityTime } : {}),
      });
      activityAt(reviewer, activityTime, text(data.message));
      setPhase(reviewer, data.phase, activityTime);
    } else if (record.record === "reviewer.activity_summary") {
      reviewer.activity_summary = data;
      activityAt(reviewer, iso(data.last_progress_at));
    }
  }
  for (const normalized of run.reviewers) {
    const reviewer = ensure(normalized.reviewer_id, normalized.lens_id);
    if (normalized.terminal || !run.active)
      finish(reviewer, normalized.status, normalized.terminal ?? {});
    else if (!terminalIds.has(reviewer.id))
      setPhase(reviewer, "finalizing", updatedAt);
    if (normalized.result) {
      reviewer.result = normalized.result as unknown as Record<string, unknown>;
      reviewer.verdict = normalized.result.verdict;
      reviewer.actionable_findings =
        normalized.result.actionable_findings.length;
      if (normalized.result.schema_version === "4")
        reviewer.change_coverage = normalized.result.change_coverage;
    }
    if (normalized.digest) reviewer.result_digest = normalized.digest;
    if (normalized.byte_count !== undefined)
      reviewer.result_byte_count = normalized.byte_count;
    if (normalized.coverage) reviewer.coverage = normalized.coverage;
    if (normalized.reason) reviewer.reason = normalized.reason;
  }
  const selectedDeadline =
    object(run.summary.deadline) ??
    object(run.resolution?.deadline) ??
    object(suiteData?.deadline);
  startedAt ??= timestamp(selectedDeadline?.started_at);
  const lastUpdate = later(updatedAt, timestamp(fileUpdatedAt));
  const heartbeatInterval =
    count(object(run.resolution?.execution)?.heartbeat_interval_ms) ?? 15_000;
  const stale =
    run.active &&
    lastUpdate !== undefined &&
    now - Date.parse(lastUpdate) > Math.max(120_000, heartbeatInterval * 3);
  const observedNow = stale ? Date.parse(lastUpdate!) : now;
  const totalElapsed = run.active
    ? Math.max(
        heartbeatElapsed ?? 0,
        startedAt ? observedNow - Date.parse(startedAt) : 0,
      )
    : count(run.summary.total_elapsed_ms);
  const finishedAt =
    !run.active && startedAt && totalElapsed !== undefined
      ? iso(Date.parse(startedAt) + totalElapsed)
      : undefined;
  const reviewers = [...roster.values()];
  for (const reviewer of reviewers) {
    if (reviewer.started_at && !terminalIds.has(reviewer.id))
      reviewer.elapsed_ms = Math.max(
        0,
        observedNow - Date.parse(reviewer.started_at),
      );
    else if (reviewer.started_at && reviewer.finished_at)
      reviewer.elapsed_ms = Math.max(
        0,
        Date.parse(reviewer.finished_at) - Date.parse(reviewer.started_at),
      );
    reviewer.attempts.sort((a, b) => Number(a.attempt) - Number(b.attempt));
    if (reviewer.last_activity_at)
      reviewer.last_progress_age_ms = Math.max(
        0,
        observedNow - Date.parse(reviewer.last_activity_at),
      );
    const coverage = reviewer.change_coverage as
      Record<string, unknown> | undefined;
    if (coverage) {
      reviewer.successful_files = count(coverage.inspected_count) ?? 0;
      reviewer.required_files =
        (count(coverage.inspected_count) ?? 0) +
        (count(coverage.deficit_count) ?? 0);
    }
    reviewer.finalization_count = reviewer.activity.filter(
      (item) => item.phase === "finalizing",
    ).length;
    reviewer.repair_count = reviewer.activity.filter((item) =>
      /repair/i.test(String(item.message ?? "")),
    ).length;
  }
  const modelRuns = {
    total: reviewers.length,
    running: 0,
    queued: 0,
    deferred: 0,
    completed: 0,
    incomplete: 0,
    skipped: 0,
  };
  for (const reviewer of reviewers)
    if (reviewer.state in modelRuns)
      modelRuns[reviewer.state as Exclude<keyof typeof modelRuns, "total">]++;
  const logicalLenses = {
    total: groups.size,
    running: 0,
    queued: 0,
    completed: 0,
    incomplete: 0,
    skipped: 0,
  };
  const outcomes = new Map(
    (Array.isArray(run.summary.lens_summaries)
      ? run.summary.lens_summaries
      : []
    ).flatMap((value) => {
      const lens = object(value);
      return text(lens?.lens_id)
        ? [[text(lens!.lens_id)!, text(lens!.outcome)] as const]
        : [];
    }),
  );
  const lenses: Array<{
    lens_id: string;
    state: Exclude<keyof typeof logicalLenses, "total">;
    reviewer_ids: string[];
  }> = [];
  for (const [id, members] of groups) {
    const outcome = outcomes.get(id);
    let state: Exclude<keyof typeof logicalLenses, "total">;
    if (outcome === "passed" || outcome === "findings") state = "completed";
    else if (outcome === "incomplete" || outcome === "not_evaluated")
      state = "incomplete";
    else if (outcome === "not_applicable") state = "skipped";
    else if (members.some((reviewer) => reviewer.state === "running"))
      state = "running";
    else if (members.some((reviewer) => !terminalIds.has(reviewer.id)))
      state = "queued";
    else {
      const policy = policies.get(id);
      const completed = members.filter(
        (reviewer) => reviewer.state === "completed",
      );
      const adjudicated = completed.some(
        (reviewer) => reviewer.result?.schema_version === "2",
      );
      const findings = completed.some(
        (reviewer) => reviewer.result?.verdict === "fail",
      );
      const passes = completed.filter(
        (reviewer) => reviewer.result?.verdict === "pass",
      );
      const providerGroups = new Set(
        passes
          .map(
            (reviewer) =>
              text(reviewer.provider_group) ?? text(reviewer.adapter),
          )
          .filter((provider) => provider !== undefined),
      );
      const passQuorum = count(policy?.passQuorum) ?? members.length;
      const providerQuorum = count(policy?.minimumProviderGroups) ?? 1;
      const skippedAfterSuccess = members.some(
        (reviewer) =>
          reviewer.reason === "not_needed_after_quorum" ||
          reviewer.reason === "short_circuited_after_finding",
      );
      if (
        adjudicated ||
        (findings && policy?.adjudication !== "required") ||
        skippedAfterSuccess ||
        (passes.length >= passQuorum &&
          (providerQuorum <= 1 || providerGroups.size >= providerQuorum))
      )
        state = "completed";
      else if (
        members.every(
          (reviewer) =>
            reviewer.state === "skipped" &&
            reviewer.reason === "not_applicable",
        )
      )
        state = "skipped";
      else state = "incomplete";
    }
    logicalLenses[state]++;
    lenses.push({
      lens_id: id,
      state,
      reviewer_ids: members.map((reviewer) => reviewer.id),
    });
  }
  if (count(run.summary.total_lens_summaries) !== undefined)
    logicalLenses.total = Math.max(
      groups.size,
      count(run.summary.total_lens_summaries)!,
    );
  const stage = !run.active
    ? "complete"
    : consolidating ||
        (suiteResolved &&
          reviewers.every((reviewer) => terminalIds.has(reviewer.id)))
      ? "consolidate"
      : suiteResolved || reviewers.some((reviewer) => reviewer.started_at)
        ? "execute_lenses"
        : contextResolved
          ? "resolve_suite"
          : "resolve_context";
  const events = run.records.filter(
    (record) => typeof record.event === "string",
  );
  return {
    stage,
    stale,
    started_at: startedAt,
    finished_at: finishedAt,
    updated_at: later(lastUpdate, finishedAt),
    total_elapsed_ms: totalElapsed,
    deadline: selectedDeadline,
    logical_lenses: logicalLenses,
    lenses,
    model_runs: modelRuns,
    reviewers,
    events: events
      .slice(-MAX_EVENTS)
      .map(({ event, seq, timestamp, reviewer_id, data }) => ({
        event,
        seq,
        timestamp,
        reviewer_id,
        data,
      })),
    omitted_events: Math.max(0, events.length - MAX_EVENTS),
  };
}

export function dashboardReviewerSummary(reviewer: DashboardReviewer) {
  const {
    result: _result,
    activity: _activity,
    attempts: _attempts,
    coverage: _coverage,
    failure: _failure,
    skipped: _skipped,
    activity_summary: _activitySummary,
    ...summary
  } = reviewer;
  return summary;
}
