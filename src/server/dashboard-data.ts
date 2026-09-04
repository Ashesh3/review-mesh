import { constants, type Dirent } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import {
  configRevision,
  listConfig,
  loadManagedConfig,
  type ManagedAgent,
  type ManagedConfig,
} from "../config/manage.js";
import type { AppPaths } from "../config/paths.js";
import { reviewMeshVersion } from "../discovery/help.js";
import type {
  ConsolidatedRunFinding,
  RawRunFinding,
} from "../diagnostics/run-report.js";
import {
  canonicalizeFindings,
  type CanonicalGatePolicy,
  type CanonicalRawFinding,
} from "../findings/canonical.js";
import {
  failClosedAdjudicationOutcome,
  validateAdjudication,
} from "../findings/adjudication.js";
import {
  verifyAdjudicationValidationAttestation,
  type AdjudicationValidationAttestation,
} from "../findings/attestation.js";
import {
  adjudicationResultSchema,
  currentReviewerOutputSchema,
  reviewerResultSchema,
  reviewerResultV3Schema,
} from "../protocol/schemas.js";
import { reviewerResultDigest } from "../results/digest.js";
import { readRunRecordLines } from "../diagnostics/run-record-reader.js";

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const ACTIVE_RUN_FILE =
  /^(?<runId>[A-Za-z0-9][A-Za-z0-9._-]*)\.jsonl\.active(?:\..+)?$/u;
const MAX_DASHBOARD_RUNS = 256;
const MAX_DASHBOARD_TOTAL_BYTES = 128 * 1024 * 1024;
const DASHBOARD_READ_CONCURRENCY = 4;
const MAX_EVENT_PAYLOAD_BYTES = 16 * 1024;
const MAX_ACTIVITY_ITEMS = 2_000;
const SENSITIVE_KEY =
  /token|secret|password|authorization|api[_-]?key|instructions?|runtime|context/i;

export interface DashboardServerInfo {
  host: string;
  port: number;
  startedAt: string;
}

export interface DashboardRunSummary {
  run_id: string;
  active: boolean;
  status: string;
  project_name?: string;
  workspace?: string;
  branch?: string | null;
  scope?: string;
  changed_files_count?: number;
  started_at?: string;
  finished_at?: string;
  updated_at: string;
  total_elapsed_ms?: number;
  gate_outcome?: string;
  coverage_outcome?: string;
  logical_lenses?: Record<string, unknown>;
  model_runs?: Record<string, unknown>;
  findings: number;
  unique_findings?: number;
  raw_findings?: number;
  gate_findings?: number;
  advisory_findings?: number;
  unreadable?: boolean;
  error?: string;
  legacy?: boolean;
  stale?: boolean;
  stage?: string;
  reviewers?: Array<Record<string, unknown>>;
}

interface RunFileCandidate {
  runId: string;
  path: string;
  active: boolean;
  owner?: { pid: number; startedAtMs: number };
  modifiedAt: string;
  size: number;
}

interface ParsedRunFile {
  candidate: RunFileCandidate;
  records: Record<string, unknown>[];
  events: Record<string, unknown>[];
  resolution?: Record<string, unknown>;
  request?: Record<string, unknown>;
  context?: Record<string, unknown>;
  started?: Record<string, unknown>;
  contextEvent?: Record<string, unknown>;
  suiteEvent?: Record<string, unknown>;
  completed?: Record<string, unknown>;
  latestTimestamp?: string;
  legacy: boolean;
}

interface ReviewerRuntime {
  reviewer_id: string;
  lens_id: string;
  purpose?: string;
  adapter?: string;
  model?: string;
  effort?: string;
  provider_group?: string;
  isolation_policy?: string;
  timeout_ms?: number;
  attempt_timeout_ms?: number;
  model_index: number;
  configured_model_index: number;
  model_count: number;
  previous_reviewer_id?: string;
  mode?: string;
  adjudicates_reviewer_id?: string;
  policy?: Record<string, unknown>;
  adjudication_validation?: AdjudicationValidationAttestation;
  state: string;
  started_at?: string;
  finished_at?: string;
  elapsed_ms?: number;
  isolation?: string;
  activity: Array<Record<string, unknown>>;
  result?: Record<string, unknown>;
  result_digest?: string;
  result_byte_count?: number;
  failure?: Record<string, unknown>;
  skipped?: Record<string, unknown>;
  attempts: Array<Record<string, unknown>>;
}

