type DeadlineContext = {
  review_scope: { mode: "changes" | "full" };
  git:
    | { is_repository: false }
    | {
        is_repository: true;
        changed_files: readonly string[];
        raw_diff?: { byte_count: number };
        truncated: { changed_files: boolean; diff: boolean };
      };
};

export type DeadlineExecution =
  | {
      deadline_mode: "adaptive";
      run_deadline_ms?: number;
      no_progress_timeout_ms?: number;
    }
  | {
      deadline_mode: "fixed";
      run_deadline_ms: number;
      no_progress_timeout_ms?: number;
    };

export interface SelectedRunDeadline {
  mode: "adaptive" | "fixed";
  tier: "tiny" | "small" | "medium" | "large" | "fixed";
  duration_ms: number;
  started_at: string;
  deadline_at: string;
  inputs: {
    review_scope: "changes" | "full";
    changed_file_count: number;
    raw_diff_byte_count: number;
    changed_files_truncated: boolean;
    diff_truncated: boolean;
  };
}

const tiers = [
  { tier: "tiny" as const, files: 3, bytes: 16 * 1024, duration: 15 * 60_000 },
  {
    tier: "small" as const,
    files: 10,
    bytes: 64 * 1024,
    duration: 30 * 60_000,
  },
  {
    tier: "medium" as const,
    files: 50,
    bytes: 512 * 1024,
    duration: 60 * 60_000,
  },
] as const;

export function selectRunDeadline(
  context: DeadlineContext,
  execution: DeadlineExecution,
  startedAt: Date,
): SelectedRunDeadline {
  const git = context.git.is_repository ? context.git : undefined;
  const inputs = {
    review_scope: context.review_scope.mode,
    changed_file_count: git?.changed_files.length ?? 0,
    raw_diff_byte_count: git?.raw_diff?.byte_count ?? 0,
    changed_files_truncated: git?.truncated.changed_files ?? false,
    diff_truncated: git?.truncated.diff ?? false,
  };
  let tier: SelectedRunDeadline["tier"];
  let duration: number;
  if (execution.deadline_mode === "fixed") {
    tier = "fixed";
    duration = execution.run_deadline_ms;
  } else {
    const selected =
      inputs.review_scope === "changes" &&
      !inputs.changed_files_truncated &&
      !inputs.diff_truncated
        ? tiers.find(
            (candidate) =>
              inputs.changed_file_count <= candidate.files &&
              inputs.raw_diff_byte_count <= candidate.bytes,
          )
        : undefined;
    tier = selected?.tier ?? "large";
    duration = selected?.duration ?? 90 * 60_000;
  }
  return {
    mode: execution.deadline_mode,
    tier,
    duration_ms: duration,
    started_at: startedAt.toISOString(),
    deadline_at: new Date(startedAt.getTime() + duration).toISOString(),
    inputs,
  };
}

export interface DeadlineCauseInput {
  now: number | Date;
  cancelled: boolean;
  run?: number | Date;
  lens?: number | Date;
  candidate?: number | Date;
  attempt?: number | Date;
  progress?: number | Date;
}

function milliseconds(value: number | Date | undefined): number | undefined {
  return value instanceof Date ? value.getTime() : value;
}

export function deadlineCause(
  input: DeadlineCauseInput,
):
  | "cancelled"
  | "run_deadline_exceeded"
  | "lens_deadline_exceeded"
  | "model_candidate_deadline_exceeded"
  | "attempt_deadline_exceeded"
  | "no_progress_timeout"
  | undefined {
  if (input.cancelled) return "cancelled";
  const now = milliseconds(input.now)!;
  if (milliseconds(input.run) !== undefined && now >= milliseconds(input.run)!)
    return "run_deadline_exceeded";
  if (
    milliseconds(input.lens) !== undefined &&
    now >= milliseconds(input.lens)!
  )
    return "lens_deadline_exceeded";
  if (
    milliseconds(input.candidate) !== undefined &&
    now >= milliseconds(input.candidate)!
  )
    return "model_candidate_deadline_exceeded";
  if (
    milliseconds(input.attempt) !== undefined &&
    now >= milliseconds(input.attempt)!
  )
    return "attempt_deadline_exceeded";
  if (
    milliseconds(input.progress) !== undefined &&
    now >= milliseconds(input.progress)!
  )
    return "no_progress_timeout";
  return undefined;
}
