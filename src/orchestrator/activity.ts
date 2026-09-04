import { createHash } from "node:crypto";
import { sanitizePublicText } from "../adapters/errors.js";

export type MeaningfulProgress = {
  kind: "tool" | "bytes" | "page" | "response";
  identity: string;
  /** Cumulative response bytes, never an increment or heartbeat count. */
  bytes?: number;
};

export type MaterialActivity =
  "file_access" | "request" | "response" | "page" | "failure" | "terminal";

export interface ActivityInput {
  reviewerId: string;
  phase: string;
  at: number;
  message?: string;
  progress?: MeaningfulProgress;
  material?: MaterialActivity;
  attemptId?: string;
}

export interface ActivityRecord {
  reviewer_id: string;
  phase: string;
  at: number;
  message?: string;
  material?: MaterialActivity;
  meaningful_progress: boolean;
}

interface PhaseActivity {
  phase: string;
  first_at: number;
  last_at: number;
  events: number;
}

export interface ActivitySummary {
  reviewer_id: string;
  first_at: number;
  last_at: number;
  last_progress_at: number;
  suppressed_count: number;
  overflow: boolean;
  identity_overflow: boolean;
  material_counts: Partial<Record<MaterialActivity, number>>;
  phases: PhaseActivity[];
}

export interface ActivityTrackerOptions {
  startedAt: number;
  detail?: "condensed" | "full";
  maximumRecords?: number;
  maximumBytes?: number;
  maximumIdentities?: number;
}

interface ReviewerActivity {
  summary: ActivitySummary;
  phase: string;
  coalesced: number;
  attemptId?: string;
  admittedAt: number;
  progressAt: number;
  identities: Map<string, number>;
}

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

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new TypeError(`${label} must be a positive safe integer`);
  return value;
}