export interface DashboardSnapshot {
  schema_version: "1";
  generated_at: string;
  server: {
    version: string;
    host: string;
    port: number;
    started_at: string;
    uptime_ms: number;
    transport: "server-sent-events";
    read_only: true;
  };
  configuration: Record<string, unknown>;
  agents: Array<Record<string, unknown>>;
  projects: Array<Record<string, unknown>>;
  runs: DashboardRunSummary[];
  counts: {
    active_runs: number;
    running_reviewers: number;
    queued_reviewers: number;
    partial_runs: number;
  };
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

function timestamp(value: unknown): string | undefined {
  const valueText = text(value);
  if (valueText === undefined || Number.isNaN(Date.parse(valueText))) {
    return undefined;
  }
  return valueText;
}

function redactString(value: string): string {
  return value
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu, "$1[redacted]@")
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gu,
      "[redacted]",
    )
    .replace(
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
      "[redacted]",
    )
    .replace(
      /\b(?:authorization|api[_-]?key|access[_-]?token|client[_-]?secret|password|secret|accountkey)\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/giu,
      "[redacted]",
    )
    .replace(/\bBearer\s+[^\s,;]+/giu, "[redacted]")
    .replace(/(https?:\/\/[^\s/?#]+\/[^\s?#]*)\?[^\s#]*/giu, "$1?[redacted]");
}

function bounded(value: unknown, depth = 0): unknown {
  if (depth >= 24) return "[truncated]";
  if (typeof value === "string") {
    const sanitized = redactString(value);
    const encoded = Buffer.from(sanitized, "utf8");
    return encoded.byteLength <= MAX_EVENT_PAYLOAD_BYTES
      ? sanitized
      : `${encoded.subarray(0, MAX_EVENT_PAYLOAD_BYTES).toString("utf8")}…`;
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 256).map((child) => bounded(child, depth + 1));
  }
  const record = asRecord(value);
  if (record === undefined) return null;
  return Object.fromEntries(
    Object.entries(record)
      .slice(0, 256)
      .map(([key, child]) => [
        key,
        SENSITIVE_KEY.test(key) ? "[redacted]" : bounded(child, depth + 1),
      ]),
  );
}

function isWithinDirectory(directory: string, target: string): boolean {
  const path = relative(directory, target);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function requireSafeRunId(runId: string): string {
  if (!SAFE_RUN_ID.test(runId) || runId === "." || runId === "..") {
    throw new Error("Run id must be a safe single filename component.");
  }
  return runId;
}

function runFile(entry: Dirent):
  | {
      runId: string;
      active: boolean;
      owner?: { pid: number; startedAtMs: number };
    }
  | undefined {
  if (!entry.isFile()) return undefined;
  if (entry.name.endsWith(".jsonl")) {
    const runId = entry.name.slice(0, -".jsonl".length);
    return SAFE_RUN_ID.test(runId) ? { runId, active: false } : undefined;
  }
  const match = ACTIVE_RUN_FILE.exec(entry.name);
  if (match?.groups?.runId === undefined) return undefined;
  const owner = /\.active\.(\d+)\.(\d+)\./u.exec(entry.name);
  return {
    runId: match.groups.runId,
    active: true,
    ...(owner === null
      ? {}
      : {
          owner: { pid: Number(owner[1]), startedAtMs: Number(owner[2]) },
        }),
  };
}

function processIsLikelyAlive(owner: {
  pid: number;
  startedAtMs: number;
}): boolean {
  if (
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0 ||
    !Number.isSafeInteger(owner.startedAtMs) ||
    owner.startedAtMs < 0
  ) {
    return false;
  }
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    return !(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
  if (owner.pid !== process.pid) return true;
  const currentStart = Math.max(
    0,
    Math.floor(Date.now() - process.uptime() * 1_000),
  );
  return Math.abs(currentStart - owner.startedAtMs) < 10_000;
}

async function listRunFiles(
  runsDirectory: string,
  maximumTotalBytes = MAX_DASHBOARD_TOTAL_BYTES,
): Promise<{ selected: RunFileCandidate[]; omitted: RunFileCandidate[] }> {
  const root = await realpath(resolve(runsDirectory)).catch(() => undefined);
  if (root === undefined) return { selected: [], omitted: [] };
  const entries = await readdir(root, { withFileTypes: true });
  const candidates = await Promise.all(
    entries.map(async (entry): Promise<RunFileCandidate | undefined> => {
      const parsed = runFile(entry);
      if (parsed === undefined) return undefined;
      const unresolved = join(root, entry.name);
      const path = await realpath(unresolved).catch(() => undefined);
      if (
        path === undefined ||
        !isWithinDirectory(root, path) ||
        basename(path) !== entry.name
      ) {
        return undefined;
      }
      const metadata = await stat(path);
      if (!metadata.isFile()) {
        return undefined;
      }
      return {
        runId: parsed.runId,
        path,
        active: parsed.active,
        ...(parsed.owner === undefined ? {} : { owner: parsed.owner }),
        modifiedAt: metadata.mtime.toISOString(),
        size: metadata.size,
      };
    }),
  );
  const byRun = new Map<string, RunFileCandidate>();
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const current = byRun.get(candidate.runId);
    if (
      current === undefined ||
      (!candidate.active && current.active) ||
      (candidate.active === current.active &&
        candidate.modifiedAt > current.modifiedAt)
    ) {
      byRun.set(candidate.runId, candidate);
    }
  }
  const ordered = [...byRun.values()].sort((left, right) =>
    right.modifiedAt.localeCompare(left.modifiedAt),
  );
  const selected: RunFileCandidate[] = [];
  const omitted: RunFileCandidate[] = [];
  let totalBytes = 0;
  for (const candidate of ordered) {
    if (selected.length >= MAX_DASHBOARD_RUNS) break;
    if (candidate.size > maximumTotalBytes - totalBytes) {
      omitted.push(candidate);
      continue;
    }
    selected.push(candidate);
    totalBytes += candidate.size;
  }
  return { selected, omitted };
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let index = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      for (;;) {
        const current = index++;
        if (current >= values.length) return;
        results[current] = await operation(values[current]!);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

async function parseCandidate(
  candidate: RunFileCandidate,
  afterOpen?: () => void | Promise<void>,
): Promise<ParsedRunFile> {
  const handle = await open(
    candidate.path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const [metadata, target, canonical] = await Promise.all([
      handle.stat(),
      lstat(candidate.path),
      realpath(candidate.path),
    ]);
    if (
      !metadata.isFile() ||
      !target.isFile() ||
      target.isSymbolicLink() ||
      canonical !== candidate.path ||
      metadata.size !== candidate.size ||
      target.size !== metadata.size ||
      metadata.dev !== target.dev ||
      metadata.ino !== target.ino
    ) {
      throw new Error("Run record exceeds the dashboard limit.");
    }
    await afterOpen?.();
    const records: Record<string, unknown>[] = [];
    const events: Record<string, unknown>[] = [];
    let resolution: Record<string, unknown> | undefined;
    let request: Record<string, unknown> | undefined;
    let context: Record<string, unknown> | undefined;
    let started: Record<string, unknown> | undefined;
    let contextEvent: Record<string, unknown> | undefined;
    let suiteEvent: Record<string, unknown> | undefined;
    let completed: Record<string, unknown> | undefined;
    let latestTimestamp: string | undefined;
    let legacy = false;
    for await (const { encoded, terminated } of readRunRecordLines(
      handle,
      metadata.size,
    )) {
      if (encoded.trim().length === 0) continue;
      let value: unknown;
      try {
        value = JSON.parse(encoded);
      } catch {
        if (candidate.active && !terminated) break;
        throw new Error("The persisted run record contains invalid JSON.");
      }
      const record = asRecord(value);
      if (record === undefined) throw new Error("Invalid run record entry.");
      const recordRunId = text(record.run_id);
      if (recordRunId !== undefined && recordRunId !== candidate.runId)
        throw new Error("Run record id mismatch.");
      if (record.schema_version !== undefined && record.schema_version !== "5")
        legacy = true;
      records.push(record);
      const at = timestamp(record.timestamp);
      if (at !== undefined) latestTimestamp = at;
      const event = text(record.event);
      if (event !== undefined) {
        events.push(record);
        if (event === "run.started") started = record;
        if (event === "context.resolved") contextEvent = record;
        if (event === "suite.resolved") suiteEvent = record;
        if (event === "run.completed") completed = record;
      } else if (record.record === "resolution") {
        resolution = asRecord(record.resolution);
      } else if (record.record === "request") {
        request = asRecord(record.request);
      } else if (record.record === "context") {
        context = asRecord(record.context);
      } else if (record.record === "run.summary") {
        completed = {
          timestamp: latestTimestamp ?? candidate.modifiedAt,
          data: asRecord(record.data) ?? asRecord(record.summary) ?? {},
        };
      }
    }
    const [afterHandle, afterTarget, afterCanonical] = await Promise.all([
      handle.stat(),
      lstat(candidate.path),
      realpath(candidate.path),
    ]);
    if (
      afterCanonical !== candidate.path ||
      afterTarget.isSymbolicLink() ||
      !afterTarget.isFile() ||
      afterHandle.dev !== metadata.dev ||
      afterHandle.ino !== metadata.ino ||
      afterTarget.dev !== metadata.dev ||
      afterTarget.ino !== metadata.ino ||
      (candidate.active
        ? afterHandle.size < metadata.size || afterTarget.size < metadata.size
        : afterHandle.size !== metadata.size ||
          afterTarget.size !== metadata.size)
    ) {
      throw new Error("Run record identity changed while reading.");
    }
    return {
      candidate,
      records,
      events,
      ...(resolution === undefined ? {} : { resolution }),
      ...(request === undefined ? {} : { request }),
      ...(context === undefined ? {} : { context }),
      ...(started === undefined ? {} : { started }),
      ...(contextEvent === undefined ? {} : { contextEvent }),
      ...(suiteEvent === undefined ? {} : { suiteEvent }),
      ...(completed === undefined ? {} : { completed }),
      ...(latestTimestamp === undefined ? {} : { latestTimestamp }),
      legacy,
    };
  } finally {
    await handle.close();
  }
}

async function loadParsedRun(
  runsDirectory: string,
  runId: string,
): Promise<ParsedRunFile> {
  requireSafeRunId(runId);
  const candidate = (
    await listRunFiles(runsDirectory, Number.MAX_SAFE_INTEGER)
  ).selected.find((item) => item.runId === runId);
  if (candidate === undefined) throw new Error(`Run ${runId} was not found.`);
  return await parseCandidate(candidate);
}

function eventData(event: Record<string, unknown> | undefined) {
  return asRecord(event?.data) ?? {};
}

function contextData(parsed: ParsedRunFile): Record<string, unknown> {
  const publicContext = eventData(parsed.contextEvent);
  if (Object.keys(publicContext).length > 0) {
    return asRecord(publicContext.context) ?? publicContext;
  }
  const context = parsed.context ?? {};
  const git = asRecord(context.git) ?? {};
  return {
    workspace: context.workspace,
    project_name: context.project_name,
    review_scope: asRecord(context.review_scope),
    git: {
      is_repository: git.is_repository === true,
      branch: git.branch,
      head: git.head,
      merge_base: git.merge_base,
      changed_files_count: Array.isArray(git.changed_files)
        ? git.changed_files.length
        : 0,
      changed_files: Array.isArray(git.changed_files)
        ? git.changed_files.slice(0, 25)
        : [],
      diff_stat: text(git.diff_stat),
      truncated: asRecord(git.truncated),
    },
  };
}

function findingCount(value: unknown): number {
  return Array.isArray(value) ? value.length : (integer(value) ?? 0);
}

function buildReviewerRuntime(parsed: ParsedRunFile): ReviewerRuntime[] {
  const reviewers = new Map<string, ReviewerRuntime>();
  const suiteReviewers = eventData(parsed.suiteEvent).reviewers;
  const roster = Array.isArray(parsed.resolution?.reviewers)
    ? parsed.resolution.reviewers
    : Array.isArray(suiteReviewers)
      ? suiteReviewers
      : [];
  for (const value of roster) {
    const entry = asRecord(value);
    const id = text(entry?.id);
    if (id === undefined) continue;
    const lensId = text(entry?.agent_id) ?? id.split("::", 1)[0]!;
    const policy = asRecord(entry?.policy);
    reviewers.set(id, {
      reviewer_id: id,
      lens_id: lensId,
      ...(text(entry?.purpose) === undefined
        ? {}
        : { purpose: text(entry?.purpose)! }),
      ...(text(entry?.adapter) === undefined
        ? {}
        : { adapter: text(entry?.adapter)! }),
      ...(text(entry?.model) === undefined
        ? {}
        : { model: text(entry?.model)! }),
      ...(text(entry?.effort) === undefined
        ? {}
        : { effort: text(entry?.effort)! }),
      ...(text(entry?.provider_group) === undefined
        ? {}
        : { provider_group: text(entry?.provider_group)! }),
      ...(text(entry?.isolation_policy) === undefined
        ? {}
        : { isolation_policy: text(entry?.isolation_policy)! }),
      ...(integer(entry?.timeout_ms) === undefined
        ? {}
        : { timeout_ms: integer(entry?.timeout_ms)! }),
      ...(integer(entry?.attempt_timeout_ms) === undefined
        ? {}
        : { attempt_timeout_ms: integer(entry?.attempt_timeout_ms)! }),
      model_index: integer(entry?.model_index) ?? 0,
      configured_model_index:
        integer(entry?.configured_model_index) ??
        integer(entry?.model_index) ??
        0,
      model_count: integer(entry?.model_count) ?? 1,
      ...(text(entry?.previous_reviewer_id) === undefined
        ? {}
        : { previous_reviewer_id: text(entry?.previous_reviewer_id)! }),
      ...(asRecord(entry?.policy) === undefined
        ? {}
        : { policy: bounded(entry!.policy) as Record<string, unknown> }),
      ...(text(policy?.mode) === undefined
        ? {}
        : { mode: text(policy?.mode)! }),
      ...(text(policy?.adjudicatesReviewerId) === undefined
        ? {}
        : {
            adjudicates_reviewer_id: text(policy?.adjudicatesReviewerId)!,
          }),
      state: (integer(entry?.model_index) ?? 0) > 0 ? "deferred" : "queued",
      activity: [],
      attempts: [],
    });
  }
  const reviewerFor = (id: string): ReviewerRuntime => {
    const current = reviewers.get(id);
    if (current !== undefined) return current;
    const created: ReviewerRuntime = {
      reviewer_id: id,
      lens_id: id.split("::", 1)[0]!,
      model_index: 0,
      configured_model_index: 0,
      model_count: 1,
      state: "queued",
      activity: [],
      attempts: [],
    };
    reviewers.set(id, created);
    return created;
  };
  for (const record of parsed.records) {
    if (record.record === "reviewer.attempt") {
      const id = text(record.reviewer_id);
      if (id === undefined) continue;
      const reviewer = reviewerFor(id);
      const attempt = {
        attempt: integer(record.attempt) ?? 1,
        started_at: timestamp(record.started_at) ?? timestamp(record.startedAt),
        elapsed_ms:
          integer(record.elapsed_ms) ?? integer(record.elapsedMs) ?? 0,
        failure: bounded(record.failure),
      };
      reviewer.attempts.push(attempt);
      reviewer.activity.push({
        kind: "attempt_failed",
        timestamp: attempt.started_at,
        message: text(asRecord(record.failure)?.message) ?? "Attempt failed.",
        ...attempt,
      });
      continue;
    }
    if (record.record === "reviewer.activity") {
      const id = text(record.reviewer_id);
      if (id === undefined) continue;
      const reviewer = reviewerFor(id);
      reviewer.activity.push({
        kind: "activity",
        ...(timestamp(record.timestamp) === undefined
          ? {}
          : { timestamp: timestamp(record.timestamp)! }),
        ...(integer(record.seq) === undefined
          ? {}
          : { seq: integer(record.seq)! }),
        ...(text(record.phase) === undefined
          ? {}
          : { phase: text(record.phase)! }),
        ...(text(record.message) === undefined
          ? {}
          : { message: redactString(text(record.message)!) }),
      });
      continue;
    }
    if (record.record === "reviewer.result") {
      const id = text(record.reviewer_id);
      if (id === undefined) continue;
      const reviewer = reviewerFor(id);
      const mode = text(record.mode);
      const adjudicatesReviewerId = text(record.adjudicates_reviewer_id);
      if (mode !== undefined) reviewer.mode = mode;
      if (adjudicatesReviewerId !== undefined) {
        reviewer.adjudicates_reviewer_id = adjudicatesReviewerId;
      }
      const adjudicationValidation = asRecord(record.adjudication_validation);
      if (adjudicationValidation !== undefined) {
        reviewer.adjudication_validation = structuredClone(
          adjudicationValidation,
        ) as unknown as AdjudicationValidationAttestation;
      }
      const container = asRecord(record.data) ?? record;
      const candidate = container.result;
      const result = currentReviewerOutputSchema.safeParse(candidate);
      const digest = text(container.digest);
      const byteCount = integer(container.byte_count);
      if (!result.success) {
        const legacy = reviewerResultSchema.safeParse(candidate);
        if (
          legacy.success &&
          (legacy.data.schema_version === "1" ||
            legacy.data.schema_version === "2")
        ) {
          reviewer.result = bounded(legacy.data) as Record<string, unknown>;
          continue;
        }
        throw new Error("The persisted reviewer result is invalid.");
      }
      const requiresTuple =
        result.data.schema_version === "3" || "kind" in result.data;
      if (requiresTuple || digest !== undefined || byteCount !== undefined) {
        if (digest === undefined || byteCount === undefined)
          throw new Error("The persisted reviewer result is invalid.");
        const expectedBytes = Buffer.byteLength(
          JSON.stringify(result.data),
          "utf8",
        );
        if (
          digest !== reviewerResultDigest(result.data) ||
          byteCount !== expectedBytes
        ) {
          throw new Error(
            "The persisted reviewer result integrity tuple is invalid.",
          );
        }
      }
      reviewer.result = structuredClone(result.data) as Record<string, unknown>;
      if (digest !== undefined) reviewer.result_digest = digest;
      if (byteCount !== undefined) reviewer.result_byte_count = byteCount;
      continue;
    }
    if (record.record === "reviewer.terminal") {
      const terminal = asRecord(record.terminal) ?? asRecord(record.data);
      const id = text(terminal?.reviewer_id);
      if (id === undefined || terminal === undefined) continue;
      applyTerminal(reviewerFor(id), terminal, parsed.latestTimestamp);
      continue;
    }
    const event = text(record.event);
    const id = text(record.reviewer_id);
    if (event === undefined || id === undefined) continue;
    const data = eventData(record);
    const reviewer = reviewerFor(id);
    if (event === "reviewer.result") {
      const digest = text(data.digest);
      const byteCount = integer(data.byte_count);
      if (
        reviewer.result === undefined ||
        digest === undefined ||
        byteCount === undefined ||
        reviewer.result_digest !== digest ||
        reviewer.result_byte_count !== byteCount
      ) {
        throw new Error(
          "The persisted public reviewer result reference is invalid.",
        );
      }
      continue;
    }
    reviewer.lens_id = text(data.lens_id) ?? reviewer.lens_id;
    const mode = text(data.mode);
    const adapter = text(data.adapter);
    const model = text(data.model);
    const effort = text(data.effort);
    const providerGroup = text(data.provider_group);
    const elapsedMs = integer(data.elapsed_ms);
    const isolation = text(data.isolation);
    if (mode !== undefined) reviewer.mode = mode;
    if (adapter !== undefined) reviewer.adapter = adapter;
    if (model !== undefined) reviewer.model = model;
    if (effort !== undefined) reviewer.effort = effort;
    if (providerGroup !== undefined) reviewer.provider_group = providerGroup;
    if (elapsedMs !== undefined) reviewer.elapsed_ms = elapsedMs;
    if (isolation !== undefined) reviewer.isolation = isolation;
    if (event === "reviewer.started") {
      reviewer.state = "starting";
      const startedAt = timestamp(record.timestamp);
      const purpose = text(data.purpose);
      if (reviewer.started_at === undefined && startedAt !== undefined) {
        reviewer.started_at = startedAt;
      }
      if (purpose !== undefined) reviewer.purpose = purpose;
    } else if (event === "reviewer.progress") {
      reviewer.state = text(data.phase) ?? reviewer.state;
    } else if (event === "reviewer.heartbeat") {
      reviewer.state = text(data.phase) ?? reviewer.state;
    } else if (event === "reviewer.completed") {
      reviewer.state = "completed";
      const finishedAt = timestamp(record.timestamp);
      if (finishedAt !== undefined) reviewer.finished_at = finishedAt;
      if (asRecord(data.result) !== undefined) {
        reviewer.result = bounded(data.result) as Record<string, unknown>;
      } else if (reviewer.result === undefined) {
        reviewer.result = {
          verdict: data.verdict,
          summary: data.summary,
          actionable_findings: data.actionable_findings,
          gate_findings: data.gate_findings,
          informational_notes: data.informational_notes,
        };
      }
    } else if (event === "reviewer.incomplete") {
      reviewer.state = "incomplete";
      const finishedAt = timestamp(record.timestamp);
      if (finishedAt !== undefined) reviewer.finished_at = finishedAt;
      reviewer.failure = bounded(data) as Record<string, unknown>;
    } else if (event === "reviewer.skipped") {
      reviewer.state = "skipped";
      const finishedAt = timestamp(record.timestamp);
      if (finishedAt !== undefined) reviewer.finished_at = finishedAt;
      reviewer.skipped = bounded(data) as Record<string, unknown>;
    }
    const message =
      text(data.message) ??
      text(data.last_activity_message) ??
      (event === "reviewer.completed"
        ? (text(data.summary) ?? "Reviewer completed.")
        : event === "reviewer.incomplete"
          ? (text(data.message) ?? "Reviewer incomplete.")
          : event === "reviewer.skipped"
            ? `Reviewer skipped: ${text(data.reason) ?? "not selected"}.`
            : event === "reviewer.started"
              ? "Reviewer started."
              : undefined);
    if (message !== undefined && event !== "reviewer.heartbeat") {
      reviewer.activity.push({
        kind: event,
        timestamp: timestamp(record.timestamp),
        seq: integer(record.seq),
        phase: text(data.phase),
        message: redactString(message),
        payload: bounded(data),
      });
    }
  }
  return [...reviewers.values()]
    .map((reviewer) => ({
      ...reviewer,
      activity: reviewer.activity.slice(-MAX_ACTIVITY_ITEMS),
      ...(reviewer.result === undefined
        ? {}
        : {
            verdict: reviewer.result.verdict,
            actionable_findings: Array.isArray(
              reviewer.result.actionable_findings,
            )
              ? reviewer.result.actionable_findings.length
              : 0,
          }),
    }))
    .sort(
      (left, right) =>
        left.lens_id.localeCompare(right.lens_id) ||
        left.model_index - right.model_index ||
        left.reviewer_id.localeCompare(right.reviewer_id),
    );
}

function applyTerminal(
  reviewer: ReviewerRuntime,
  terminal: Record<string, unknown>,
  fallbackTimestamp?: string,
): void {
  reviewer.state = text(terminal.status) ?? reviewer.state;
  reviewer.lens_id = text(terminal.lens_id) ?? reviewer.lens_id;
  const mode = text(terminal.mode);
  const adjudicatesReviewerId = text(terminal.adjudicates_reviewer_id);
  const adapter = text(terminal.adapter);
  const model = text(terminal.model);
  const providerGroup = text(terminal.provider_group);
  const elapsedMs = integer(terminal.elapsed_ms);
  const isolation = text(terminal.isolation);
  if (mode !== undefined) reviewer.mode = mode;
  if (adjudicatesReviewerId !== undefined) {
    reviewer.adjudicates_reviewer_id = adjudicatesReviewerId;
  }
  if (adapter !== undefined) reviewer.adapter = adapter;
  if (model !== undefined) reviewer.model = model;
  if (providerGroup !== undefined) reviewer.provider_group = providerGroup;
  if (elapsedMs !== undefined) reviewer.elapsed_ms = elapsedMs;
  if (isolation !== undefined) reviewer.isolation = isolation;
  if (reviewer.finished_at === undefined && fallbackTimestamp !== undefined) {
    reviewer.finished_at = fallbackTimestamp;
  }
  const result = asRecord(terminal.result);
  const digest = text(terminal.result_digest);
  const byteCount = integer(terminal.result_byte_count);
  if (
    result === undefined &&
    (digest !== undefined || byteCount !== undefined)
  ) {
    if (
      reviewer.result === undefined ||
      digest === undefined ||
      byteCount === undefined ||
      reviewer.result_digest !== digest ||
      reviewer.result_byte_count !== byteCount
    ) {
      throw new Error("The completed terminal result reference is invalid.");
    }
  }
  if (result !== undefined && reviewer.result === undefined)
    reviewer.result = structuredClone(result) as Record<string, unknown>;
  if (reviewer.state === "incomplete") {
    reviewer.failure = bounded(terminal) as Record<string, unknown>;
  }
  if (reviewer.state === "skipped") {
    reviewer.skipped = bounded(terminal) as Record<string, unknown>;
  }
}

function groupLenses(
  reviewers: ReviewerRuntime[],
): Array<Record<string, unknown>> {
  const groups = new Map<string, ReviewerRuntime[]>();
  for (const reviewer of reviewers) {
    groups.set(reviewer.lens_id, [
      ...(groups.get(reviewer.lens_id) ?? []),
      reviewer,
    ]);
  }
  return [...groups.entries()].map(([id, members]) => ({
    id,
    purpose: members.find((member) => member.purpose !== undefined)?.purpose,
    policy: members.find((member) => member.policy !== undefined)?.policy,
    reviewers: members,
  }));
}

function runStage(parsed: ParsedRunFile, reviewers: ReviewerRuntime[]): string {
  if (parsed.completed !== undefined) return "complete";
  if (parsed.suiteEvent !== undefined) {
    return reviewers.every((reviewer) =>
      ["completed", "incomplete", "skipped"].includes(reviewer.state),
    )
      ? "consolidate"
      : "execute_lenses";
  }
  if (parsed.contextEvent !== undefined) return "resolve_suite";
  if (parsed.started !== undefined) return "resolve_context";
  return "starting";
}

function runSummaryFromParsed(parsed: ParsedRunFile): DashboardRunSummary {
  const context = contextData(parsed);
  const git = asRecord(context.git) ?? {};
  const scope = asRecord(context.review_scope);
  const completion = eventData(parsed.completed);
  const reviewers = buildReviewerRuntime(parsed);
  const persistedContext = parsed.context ?? {};
  const persistedGit = asRecord(persistedContext.git);
  const activeFile = parsed.completed === undefined && parsed.candidate.active;
  const lastUpdate = Math.max(
    Date.parse(parsed.latestTimestamp ?? parsed.candidate.modifiedAt),
    Date.parse(parsed.candidate.modifiedAt),
  );
  const fresh = Date.now() - lastUpdate < 2 * 60 * 1_000;
  const active =
    activeFile &&
    (parsed.candidate.owner === undefined
      ? fresh
      : processIsLikelyAlive(parsed.candidate.owner));
  const stale = activeFile && !active;
  const canonical = canonicalizeFindings(
    rawFindings(
      reviewers,
      scope?.mode === "changes" ? "changes" : "full",
      {
        changedFiles: Array.isArray(persistedGit?.changed_files)
          ? persistedGit.changed_files
              .map(text)
              .filter((value): value is string => value !== undefined)
          : [],
        diff: text(persistedGit?.diff) ?? "",
      },
      typeof persistedGit?.head === "string" ? persistedGit.head : null,
    ) as readonly CanonicalRawFinding[],
    { gatePolicies: dashboardGatePolicies(reviewers) },
  );
  const hasFullResults = reviewers.some((reviewer) =>
    Array.isArray(reviewer.result?.actionable_findings),
  );
  const counts = hasFullResults
    ? canonical.counts
    : {
        raw: integer(completion.raw_findings) ?? canonical.counts.raw,
        unique: integer(completion.unique_findings) ?? canonical.counts.unique,
        gate: integer(completion.gate_findings) ?? canonical.counts.gate,
        advisory:
          integer(completion.advisory_findings) ?? canonical.counts.advisory,
      };
  const findings = counts.unique;
  const hasIncomplete = reviewers.some(
    (reviewer) => reviewer.state === "incomplete",
  );
  const hasFindings = counts.gate > 0;
  const status = stale
    ? "stale"
    : active
      ? "running"
      : hasFullResults
        ? hasIncomplete
          ? "incomplete"
          : hasFindings
            ? "findings"
            : "passed"
        : (text(completion.status) ??
          (hasIncomplete ? "incomplete" : hasFindings ? "findings" : "passed"));
  return {
    run_id: parsed.candidate.runId,
    active,
    status,
    ...(text(context.project_name) === undefined
      ? text(parsed.request?.project_name) === undefined
        ? {}
        : { project_name: redactString(text(parsed.request?.project_name)!) }
      : { project_name: redactString(text(context.project_name)!) }),
    ...(text(context.workspace) === undefined
      ? {}
      : { workspace: redactString(text(context.workspace)!) }),
    ...(git.branch === undefined
      ? {}
      : {
          branch:
            typeof git.branch === "string"
              ? redactString(git.branch)
              : (git.branch as null),
        }),
    ...(text(scope?.mode) === undefined ? {} : { scope: text(scope?.mode)! }),
    ...(integer(git.changed_files_count) === undefined
      ? {}
      : { changed_files_count: integer(git.changed_files_count)! }),
    ...(timestamp(parsed.started?.timestamp) === undefined
      ? {}
      : { started_at: timestamp(parsed.started?.timestamp)! }),
    ...(timestamp(parsed.completed?.timestamp) === undefined
      ? {}
      : { finished_at: timestamp(parsed.completed?.timestamp)! }),
    updated_at: parsed.latestTimestamp ?? parsed.candidate.modifiedAt,
    ...(integer(completion.total_elapsed_ms) === undefined
      ? {}
      : { total_elapsed_ms: integer(completion.total_elapsed_ms)! }),
    gate_outcome: hasFullResults
      ? hasFindings
        ? "findings"
        : activeFile
          ? "pending"
          : "passed"
      : (text(completion.gate_outcome) ??
        (hasFindings ? "findings" : activeFile ? "pending" : "passed")),
    coverage_outcome:
      text(completion.coverage_outcome) ??
      (activeFile ? "in_progress" : hasIncomplete ? "partial" : "complete"),
    logical_lenses: asRecord(completion.logical_lenses) ?? {
      total: new Set(reviewers.map((reviewer) => reviewer.lens_id)).size,
    },
    model_runs: asRecord(completion.model_runs) ?? {
      total: reviewers.length,
      running: reviewers.filter((reviewer) =>
        ["probing", "starting", "reviewing", "validating"].includes(
          reviewer.state,
        ),
      ).length,
      queued: reviewers.filter((reviewer) => reviewer.state === "queued")
        .length,
      deferred: reviewers.filter((reviewer) => reviewer.state === "deferred")
        .length,
      completed: reviewers.filter((reviewer) => reviewer.state === "completed")
        .length,
      incomplete: reviewers.filter(
        (reviewer) => reviewer.state === "incomplete",
      ).length,
      skipped: reviewers.filter((reviewer) => reviewer.state === "skipped")
        .length,
    },
    findings,
    unique_findings: counts.unique,
    raw_findings: counts.raw,
    gate_findings: counts.gate,
    advisory_findings: counts.advisory,
    stage: runStage(parsed, reviewers),
    reviewers: reviewers.map((reviewer) => ({
      reviewer_id: reviewer.reviewer_id,
      lens_id: reviewer.lens_id,
      state: reviewer.state,
      ...(reviewer.purpose === undefined ? {} : { purpose: reviewer.purpose }),
      ...(reviewer.adapter === undefined ? {} : { adapter: reviewer.adapter }),
      ...(reviewer.model === undefined ? {} : { model: reviewer.model }),
      ...(reviewer.provider_group === undefined
        ? {}
        : { provider_group: reviewer.provider_group }),
      ...(reviewer.elapsed_ms === undefined
        ? {}
        : { elapsed_ms: reviewer.elapsed_ms }),
      ...(reviewer.activity.at(-1)?.message === undefined
        ? {}
        : { last_activity_message: reviewer.activity.at(-1)!.message }),
      ...(reviewer.result === undefined
        ? {}
        : {
            verdict: reviewer.result.verdict,
            actionable_findings: Array.isArray(
              reviewer.result.actionable_findings,
            )
              ? reviewer.result.actionable_findings.length
              : 0,
          }),
    })),
    ...(stale ? { stale: true } : {}),
    ...(parsed.legacy ? { legacy: true } : {}),
  };
}

async function readRunSummary(
  candidate: RunFileCandidate,
): Promise<DashboardRunSummary> {
  try {
    const parsed = await parseCandidate(candidate);
    const summary = runSummaryFromParsed(parsed);
    parsed.records.length = 0;
    parsed.events.length = 0;
    return summary;
  } catch (error) {
    return {
      run_id: candidate.runId,
      active: candidate.active,
      status: "unreadable",
      updated_at: candidate.modifiedAt,
      findings: 0,
      unreadable: true,
      error: error instanceof Error ? error.message : "Unreadable run record.",
    };
  }
}

function safeAgent(id: string, agent: ManagedAgent): Record<string, unknown> {
  const common = {
    id,
    purpose: agent.purpose,
    adapter: agent.adapter,
    isolation: agent.isolation,
    timeout_ms: agent.timeout_ms,
    instruction_source:
      agent.instructions_file === undefined ? "inline" : "file",
    has_instructions: true,
    ...(agent.applicability === undefined
      ? {}
      : { applicability: bounded(agent.applicability) }),
    ...(agent.required_context === undefined
      ? {}
      : { required_context: [...agent.required_context] }),
    ...(agent.pass_quorum === undefined
      ? {}
      : { pass_quorum: agent.pass_quorum }),
    ...(agent.minimum_provider_groups === undefined
      ? {}
      : { minimum_provider_groups: agent.minimum_provider_groups }),
    ...(agent.adjudication === undefined
      ? {}
      : { adjudication: agent.adjudication }),
    ...(agent.gate_minimum_severity === undefined
      ? {}
      : { gate_minimum_severity: agent.gate_minimum_severity }),
    ...(agent.gate_minimum_confidence === undefined
      ? {}
      : { gate_minimum_confidence: agent.gate_minimum_confidence }),
  };
  return "model_runs" in agent
    ? {
        ...common,
        model_runs: agent.model_runs.map((run, index) => ({
          id: run.id,
          configured_index: index,
          adapter: run.adapter ?? agent.adapter,
          model: run.model,
          ...(run.effort === undefined ? {} : { effort: run.effort }),
          provider_group: run.provider_group ?? run.adapter ?? agent.adapter,
          timeout_ms: run.timeout_ms ?? agent.timeout_ms,
          activation: index === 0 ? "immediate" : "after_lens_progress",
        })),
      }
    : {
        ...common,
        model_runs: [
          {
            id,
            configured_index: 0,
            adapter: agent.adapter,
            model: agent.model,
            ...(agent.effort === undefined ? {} : { effort: agent.effort }),
            provider_group: agent.provider_group ?? agent.adapter,
            timeout_ms: agent.timeout_ms,
            activation: "immediate",
          },
        ],
      };
}

function adapterEnvironmentNames(config: ManagedConfig): string[] {
  const names = Object.values(config.adapters).flatMap((adapter) => {
    if (adapter.type === "openai_compatible") {
      return [adapter.base_url_env, adapter.api_key_env];
    }
    return adapter.env_allowlist ?? [];
  });
  return [...new Set(names)].sort((left, right) => left.localeCompare(right));
}

function safeAdapter(id: string, adapter: ManagedConfig["adapters"][string]) {
  return {
    id,
    type: adapter.type,
    credential_environment: adapterEnvironmentNames({
      schema_version: "5",
      execution: {
        max_concurrency: 1,
        heartbeat_interval_ms: 1,
        shutdown_grace_period_ms: 1,
      },
      diagnostics: { persist_runs: true, max_runs: 1 },
      adapters: { [id]: adapter },
      agents: {},
    }).map((name) => ({
      name,
      present:
        Object.hasOwn(process.env, name) &&
        typeof process.env[name] === "string" &&
        process.env[name]!.length > 0,
    })),
  };
}

async function configurationCatalog(appPaths: AppPaths): Promise<{
  configuration: Record<string, unknown>;
  agents: Array<Record<string, unknown>>;
  projects: Array<Record<string, unknown>>;
}> {
  try {
    const loaded = await loadManagedConfig(appPaths.configFile, true);
    if (!loaded.snapshot.exists) {
      return {
        configuration: {
          valid: false,
          error: "configuration_missing",
          config_path: appPaths.configFile,
          runs_directory: appPaths.runsDirectory,
        },
        agents: [],
        projects: [],
      };
    }
    const config = loaded.config;
    const listed = listConfig(config);
    const projectAssignments = new Map<string, string[]>();
    for (const project of listed.projects) {
      for (const agent of project.agents) {
        projectAssignments.set(agent, [
          ...(projectAssignments.get(agent) ?? []),
          project.name,
        ]);
      }
    }
    const agents = Object.entries(config.agents)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, agent]) => ({
        ...safeAgent(id, agent),
        default: config.defaults?.agents.includes(id) ?? false,
        projects: projectAssignments.get(id) ?? [],
      }));
    const projects = Object.entries(config.projects ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, project]) => ({
        name,
        agents: project.agents ?? [],
        has_guidance:
          project.instructions !== undefined ||
          project.instructions_file !== undefined,
        guidance_source:
          project.instructions_file !== undefined
            ? "file"
            : project.instructions !== undefined
              ? "inline"
              : "none",
        has_context: project.context !== undefined,
      }));
    return {
      configuration: {
        valid: true,
        config_path: appPaths.configFile,
        runs_directory: appPaths.runsDirectory,
        revision: configRevision(loaded.snapshot),
        schema_version: config.schema_version,
        migrated: loaded.migrated,
        execution: structuredClone(config.execution),
        diagnostics: structuredClone(config.diagnostics),
        defaults: { agents: [...(config.defaults?.agents ?? [])] },
        adapters: Object.entries(config.adapters)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([id, adapter]) => safeAdapter(id, adapter)),
      },
      agents,
      projects,
    };
  } catch (error) {
    return {
      configuration: {
        valid: false,
        error: "invalid_configuration",
        message: "The global Review Mesh configuration is invalid.",
        config_path: appPaths.configFile,
        runs_directory: appPaths.runsDirectory,
      },
      agents: [],
      projects: [],
    };
  }
}

