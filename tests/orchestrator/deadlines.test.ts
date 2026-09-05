import { describe, expect, it } from "vitest";
import {
  deadlineCause,
  selectRunDeadline,
} from "../../src/orchestrator/deadlines.js";

const adaptiveExecution = {
  deadline_mode: "adaptive" as const,
  no_progress_timeout_ms: 300_000,
};

function changes(fileCount: number, rawDiffBytes: number) {
  return {
    review_scope: { mode: "changes" as const, source: "request" as const },
    git: {
      is_repository: true as const,
      changed_files: Array.from(
        { length: fileCount },
        (_, index) => `src/file-${index}.ts`,
      ),
      raw_diff: { byte_count: rawDiffBytes, sha256: "a".repeat(64) },
      truncated: { changed_files: false, diff: false },
    },
  };
}

describe("selectRunDeadline", () => {
  it("selects the inclusive small tier for the motivating five-file diff", () => {
    expect(
      selectRunDeadline(changes(5, 23_285), adaptiveExecution, new Date(0)),
    ).toMatchObject({ tier: "small", duration_ms: 1_800_000 });
  });

  it("uses inclusive tier boundaries and promotes either exceeded input", () => {
    expect(
      selectRunDeadline(changes(3, 16 * 1024), adaptiveExecution, new Date(0))
        .tier,
    ).toBe("tiny");
    expect(
      selectRunDeadline(changes(4, 1), adaptiveExecution, new Date(0)).tier,
    ).toBe("small");
    expect(
      selectRunDeadline(
        changes(1, 16 * 1024 + 1),
        adaptiveExecution,
        new Date(0),
      ).tier,
    ).toBe("small");
    expect(
      selectRunDeadline(changes(51, 1), adaptiveExecution, new Date(0)).tier,
    ).toBe("large");
  });

  it("selects large for full or truncated scope and reports exact inputs", () => {
    const context = changes(1, 10);
    context.git.truncated.diff = true;
    expect(
      selectRunDeadline(context, adaptiveExecution, new Date(1000)),
    ).toEqual({
      mode: "adaptive",
      tier: "large",
      duration_ms: 5_400_000,
      started_at: "1970-01-01T00:00:01.000Z",
      deadline_at: "1970-01-01T01:30:01.000Z",
      inputs: {
        review_scope: "changes",
        changed_file_count: 1,
        raw_diff_byte_count: 10,
        changed_files_truncated: false,
        diff_truncated: true,
      },
    });
  });

  it("uses the configured fixed deadline", () => {
    expect(
      selectRunDeadline(
        changes(5, 23_285),
        {
          deadline_mode: "fixed",
          run_deadline_ms: 75_000,
          no_progress_timeout_ms: 300_000,
        },
        new Date(0),
      ),
    ).toMatchObject({ mode: "fixed", tier: "fixed", duration_ms: 75_000 });
  });
});

describe("deadlineCause", () => {
  it("uses caller, run, lens, candidate, attempt, progress precedence", () => {
    const allExpired = {
      now: 100,
      cancelled: true,
      run: 10,
      lens: 20,
      candidate: 30,
      attempt: 40,
      progress: 50,
    };
    expect(deadlineCause(allExpired)).toBe("cancelled");
    expect(deadlineCause({ ...allExpired, cancelled: false })).toBe(
      "run_deadline_exceeded",
    );
    expect(deadlineCause({ ...allExpired, cancelled: false, run: 200 })).toBe(
      "lens_deadline_exceeded",
    );
    expect(
      deadlineCause({ ...allExpired, cancelled: false, run: 200, lens: 200 }),
    ).toBe("model_candidate_deadline_exceeded");
    expect(
      deadlineCause({
        ...allExpired,
        cancelled: false,
        run: 200,
        lens: 200,
        candidate: 200,
      }),
    ).toBe("attempt_deadline_exceeded");
    expect(
      deadlineCause({
        ...allExpired,
        cancelled: false,
        run: 200,
        lens: 200,
        candidate: 200,
        attempt: 200,
      }),
    ).toBe("no_progress_timeout");
    expect(
      deadlineCause({
        ...allExpired,
        cancelled: false,
        run: 200,
        lens: 200,
        candidate: 200,
        attempt: 200,
        progress: 200,
      }),
    ).toBeUndefined();
  });
});
