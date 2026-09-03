import { constants } from "node:fs";
import { open, readdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const ACTIVE_SUFFIX = /^\.jsonl\.active(?:\..+)?$/u;
const MAX_STATUS_RECORD_BYTES = 64 * 1024 * 1024;

export class RunStatusError extends Error {
  constructor(
    readonly code: "invalid_run_id" | "run_not_found" | "invalid_run_record",
    message: string,
  ) {
    super(message);
    this.name = "RunStatusError";
  }
}

export interface ReadRunStatusOptions {
  runsDirectory: string;
  runId: string;
  reviewerId?: string;
}

interface ReviewerSnapshot {
  reviewer_id: string;
  lens_id?: string | undefined;
  purpose?: string | undefined;
  adapter?: string | undefined;
  model?: string | undefined;
  provider_group?: string | undefined;
  state:
    | "deferred"
    | "queued"
    | "probing"
    | "starting"
    | "reviewing"
    | "validating"
    | "completed"
    | "incomplete"
    | "skipped";
  attempt?: number | undefined;
  last_event_seq?: number | undefined;
  last_event_at?: string | undefined;
  last_activity_message?: string | undefined;
  elapsed_ms?: number | undefined;
  result?: {
    verdict: "pass" | "fail";
    summary: string;
    actionable_findings: number;
    gate_findings?: number;
    informational_notes: number;
  };
  failure?: Record<string, unknown>;
  skipped?: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function requireSafeRunId(runId: string): void {
  if (!SAFE_RUN_ID.test(runId) || runId === "." || runId === "..") {
    throw new RunStatusError(
      "invalid_run_id",
      "Run id must be a safe single filename component.",
    );
  }
}

function isWithinDirectory(directory: string, target: string): boolean {
  const path = relative(directory, target);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function resolveRunRecord(
  runsDirectory: string,
  runId: string,
): Promise<{ path: string; active: boolean }> {
  const root = await realpath(resolve(runsDirectory)).catch(() => undefined);
  if (root === undefined) {
    throw new RunStatusError("run_not_found", `Run ${runId} was not found.`);
  }
  const names = await readdir(root);
  const finalName = `${runId}.jsonl`;
  const candidates = names.filter(
    (name) =>
      name === finalName ||
      (name.startsWith(runId) && ACTIVE_SUFFIX.test(name.slice(runId.length))),
  );
  const selected = candidates.includes(finalName)
    ? finalName
    : candidates.sort().at(-1);
  if (selected === undefined) {
    throw new RunStatusError("run_not_found", `Run ${runId} was not found.`);
  }
  const path = await realpath(join(root, selected));
  if (!isWithinDirectory(root, path) || basename(path) !== selected) {
    throw new RunStatusError(
      "invalid_run_record",
      "The run record path is unsafe.",
    );
  }
  return { path, active: selected !== finalName };
}

async function readBounded(path: string): Promise<string> {
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > MAX_STATUS_RECORD_BYTES) {
      throw new RunStatusError(
        "invalid_run_record",
        "The run record is unavailable or exceeds the status limit.",
      );
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

function reviewerFor(
  reviewers: Map<string, ReviewerSnapshot>,
  id: string,
): ReviewerSnapshot {
  const current = reviewers.get(id);
  if (current !== undefined) return current;
  const created: ReviewerSnapshot = { reviewer_id: id, state: "queued" };
  reviewers.set(id, created);
  return created;
}

function applyPrivateTerminal(
  reviewers: Map<string, ReviewerSnapshot>,
  record: Record<string, unknown>,
): void {
  const terminal = asRecord(record.terminal);
  const id = text(terminal?.reviewer_id);
  const status = text(terminal?.status);
  if (id === undefined || status === undefined) return;
  const reviewer = reviewerFor(reviewers, id);
  reviewer.lens_id = text(terminal?.lens_id) ?? reviewer.lens_id;
  reviewer.adapter = text(terminal?.adapter) ?? reviewer.adapter;
  reviewer.model = text(terminal?.model) ?? reviewer.model;
  reviewer.provider_group =
    text(terminal?.provider_group) ?? reviewer.provider_group;
  reviewer.elapsed_ms = integer(terminal?.elapsed_ms) ?? reviewer.elapsed_ms;
  if (status === "completed") {
    const result = asRecord(terminal?.result);
    const findings = Array.isArray(result?.actionable_findings)
      ? result.actionable_findings.length
      : 0;
    const notes = Array.isArray(result?.informational_notes)
      ? result.informational_notes.length
      : 0;
    reviewer.state = "completed";
    reviewer.result = {
      verdict: result?.verdict === "fail" ? "fail" : "pass",
      summary: text(result?.summary) ?? "Completed reviewer result.",
      actionable_findings: findings,
      informational_notes: notes,
    };
  } else if (status === "incomplete") {
    reviewer.state = "incomplete";
    reviewer.failure = {
      reason: terminal?.reason,
      message: terminal?.message,
      retryable: terminal?.retryable,
      fallback_eligible: terminal?.fallback_eligible,
      diagnostics: terminal?.diagnostics,
    };
  } else if (status === "skipped") {
    reviewer.state = "skipped";
    reviewer.skipped = {
      reason: terminal?.reason,
      blocked_by_reviewer_id: terminal?.blocked_by_reviewer_id,
      missing_inputs: terminal?.missing_inputs,
    };
  }
}

export async function readRunStatus({
  runsDirectory,
  runId,
  reviewerId,
}: ReadRunStatusOptions): Promise<Record<string, unknown>> {
  requireSafeRunId(runId);
  const location = await resolveRunRecord(runsDirectory, runId);
  const lines = (await readBounded(location.path)).split(/\r?\n/u);
  const reviewers = new Map<string, ReviewerSnapshot>();
  let completed: Record<string, unknown> | undefined;
  let lastSeq = 0;
  let resolvedModelTotal = 0;
  let legacySuite: Record<string, unknown> | undefined;
  for (const [index, encoded] of lines.entries()) {
    if (encoded.trim().length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(encoded);
    } catch {
      if (location.active && index === lines.length - 1) break;
      throw new RunStatusError(
        "invalid_run_record",
        "The persisted run record contains invalid JSON.",
      );
    }
    const event = asRecord(value);
    if (event === undefined) continue;
    if (event.record === "resolution") {
      const resolution = asRecord(event.resolution);
      const roster = Array.isArray(resolution?.reviewers)
        ? resolution.reviewers
        : [];
      resolvedModelTotal = roster.length;
      for (const item of roster) {
        const entry = asRecord(item);
        const id = text(entry?.id);
        if (id === undefined) continue;
        reviewers.set(id, {
          reviewer_id: id,
          ...(text(entry?.agent_id) === undefined
            ? {}
            : { lens_id: text(entry?.agent_id)! }),
          ...(text(entry?.purpose) === undefined
            ? {}
            : { purpose: text(entry?.purpose)! }),
          ...(text(entry?.adapter) === undefined
            ? {}
            : { adapter: text(entry?.adapter)! }),
          ...(text(entry?.model) === undefined
            ? {}
            : { model: text(entry?.model)! }),
          ...(text(entry?.provider_group) === undefined
            ? {}
            : { provider_group: text(entry?.provider_group)! }),
          state: (integer(entry?.model_index) ?? 0) > 0 ? "deferred" : "queued",
        });
      }
      continue;
    }
    if (event.record === "reviewer.terminal") {
      applyPrivateTerminal(reviewers, event);
      continue;
    }
    const eventName = text(event.event);
    if (eventName === undefined) continue;
    lastSeq = Math.max(lastSeq, integer(event.seq) ?? 0);
    const data = asRecord(event.data) ?? {};
    const id = text(event.reviewer_id);
    if (eventName === "suite.resolved") {
      resolvedModelTotal =
        integer(data.model_runs) ?? integer(data.total) ?? resolvedModelTotal;
      continue;
    }
    if (eventName === "run.completed") {
      completed = data;
      legacySuite = asRecord(data.suite);
      const terminals = Array.isArray(data.reviewers) ? data.reviewers : [];
      for (const terminal of terminals) {
        applyPrivateTerminal(reviewers, {
          terminal,
        });
      }
      continue;
    }
    if (eventName === "reviewer.heartbeat" && id !== undefined) {
      const reviewer = reviewerFor(reviewers, id);
      reviewer.state =
        data.phase === "probing" ||
        data.phase === "queued" ||
        data.phase === "starting" ||
        data.phase === "reviewing" ||
        data.phase === "validating"
          ? data.phase
          : reviewer.state;
      reviewer.elapsed_ms = integer(data.elapsed_ms) ?? reviewer.elapsed_ms;
      reviewer.last_activity_message =
        text(data.last_activity_message) ?? reviewer.last_activity_message;
      reviewer.last_event_seq = integer(event.seq);
      reviewer.last_event_at = text(event.timestamp);
      continue;
    }
    if (id === undefined) continue;
    const reviewer = reviewerFor(reviewers, id);
    reviewer.last_event_seq = integer(event.seq);
    reviewer.last_event_at = text(event.timestamp);
    reviewer.lens_id = text(data.lens_id) ?? reviewer.lens_id;
    reviewer.adapter = text(data.adapter) ?? reviewer.adapter;
    reviewer.model = text(data.model) ?? reviewer.model;
    reviewer.provider_group =
      text(data.provider_group) ?? reviewer.provider_group;
    reviewer.elapsed_ms = integer(data.elapsed_ms) ?? reviewer.elapsed_ms;
    if (eventName === "reviewer.started") {
      reviewer.state = "starting";
      reviewer.attempt = integer(data.attempt) ?? (reviewer.attempt ?? 0) + 1;
      reviewer.purpose = text(data.purpose) ?? reviewer.purpose;
    } else if (eventName === "reviewer.progress") {
      const phase = text(data.phase);
      reviewer.state =
        phase === "probing" ||
        phase === "starting" ||
        phase === "reviewing" ||
        phase === "validating" ||
        phase === "queued"
          ? phase
          : reviewer.state;
      reviewer.last_activity_message =
        text(data.message) ?? reviewer.last_activity_message;
    } else if (eventName === "reviewer.completed") {
      reviewer.state = "completed";
      const legacyResult = asRecord(data.result);
      reviewer.result =
        legacyResult === undefined
          ? {
              verdict: data.verdict === "fail" ? "fail" : "pass",
              summary: text(data.summary) ?? "Completed reviewer result.",
              actionable_findings: integer(data.actionable_findings) ?? 0,
              ...(integer(data.gate_findings) === undefined
                ? {}
                : { gate_findings: integer(data.gate_findings)! }),
              informational_notes: integer(data.informational_notes) ?? 0,
            }
          : {
              verdict: legacyResult.verdict === "fail" ? "fail" : "pass",
              summary:
                text(legacyResult.summary) ?? "Completed reviewer result.",
              actionable_findings: Array.isArray(
                legacyResult.actionable_findings,
              )
                ? legacyResult.actionable_findings.length
                : 0,
              informational_notes: Array.isArray(
                legacyResult.informational_notes,
              )
                ? legacyResult.informational_notes.length
                : 0,
            };
    } else if (eventName === "reviewer.incomplete") {
      reviewer.state = "incomplete";
      reviewer.failure = {
        reason: data.reason,
        message: data.message,
        retryable: data.retryable,
        fallback_eligible: data.fallback_eligible,
        diagnostics: data.diagnostics,
      };
    } else if (eventName === "reviewer.skipped") {
      reviewer.state = "skipped";
      reviewer.skipped = {
        reason: data.reason,
        blocked_by_reviewer_id: data.blocked_by_reviewer_id,
        missing_inputs: data.missing_inputs,
      };
    }
  }

  const values = [...reviewers.values()];
  const selected =
    reviewerId === undefined
      ? values
      : values.filter((reviewer) => reviewer.reviewer_id === reviewerId);
  const modelRuns = asRecord(completed?.model_runs) ??
    legacySuite ?? {
      total: Math.max(resolvedModelTotal, values.length),
      deferred: values.filter((reviewer) => reviewer.state === "deferred")
        .length,
      queued: values.filter((reviewer) => reviewer.state === "queued").length,
      running: values.filter((reviewer) =>
        ["probing", "starting", "reviewing", "validating"].includes(
          reviewer.state,
        ),
      ).length,
      completed: values.filter((reviewer) => reviewer.state === "completed")
        .length,
      incomplete: values.filter((reviewer) => reviewer.state === "incomplete")
        .length,
      skipped: values.filter((reviewer) => reviewer.state === "skipped").length,
      skip_reasons: {},
    };
  const gateOutcome =
    text(completed?.gate_outcome) ??
    (values.some((reviewer) => (reviewer.result?.actionable_findings ?? 0) > 0)
      ? "findings"
      : "no_findings");
  const coverageOutcome =
    text(completed?.coverage_outcome) ??
    (values.some((reviewer) => reviewer.state === "incomplete")
      ? "partial"
      : "complete");
  const legacyStatus = text(completed?.status);
  const status =
    completed === undefined
      ? "running"
      : (legacyStatus ??
        (coverageOutcome === "partial"
          ? "incomplete"
          : gateOutcome === "findings"
            ? "findings"
            : "passed"));
  return {
    schema_version: "2",
    kind: "review-mesh.run-status",
    run_id: runId,
    active: completed === undefined && location.active,
    status,
    gate_outcome: gateOutcome,
    coverage_outcome: coverageOutcome,
    ...(integer(completed?.exit_code) === undefined
      ? {}
      : { exit_code: integer(completed?.exit_code)! }),
    ...(integer(completed?.total_elapsed_ms) === undefined
      ? {}
      : { total_elapsed_ms: integer(completed?.total_elapsed_ms)! }),
    logical_lenses: asRecord(completed?.logical_lenses),
    model_runs: modelRuns,
    suite: modelRuns,
    reviewers: selected,
    ...(reviewerId === undefined ? {} : { reviewer_id: reviewerId }),
    last_seq: lastSeq,
  };
}