export async function readDashboardSnapshot(input: {
  appPaths: AppPaths;
  server: DashboardServerInfo;
  maximumTotalBytes?: number;
}): Promise<DashboardSnapshot> {
  const [catalog, candidates] = await Promise.all([
    configurationCatalog(input.appPaths),
    listRunFiles(
      input.appPaths.runsDirectory,
      input.maximumTotalBytes ?? MAX_DASHBOARD_TOTAL_BYTES,
    ),
  ]);
  const runs = await mapWithConcurrency(
    candidates.selected,
    DASHBOARD_READ_CONCURRENCY,
    readRunSummary,
  );
  runs.push(
    ...candidates.omitted.map((candidate) => ({
      run_id: candidate.runId,
      active: candidate.active,
      status: "unreadable",
      updated_at: candidate.modifiedAt,
      findings: 0,
      unreadable: true,
      error: "Run omitted from the bounded dashboard snapshot.",
    })),
  );
  runs.sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  const active = runs.filter((run) => run.active && !run.unreadable);
  return {
    schema_version: "1",
    generated_at: new Date().toISOString(),
    server: {
      version: reviewMeshVersion,
      host: input.server.host,
      port: input.server.port,
      started_at: input.server.startedAt,
      uptime_ms: Math.max(0, Date.now() - Date.parse(input.server.startedAt)),
      transport: "server-sent-events",
      read_only: true,
    },
    ...catalog,
    runs,
    counts: {
      active_runs: active.length,
      running_reviewers: active.reduce(
        (total, run) => total + (integer(run.model_runs?.running) ?? 0),
        0,
      ),
      queued_reviewers: active.reduce(
        (total, run) =>
          total +
          (integer(run.model_runs?.queued) ?? 0) +
          (integer(run.model_runs?.deferred) ?? 0),
        0,
      ),
      partial_runs: runs.filter((run) => run.coverage_outcome === "partial")
        .length,
    },
  };
}

