import { constants } from "node:fs";
import { open, readdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import {
  publicEventSchema,
  type PublicEvent,
  type ReviewerTerminalRecord,
} from "../protocol/schemas.js";

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_STATUS_RECORD_BYTES = 16 * 1024 * 1024;
const ACTIVE_SUFFIX = /^\.jsonl\.active(?:\..+)?$/;

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

interface ResolutionReviewer {
  id: string;
  agentId?: string;
  modelIndex?: number;
  previousReviewerId?: string;
  purpose?: string;
  adapter?: string;
  model?: string;
}

interface ParsedRunRecord {
  resolution?: { reviewers: ResolutionReviewer[] };
  events: PublicEvent[];
}

interface RunRecordPath {
  path: string;
  active: boolean;
}

interface ReviewerStatusSnapshot {
  reviewer_id: string;
  purpose?: string;
  adapter?: string;
  model?: string;
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
  last_event_seq?: number;
  last_event_at?: string;
  last_activity_message?: string;
  attempt?: number;
  elapsed_ms?: number;
  isolation?: string;
  result?: {
    verdict: "pass" | "fail";
    summary: string;
    actionable_findings: number;
    informational_notes: number;
  };
  failure?: { reason: string; message: string; retryable: boolean };
  skipped?: { reason: string; blocked_by_reviewer_id: string };
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseResolutionReviewer(
  value: unknown,
): ResolutionReviewer | undefined {
  const record = asRecord(value);
  if (record === undefined || typeof record.id !== "string") return undefined;
  return {
    id: record.id,
    ...(typeof record.agent_id === "string"
      ? { agentId: record.agent_id }
      : {}),
    ...(typeof record.model_index === "number"
      ? { modelIndex: record.model_index }
      : {}),
    ...(typeof record.previous_reviewer_id === "string"
      ? { previousReviewerId: record.previous_reviewer_id }
      : {}),
    ...(typeof record.purpose === "string" ? { purpose: record.purpose } : {}),
    ...(typeof record.adapter === "string" ? { adapter: record.adapter } : {}),
    ...(typeof record.model === "string" ? { model: record.model } : {}),
  };
}

function normalizeLegacyPublicEvent(value: unknown): unknown {
  const record = asRecord(value);
  if (
    record === undefined ||
    (record.schema_version !== "2" && record.schema_version !== "3")
  ) {
    return value;
  }
  const normalized = structuredClone(record);
  normalized.schema_version = "4";
  const data = asRecord(normalized.data);
  if (data === undefined) return normalized;
  if (normalized.event === "suite.resolved" && Array.isArray(data.reviewers)) {
    data.reviewers = data.reviewers.map((reviewer) => {
      const item = asRecord(reviewer);
      if (item === undefined || typeof item.id !== "string") return reviewer;
      return {
        ...item,
        agent_id: item.id,
        model_index: 0,
        model_count: 1,
        activation: "immediate",
      };
    });
  }
  if (
    normalized.event === "reviewer.heartbeat" ||
    normalized.event === "run.completed"
  ) {
    const suite = asRecord(data.suite);
    if (suite !== undefined) {
      suite.deferred ??= 0;
      suite.skipped ??= 0;
    }
  }
  return normalized;
}

function parseRunRecord(
  text: string,
  expectedRunId: string,
  allowPartialTail: boolean,
): ParsedRunRecord {
  const events: PublicEvent[] = [];
  let resolution: ParsedRunRecord["resolution"];
  const lines = text.split(/\r?\n/u);
  for (const [index, encoded] of lines.entries()) {
    if (encoded.trim().length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(encoded);
    } catch {
      if (allowPartialTail && index === lines.length - 1) break;
      throw new RunStatusError(
        "invalid_run_record",
        "The persisted run record contains invalid JSON.",
      );
    }
    const record = asRecord(value);
    if (record?.record === "resolution" && record.run_id === expectedRunId) {
      const resolved = asRecord(record.resolution);
      const reviewers = Array.isArray(resolved?.reviewers)
        ? resolved.reviewers
            .map(parseResolutionReviewer)
            .filter(
              (reviewer): reviewer is ResolutionReviewer =>
                reviewer !== undefined,
            )
        : [];
      resolution = { reviewers };
      continue;
    }
    const event = publicEventSchema.safeParse(
      normalizeLegacyPublicEvent(value),
    );
    if (!event.success || event.data.run_id !== expectedRunId) {
      throw new RunStatusError(
        "invalid_run_record",
        "The persisted run record contains an invalid public event.",
      );
    }
    events.push(event.data);
  }
  return { ...(resolution === undefined ? {} : { resolution }), events };
}

function applyTerminalRecord(
  reviewer: ReviewerStatusSnapshot,
  record: ReviewerTerminalRecord,
): void {
  reviewer.adapter = record.adapter;
  reviewer.model = record.model;
  reviewer.elapsed_ms = record.elapsed_ms;
  if (record.status === "completed") {
    reviewer.state = "completed";
    reviewer.isolation = record.isolation;
    reviewer.result = {
      verdict: record.result.verdict,
      summary: record.result.summary,
      actionable_findings: record.result.actionable_findings.length,
      informational_notes: record.result.informational_notes.length,
    };
    delete reviewer.failure;
    delete reviewer.skipped;
    return;
  }
  if (record.status === "incomplete") {
    reviewer.state = "incomplete";
    if (record.isolation !== undefined) reviewer.isolation = record.isolation;
    reviewer.failure = {
      reason: record.reason,
      message: record.message,
      retryable: record.retryable,
    };
    delete reviewer.result;
    delete reviewer.skipped;
    return;
  }
  reviewer.state = "skipped";
  reviewer.skipped = {
    reason: record.reason,
    blocked_by_reviewer_id: record.blocked_by_reviewer_id,
  };
  delete reviewer.result;
  delete reviewer.failure;
  delete reviewer.isolation;
}

function updateReviewer(
  reviewer: ReviewerStatusSnapshot,
  event: PublicEvent,
): void {
  reviewer.last_event_seq = event.seq;
  reviewer.last_event_at = event.timestamp;
  if (event.event === "reviewer.progress") {
    reviewer.state =
      event.data.phase === "terminal" ? "validating" : event.data.phase;
    if (event.data.message !== undefined) {
      reviewer.last_activity_message = event.data.message;
    }
  } else if (event.event === "reviewer.started") {
    reviewer.state = "starting";
    reviewer.attempt = (reviewer.attempt ?? 0) + 1;
    reviewer.purpose ??= event.data.purpose;
    reviewer.adapter ??= event.data.adapter;
    reviewer.model ??= event.data.model;
  } else if (event.event === "reviewer.heartbeat") {
    reviewer.state =
      event.data.phase === "terminal" ? "validating" : event.data.phase;
    reviewer.elapsed_ms = event.data.elapsed_ms;
    if (event.data.last_activity_message !== undefined) {
      reviewer.last_activity_message = event.data.last_activity_message;
    }
    if (event.data.isolation !== undefined)
      reviewer.isolation = event.data.isolation;
  } else if (event.event === "reviewer.completed") {
    reviewer.state = "completed";
    reviewer.adapter = event.data.adapter;
    reviewer.model = event.data.model;
    reviewer.elapsed_ms = event.data.elapsed_ms;
    reviewer.isolation = event.data.isolation;
    reviewer.result = {
      verdict: event.data.result.verdict,
      summary: event.data.result.summary,
      actionable_findings: event.data.result.actionable_findings.length,
      informational_notes: event.data.result.informational_notes.length,
    };
    delete reviewer.failure;
  } else if (event.event === "reviewer.incomplete") {
    reviewer.state = "incomplete";
    reviewer.adapter = event.data.adapter;
    reviewer.model = event.data.model;
    reviewer.elapsed_ms = event.data.elapsed_ms;
    if (event.data.isolation !== undefined)
      reviewer.isolation = event.data.isolation;
    reviewer.failure = {
      reason: event.data.reason,
      message: event.data.message,
      retryable: event.data.retryable,
    };
    delete reviewer.result;
    delete reviewer.skipped;
  } else if (event.event === "reviewer.skipped") {
    reviewer.state = "skipped";
    reviewer.adapter = event.data.adapter;
    reviewer.model = event.data.model;
    reviewer.elapsed_ms = event.data.elapsed_ms;
    reviewer.skipped = {
      reason: event.data.reason,
      blocked_by_reviewer_id: event.data.blocked_by_reviewer_id,
    };
    delete reviewer.result;
    delete reviewer.failure;
  }
}

async function resolveRunRecordPath(
  runsDirectory: string,
  runId: string,
): Promise<RunRecordPath> {
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
  const path = join(root, selected);
  const canonical = await realpath(path);
  if (!isWithinDirectory(root, canonical) || basename(canonical) !== selected) {
    throw new RunStatusError(
      "invalid_run_record",
      "The persisted run record path is unsafe.",
    );
  }
  return { path: canonical, active: selected !== finalName };
}

async function readBoundedFile(path: string, active: boolean): Promise<string> {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(path, flags);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > MAX_STATUS_RECORD_BYTES) {
      throw new RunStatusError(
        "invalid_run_record",
        "The persisted run record is unavailable or exceeds the status limit.",
      );
    }
    const text = await handle.readFile("utf8");
    const current = await handle.stat();
    if (
      !active &&
      (current.size !== metadata.size || current.mtimeMs !== metadata.mtimeMs)
    ) {
      throw new RunStatusError(
        "invalid_run_record",
        "The completed run record changed while status was being read.",
      );
    }
    return text;
  } finally {
    await handle.close();
  }
}