/** Run-owned bounded telemetry; it never owns or resets any execution timer. */
export function createActivityTracker(options: ActivityTrackerOptions) {
  if (!Number.isSafeInteger(options.startedAt) || options.startedAt < 0)
    throw new TypeError("startedAt must be a nonnegative safe integer");
  const full = options.detail === "full";
  const maximumRecords = positiveInteger(
    options.maximumRecords ?? (full ? 16_384 : 2_048),
    "maximumRecords",
  );
  const maximumBytes = positiveInteger(
    options.maximumBytes ?? (full ? 8 * 1024 * 1024 : 1024 * 1024),
    "maximumBytes",
  );
  const maximumIdentities = positiveInteger(
    options.maximumIdentities ?? 16_384,
    "maximumIdentities",
  );
  const reviewers = new Map<string, ReviewerActivity>();
  const retained: Array<{
    value: ActivityRecord;
    bytes: number;
    priority: number;
  }> = [];
  let byteCount = 0;

  function reviewerFor(reviewerId: string, at: number): ReviewerActivity {
    if (!reviewerId || Buffer.byteLength(reviewerId, "utf8") > 128)
      throw new TypeError("reviewer ID must contain 1-128 UTF-8 bytes");
    if (!Number.isSafeInteger(at) || at < options.startedAt)
      throw new TypeError("activity time precedes run start or is invalid");
    let reviewer = reviewers.get(reviewerId);
    if (reviewer === undefined) {
      if (reviewers.size >= 1024)
        throw new Error("activity reviewer limit exceeded");
      reviewer = {
        phase: "",
        coalesced: 0,
        admittedAt: options.startedAt,
        progressAt: options.startedAt,
        identities: new Map(),
        summary: {
          reviewer_id: reviewerId,
          first_at: at,
          last_at: at,
          last_progress_at: options.startedAt,
          suppressed_count: 0,
          overflow: false,
          identity_overflow: false,
          material_counts: {},
          phases: [],
        },
      };
      reviewers.set(reviewerId, reviewer);
    }
    return reviewer;
  }

  function newProgress(
    input: ActivityInput,
    reviewer: ReviewerActivity,
  ): boolean {
    const progress = input.progress;
    if (progress === undefined) return false;
    if (
      reviewer.attemptId !== undefined &&
      input.attemptId !== reviewer.attemptId
    )
      return false;
    if (input.at < reviewer.admittedAt) return false;
    if (
      !progress.identity ||
      Buffer.byteLength(progress.identity, "utf8") > 4096
    )
      throw new TypeError("progress identity must contain 1-4096 UTF-8 bytes");
    const key = createHash("sha256")
      .update(
        JSON.stringify([input.reviewerId, progress.kind, progress.identity]),
      )
      .digest("hex");
    const old = reviewer.identities.get(key);
    let current = 1;
    if (progress.kind === "bytes") {
      if (!Number.isSafeInteger(progress.bytes) || progress.bytes! < 0)
        throw new TypeError(
          "response byte count must be a nonnegative safe integer",
        );
      current = progress.bytes!;
      if (current === 0 || (old !== undefined && current <= old)) return false;
    } else if (old !== undefined) return false;
    if (old === undefined && reviewer.identities.size >= maximumIdentities) {
      reviewer.summary.identity_overflow = true;
      return false;
    }
    reviewer.identities.set(key, current);
    reviewer.progressAt = Math.max(reviewer.progressAt, input.at);
    reviewer.summary.last_progress_at = Math.max(
      reviewer.summary.last_progress_at,
      input.at,
    );
    return true;
  }

  function suppress(reviewer: ReviewerActivity, overflow: boolean): void {
    reviewer.coalesced += 1;
    reviewer.summary.suppressed_count += 1;
    reviewer.summary.overflow ||= overflow;
  }

  return {
    get byteCount() {
      return byteCount;
    },
    admitAttempt(reviewerId: string, attemptId: string, at: number): void {
      if (!attemptId || Buffer.byteLength(attemptId, "utf8") > 128)
        throw new TypeError("attempt ID must contain 1-128 UTF-8 bytes");
      const reviewer = reviewerFor(reviewerId, at);
      if (reviewer.attemptId === attemptId || at < reviewer.admittedAt)
        throw new Error("attempt admission must advance to a new attempt");
      reviewer.attemptId = attemptId;
      reviewer.admittedAt = at;
      reviewer.progressAt = at;
      reviewer.identities.clear();
    },
    record(input: ActivityInput): {
      meaningful: boolean;
      phaseChanged: boolean;
      retained: boolean;
    } {
      if (!phases.has(input.phase))
        throw new TypeError("unknown reviewer activity phase");
      const reviewer = reviewerFor(input.reviewerId, input.at);
      const phaseChanged = reviewer.phase !== input.phase;
      reviewer.phase = input.phase;
      reviewer.summary.first_at = Math.min(reviewer.summary.first_at, input.at);
      reviewer.summary.last_at = Math.max(reviewer.summary.last_at, input.at);
      let phase = reviewer.summary.phases.find(
        (value) => value.phase === input.phase,
      );
      if (phase === undefined) {
        phase = {
          phase: input.phase,
          first_at: input.at,
          last_at: input.at,
          events: 0,
        };
        reviewer.summary.phases.push(phase);
      }
      phase.last_at = Math.max(phase.last_at, input.at);
      phase.first_at = Math.min(phase.first_at, input.at);
      phase.events += 1;
      if (input.material !== undefined)
        reviewer.summary.material_counts[input.material] =
          (reviewer.summary.material_counts[input.material] ?? 0) + 1;
      const meaningful = newProgress(input, reviewer);
      if (
        !full &&
        !phaseChanged &&
        !meaningful &&
        input.material === undefined
      ) {
        suppress(reviewer, false);
        return { meaningful, phaseChanged, retained: false };
      }
      const message = sanitizePublicText(input.message);
      const value: ActivityRecord = {
        reviewer_id: input.reviewerId,
        phase: input.phase,
        at: input.at,
        ...(message === undefined ? {} : { message }),
        ...(input.material === undefined ? {} : { material: input.material }),
        meaningful_progress: meaningful,
      };
      const bytes = Buffer.byteLength(JSON.stringify(value) + "\n", "utf8");
      const priority =
        input.material === "terminal"
          ? 4
          : input.material === "failure"
            ? 3
            : input.material !== undefined || phaseChanged
              ? 2
              : 1;
      // Reserve room for failures/terminal transitions by evicting ordinary
      // activity. All omitted material remains counted in the final summary.
      while (
        bytes <= maximumBytes &&
        (retained.length >= maximumRecords || byteCount + bytes > maximumBytes)
      ) {
        const index = retained.findIndex((entry) => entry.priority < priority);
        if (index < 0) break;
        const removed = retained.splice(index, 1)[0]!;
        byteCount -= removed.bytes;
        suppress(reviewers.get(removed.value.reviewer_id)!, true);
      }
      if (
        bytes > maximumBytes ||
        retained.length >= maximumRecords ||
        byteCount + bytes > maximumBytes
      ) {
        suppress(reviewer, true);
        return { meaningful, phaseChanged, retained: false };
      }
      retained.push({ value, bytes, priority });
      byteCount += bytes;
      return { meaningful, phaseChanged, retained: true };
    },
    snapshot(reviewerId: string, now: number, resetCoalesced = false) {
      const reviewer = reviewers.get(reviewerId);
      const coalescedCount = reviewer?.coalesced ?? 0;
      if (resetCoalesced && reviewer !== undefined) reviewer.coalesced = 0;
      return {
        lastProgressAgeMs: Math.max(
          0,
          now - (reviewer?.progressAt ?? options.startedAt),
        ),
        coalescedCount,
        phase: reviewer?.phase ?? "queued",
      };
    },
    records(): ActivityRecord[] {
      return structuredClone(retained.map((entry) => entry.value));
    },
    summaries(): ActivitySummary[] {
      return [...reviewers.values()]
        .map((reviewer) => structuredClone(reviewer.summary))
        .sort((left, right) =>
          left.reviewer_id < right.reviewer_id
            ? -1
            : left.reviewer_id > right.reviewer_id
              ? 1
              : 0,
        );
    },
  };
}

export type ActivityTracker = ReturnType<typeof createActivityTracker>;