function normalizeFinding(value: RawRunFinding | ConsolidatedRunFinding) {
  return bounded(value) as Record<string, unknown>;
}

function rawFindings(
  reviewers: readonly ReviewerRuntime[],
  reviewScope: "changes" | "full" = "full",
  gitContext: { changedFiles: readonly string[]; diff: string } = {
    changedFiles: [],
    diff: "",
  },
  contextHead: string | null = null,
): RawRunFinding[] {
  const values: RawRunFinding[] = [];
  const adjudicationDecisions = new Map<
    string,
    Map<string, ReturnType<typeof validateAdjudication>["decisions"][number]>
  >();
  for (const reviewer of reviewers) {
    if (
      reviewer.mode !== "adjudication" ||
      reviewer.adjudicates_reviewer_id === undefined ||
      !Array.isArray(reviewer.result?.decisions)
    ) {
      continue;
    }
    const source = reviewers.find(
      (candidate) => candidate.reviewer_id === reviewer.adjudicates_reviewer_id,
    );
    const candidateResult = reviewerResultV3Schema.safeParse(source?.result);
    const adjudicationResult = adjudicationResultSchema.safeParse(
      reviewer.result,
    );
    if (!candidateResult.success || !adjudicationResult.success) continue;
    const validationContext = { reviewScope, git: gitContext } as const;
    const attestation = reviewer.adjudication_validation;
    const outcome =
      attestation === undefined
        ? failClosedAdjudicationOutcome(
            candidateResult.data,
            adjudicationResult.data,
          )
        : (verifyAdjudicationValidationAttestation({
            attestation,
            candidateResult: candidateResult.data,
            adjudicationResult: adjudicationResult.data,
            contextHead,
            validationContext,
          }) ??
          failClosedAdjudicationOutcome(
            candidateResult.data,
            adjudicationResult.data,
          ));
    const decisions = new Map(
      outcome.decisions.map((decision) => [
        decision.source_finding_id,
        decision,
      ]),
    );
    adjudicationDecisions.set(reviewer.adjudicates_reviewer_id, decisions);
  }
  for (const reviewer of reviewers) {
    const result = reviewer.result;
    const findings = Array.isArray(result?.actionable_findings)
      ? result.actionable_findings
      : [];
    for (const [index, value] of findings.entries()) {
      const finding = asRecord(value);
      if (finding === undefined) continue;
      const findingId = text(finding.id) ?? `finding-${index + 1}`;
      const severity = text(finding.severity);
      const confidence = text(finding.confidence) ?? "medium";
      const classification =
        text(finding.classification) ?? "needs_verification";
      const adjudicationDecision = adjudicationDecisions
        .get(reviewer.reviewer_id)
        ?.get(findingId);
      const adjusted = adjudicationDecision?.effective_finding;
      const effectiveSeverity = adjusted?.severity ?? severity;
      const effectiveConfidence = adjusted?.confidence ?? confidence;
      const effectiveClassification =
        adjudicationDecision?.effective_decision === "needs_verification"
          ? "needs_verification"
          : (adjusted?.classification ?? classification);
      if (
        !["critical", "high", "medium", "low"].includes(severity ?? "") ||
        !["high", "medium", "low"].includes(confidence) ||
        !["confirmed_defect", "needs_verification", "advisory"].includes(
          classification,
        )
      ) {
        continue;
      }
      const evidence = Array.isArray(finding.evidence)
        ? finding.evidence
            .map(asRecord)
            .filter(
              (entry): entry is Record<string, unknown> => entry !== undefined,
            )
            .map((entry) => ({
              ...(text(entry.path) === undefined
                ? {}
                : { path: text(entry.path)! }),
              ...(integer(entry.start_line) === undefined
                ? {}
                : { start_line: integer(entry.start_line)! }),
              ...(integer(entry.end_line) === undefined
                ? {}
                : { end_line: integer(entry.end_line)! }),
              detail: text(entry.detail) ?? "Evidence detail unavailable.",
            }))
        : [];
      values.push({
        source_ref: `${reviewer.reviewer_id}#${findingId}`,
        reviewer_id: reviewer.reviewer_id,
        lens_id: reviewer.lens_id,
        finding_id: findingId,
        severity: effectiveSeverity as RawRunFinding["severity"],
        title: adjusted?.title ?? text(finding.title) ?? "Untitled finding",
        description:
          adjusted?.description ??
          text(finding.description) ??
          "Finding detail unavailable.",
        evidence:
          adjusted?.evidence.map((entry) => ({
            ...(entry.path === undefined ? {} : { path: entry.path }),
            ...(entry.start_line === undefined
              ? {}
              : { start_line: entry.start_line }),
            ...(entry.end_line === undefined
              ? {}
              : { end_line: entry.end_line }),
            detail: entry.detail,
          })) ?? evidence,
        suggested_direction:
          adjusted?.suggested_direction ??
          text(finding.suggested_direction) ??
          "Investigate and correct the defect.",
        confidence: effectiveConfidence as RawRunFinding["confidence"],
        classification:
          effectiveClassification as RawRunFinding["classification"],
        external_assumptions:
          adjusted?.external_assumptions ??
          (Array.isArray(finding.external_assumptions)
            ? finding.external_assumptions
                .map(text)
                .filter((entry): entry is string => entry !== undefined)
            : []),
        source_findings: [
          { reviewer_id: reviewer.reviewer_id, finding_id: findingId },
        ],
        duplicate_finding_ids: Array.isArray(finding.duplicate_finding_ids)
          ? finding.duplicate_finding_ids
              .map(text)
              .filter((entry): entry is string => entry !== undefined)
          : [],
        ...((adjusted?.root_issue_id ?? text(finding.root_issue_id)) ===
        undefined
          ? {}
          : {
              deduplication_key:
                adjusted?.root_issue_id ?? text(finding.root_issue_id)!,
            }),
        ...(text(finding.duplicate_of) === undefined
          ? {}
          : { duplicate_of: text(finding.duplicate_of)! }),
        gate_eligible:
          effectiveClassification === "confirmed_defect" &&
          adjudicationDecision?.effective_decision !== "rejected" &&
          adjudicationDecision?.effective_decision !== "needs_verification",
        adjudication:
          adjudicationDecision?.effective_decision ?? "unadjudicated",
        ...(adjusted === undefined
          ? {}
          : {
              effective_finding: {
                severity: adjusted.severity,
                title: adjusted.title,
                description: adjusted.description,
                evidence: adjusted.evidence.map((entry) => ({
                  ...(entry.path === undefined ? {} : { path: entry.path }),
                  ...(entry.start_line === undefined
                    ? {}
                    : { start_line: entry.start_line }),
                  ...(entry.end_line === undefined
                    ? {}
                    : { end_line: entry.end_line }),
                  detail: entry.detail,
                })),
                suggested_direction: adjusted.suggested_direction,
                confidence: adjusted.confidence,
                classification: adjusted.classification,
                ...(adjusted.root_issue_id === undefined
                  ? {}
                  : { root_issue_id: adjusted.root_issue_id }),
                external_assumptions: [...adjusted.external_assumptions],
              },
            }),
      });
    }
  }
  return values;
}

