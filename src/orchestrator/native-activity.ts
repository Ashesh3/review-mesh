import type { AdapterEvent } from "../adapters/types.js";
import { sanitizePublicText } from "../adapters/errors.js";
import type { ActivityRecord, ActivitySummary } from "./activity.js";

type ActivityDraft =
  | { record: "reviewer.activity"; reviewer_id: string; data: ActivityRecord }
  | {
      record: "reviewer.activity_summary";
      reviewer_id: string;
      data: ActivitySummary;
    };

/** Bounded disk telemetry; callers update their progress watchdog for every event. */
export function createNativeActivityRecorder(options: {
  reviewerId: string;
  startedAt: number;
  intervalMs?: number;
  maximumSamples?: number;
}) {
  const interval = options.intervalMs ?? 10_000;
  const maximumSamples = options.maximumSamples ?? 128;
  if (
    !Number.isSafeInteger(interval) ||
    interval < 1 ||
    !Number.isSafeInteger(maximumSamples) ||
    maximumSamples < 1
  )
    throw new TypeError(
      "Native activity sampling bounds must be positive integers.",
    );
  const summary: ActivitySummary = {
    reviewer_id: options.reviewerId,
    first_at: options.startedAt,
    last_at: options.startedAt,
    last_progress_at: options.startedAt,
    suppressed_count: 0,
    overflow: false,
    identity_overflow: false,
    material_counts: {},
    phases: [],
  };
  let count = 0;
  let persisted = 0;
  let samples = 0;
  let sampledAt = Number.NEGATIVE_INFINITY;
  let closed = false;
  let latest: ActivityRecord | undefined;
  let lastMeaningful: ActivityRecord | undefined;
  let latestId = 0;
  let meaningfulId = 0;
  let persistedId = 0;
  const summarized = (): ActivityDraft => ({
    record: "reviewer.activity_summary",
    reviewer_id: options.reviewerId,
    data: {
      ...structuredClone(summary),
      suppressed_count: Math.max(0, count - persisted),
    },
  });
  const sampled = (record: ActivityRecord, id: number): ActivityDraft => {
    persisted++;
    persistedId = id;
    return {
      record: "reviewer.activity",
      reviewer_id: options.reviewerId,
      data: record,
    };
  };
  return {
    record(
      event: Extract<AdapterEvent, { type: "activity" | "progress" }>,
      meaningful: boolean,
      at: number,
    ): ActivityDraft[] {
      if (closed) return [];
      count = Math.min(Number.MAX_SAFE_INTEGER, count + 1);
      const time = Math.max(options.startedAt, at);
      summary.last_at = Math.max(summary.last_at, time);
      if (meaningful)
        summary.last_progress_at = Math.max(summary.last_progress_at, time);
      const message = sanitizePublicText(event.message);
      latest = {
        reviewer_id: options.reviewerId,
        phase: "reviewing",
        at: time,
        meaningful_progress: meaningful,
        ...(message ? { message } : {}),
      };
      latestId = count;
      if (meaningful) {
        lastMeaningful = latest;
        meaningfulId = latestId;
      }
      if (summary.phases.length === 0)
        summary.phases.push({
          phase: "reviewing",
          first_at: time,
          last_at: time,
          events: 0,
        });
      summary.phases[0]!.last_at = time;
      summary.phases[0]!.events = count;
      if (time - sampledAt < interval) return [];
      if (samples >= maximumSamples) {
        summary.overflow = true;
        return [];
      }
      samples++;
      sampledAt = time;
      return [sampled(latest, latestId), summarized()];
    },
    finish(identityOverflow = false): ActivityDraft[] {
      if (closed) return [];
      closed = true;
      summary.identity_overflow = identityOverflow;
      if (count === 0) return [];
      const drafts: ActivityDraft[] = [];
      if (lastMeaningful && meaningfulId > persistedId)
        drafts.push(sampled(lastMeaningful, meaningfulId));
      if (latest && latestId > persistedId)
        drafts.push(sampled(latest, latestId));
      drafts.push(summarized());
      return drafts;
    },
  };
}