export async function readRunStatus({
  runsDirectory,
  runId,
  reviewerId,
}: ReadRunStatusOptions): Promise<Record<string, unknown>> {
  requireSafeRunId(runId);
  const recordPath = await resolveRunRecordPath(runsDirectory, runId);
  const record = parseRunRecord(
    await readBoundedFile(recordPath.path, recordPath.active),
    runId,
    recordPath.active,
  );
  const reviewers = new Map<string, ReviewerStatusSnapshot>();
  for (const item of record.resolution?.reviewers ?? []) {
    reviewers.set(item.id, {
      reviewer_id: item.id,
      ...(item.purpose === undefined ? {} : { purpose: item.purpose }),
      ...(item.adapter === undefined ? {} : { adapter: item.adapter }),
      ...(item.model === undefined ? {} : { model: item.model }),
      state:
        item.modelIndex !== undefined && item.modelIndex > 0
          ? "deferred"
          : "queued",
    });
  }
  let resolvedTotal = reviewers.size;
  let completed: Extract<PublicEvent, { event: "run.completed" }> | undefined;
  for (const event of record.events) {
    if (event.event === "suite.resolved") {
      resolvedTotal = event.data.total;
      for (const item of event.data.reviewers) {
        const current = reviewers.get(item.id);
        reviewers.set(item.id, {
          reviewer_id: item.id,
          purpose: item.purpose,
          adapter: item.adapter,
          model: item.model,
          ...(current === undefined ? {} : current),
          state:
            current?.state ??
            (item.activation === "after_clear_pass" ? "deferred" : "queued"),
        });
      }
      continue;
    }
    if (event.event === "run.completed") {
      completed = event;
      for (const terminal of event.data.reviewers) {
        const reviewer = reviewers.get(terminal.reviewer_id) ?? {
          reviewer_id: terminal.reviewer_id,
          state: "queued" as const,
        };
        applyTerminalRecord(reviewer, terminal);
        reviewers.set(terminal.reviewer_id, reviewer);
      }
      continue;
    }
    if (event.reviewer_id === undefined) continue;
    const reviewer = reviewers.get(event.reviewer_id) ?? {
      reviewer_id: event.reviewer_id,
      state: "queued" as const,
    };
    updateReviewer(reviewer, event);
    reviewers.set(event.reviewer_id, reviewer);
  }

  const selectedReviewers =
    reviewerId === undefined
      ? [...reviewers.values()]
      : reviewers.has(reviewerId)
        ? [reviewers.get(reviewerId)!]
        : [];
  const reviewerValues = [...reviewers.values()];
  const compactSuite = completed?.data.suite ?? {
    total: Math.max(resolvedTotal, reviewerValues.length),
    deferred: reviewerValues.filter((reviewer) => reviewer.state === "deferred")
      .length,
    queued: reviewerValues.filter((reviewer) => reviewer.state === "queued")
      .length,
    running: reviewerValues.filter(
      (reviewer) =>
        reviewer.state !== "queued" &&
        reviewer.state !== "deferred" &&
        reviewer.state !== "completed" &&
        reviewer.state !== "incomplete" &&
        reviewer.state !== "skipped",
    ).length,
    completed: reviewerValues.filter(
      (reviewer) => reviewer.state === "completed",
    ).length,
    incomplete: reviewerValues.filter(
      (reviewer) => reviewer.state === "incomplete",
    ).length,
    skipped: reviewerValues.filter((reviewer) => reviewer.state === "skipped")
      .length,
  };
  return {
    schema_version: "1",
    kind: "review-mesh.run-status",
    run_id: runId,
    active: completed === undefined && recordPath.active,
    status: completed?.data.status ?? "running",
    ...(completed === undefined
      ? {}
      : {
          exit_code: completed.data.exit_code,
          total_elapsed_ms: completed.data.total_elapsed_ms,
        }),
    suite: compactSuite,
    reviewers: selectedReviewers,
    ...(reviewerId === undefined ? {} : { reviewer_id: reviewerId }),
    last_seq: record.events.at(-1)?.seq ?? 0,
  };
}