function dashboardGatePolicies(
  reviewers: readonly ReviewerRuntime[],
): Record<string, CanonicalGatePolicy> {
  return Object.fromEntries(
    reviewers.map((reviewer) => {
      const policy = reviewer.policy ?? {};
      const minimumSeverity = text(policy.gateMinimumSeverity);
      const minimumConfidence = text(policy.gateMinimumConfidence);
      return [
        reviewer.lens_id,
        {
          minimumSeverity: (minimumSeverity === "critical" ||
          minimumSeverity === "high" ||
          minimumSeverity === "medium" ||
          minimumSeverity === "low"
            ? minimumSeverity
            : "medium") as CanonicalGatePolicy["minimumSeverity"],
          minimumConfidence: (minimumConfidence === "high" ||
          minimumConfidence === "medium" ||
          minimumConfidence === "low"
            ? minimumConfidence
            : "medium") as CanonicalGatePolicy["minimumConfidence"],
        },
      ];
    }),
  );
}

export async function readDashboardRun(input: {
  appPaths: AppPaths;
  runId: string;
  afterOpen?: () => void | Promise<void>;
}): Promise<Record<string, unknown>> {
  requireSafeRunId(input.runId);
  const candidate = (
    await listRunFiles(input.appPaths.runsDirectory, Number.MAX_SAFE_INTEGER)
  ).selected.find((item) => item.runId === input.runId);
  if (candidate === undefined)
    throw new Error(`Run ${input.runId} was not found.`);
  const parsed = await parseCandidate(candidate, input.afterOpen);
  const summary = runSummaryFromParsed(parsed);
  const reviewers = buildReviewerRuntime(parsed);
  const publicEvents = parsed.events.map((event) => ({
    event: event.event,
    seq: event.seq,
    timestamp: event.timestamp,
    ...(event.reviewer_id === undefined
      ? {}
      : { reviewer_id: event.reviewer_id }),
    data: bounded(event.data),
  }));
  const scope =
    asRecord(parsed.request?.review_scope)?.mode === "changes"
      ? "changes"
      : "full";
  const context = parsed.context ?? {};
  const git = asRecord(context.git);
  const raw = rawFindings(
    reviewers,
    scope,
    {
      changedFiles: Array.isArray(git?.changed_files)
        ? git.changed_files
            .map(text)
            .filter((value): value is string => value !== undefined)
        : [],
      diff: text(git?.diff) ?? "",
    },
    typeof git?.head === "string" ? git.head : null,
  );
  const canonical = canonicalizeFindings(
    raw as readonly CanonicalRawFinding[],
    { gatePolicies: dashboardGatePolicies(reviewers) },
  );
  const findings = {
    raw: canonical.raw.map(normalizeFinding),
    consolidated: canonical.consolidated.map(normalizeFinding),
    gate_effective: canonical.gate_effective.map(normalizeFinding),
    advisory: canonical.advisory.map(normalizeFinding),
    counts: canonical.counts,
  };
  const startedAt = timestamp(parsed.started?.timestamp);
  const completedAt = timestamp(parsed.completed?.timestamp);
  const stage = runStage(parsed, reviewers);
  const retry = eventData(parsed.started);
  const response = {
    ...summary,
    stage,
    ...(text(retry.parent_run_id) === undefined
      ? {}
      : { parent_run_id: text(retry.parent_run_id)! }),
    ...(startedAt === undefined ? {} : { started_at: startedAt }),
    ...(completedAt === undefined ? {} : { finished_at: completedAt }),
    context: bounded(contextData(parsed)),
    suite: bounded(eventData(parsed.suiteEvent)),
    lenses: groupLenses(reviewers),
    reviewers: reviewers.map((reviewer) => ({
      ...reviewer,
      ...(reviewer.result === undefined
        ? {}
        : { result: structuredClone(reviewer.result) }),
    })),
    findings,
    events: publicEvents,
    activity_notice:
      "Review Mesh stores sanitized phase and activity summaries, not the provider's full chat transcript.",
  };
  const sanitized = bounded(response) as Record<string, unknown>;
  const sanitizedReviewers = Array.isArray(sanitized.reviewers)
    ? sanitized.reviewers.map(asRecord)
    : [];
  sanitized.reviewers = response.reviewers.map((reviewer, index) => ({
    ...(sanitizedReviewers[index] ?? {}),
    ...(reviewer.result === undefined
      ? {}
      : { result: structuredClone(reviewer.result) }),
    ...(reviewer.result_digest === undefined
      ? {}
      : { result_digest: reviewer.result_digest }),
    ...(reviewer.result_byte_count === undefined
      ? {}
      : { result_byte_count: reviewer.result_byte_count }),
  }));
  return sanitized;
}

export async function readDashboardReviewer(input: {
  appPaths: AppPaths;
  runId: string;
  reviewerId: string;
}): Promise<Record<string, unknown>> {
  const run = await readDashboardRun({
    appPaths: input.appPaths,
    runId: input.runId,
  });
  const reviewers = Array.isArray(run.reviewers) ? run.reviewers : [];
  const reviewer = reviewers
    .map(asRecord)
    .find((value) => value?.reviewer_id === input.reviewerId);
  if (reviewer === undefined) {
    throw new Error(`Reviewer ${input.reviewerId} was not found.`);
  }
  return {
    run_id: input.runId,
    ...reviewer,
    activity_notice: run.activity_notice,
  } as Record<string, unknown>;
}

export async function dashboardFingerprint(
  appPaths: AppPaths,
): Promise<string> {
  const [runs, config] = await Promise.all([
    listRunFiles(appPaths.runsDirectory, Number.MAX_SAFE_INTEGER).then(
      (result) => result.selected,
    ),
    stat(appPaths.configFile)
      .then((metadata) => `${metadata.size}:${metadata.mtimeMs}`)
      .catch(() => "missing"),
  ]);
  return `${config}|${runs
    .map(
      (run) =>
        `${run.runId}:${run.active ? "a" : "f"}:${run.size}:${run.modifiedAt}`,
    )
    .join("|")}`;
}
