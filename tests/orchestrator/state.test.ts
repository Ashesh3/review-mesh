import { describe, expect, it } from "vitest";
import {
  aggregateRun,
  createSuiteState,
  exitCodeFor,
  summarizeSuite,
} from "../../src/orchestrator/state.js";
import type { RunStatus } from "../../src/protocol/schemas.js";
import {
  completedFail,
  completedPass,
  incomplete,
  resolvedReviewer,
  suiteState,
} from "../helpers/fixtures.js";

describe("suite state", () => {
  const precedenceCases: Array<
    [ReturnType<typeof suiteState>, RunStatus, 0 | 1 | 3]
  > = [
    [suiteState([completedPass("a"), completedPass("b")]), "passed", 0],
    [suiteState([completedPass("a"), completedFail("b")]), "findings", 1],
    [
      suiteState([completedFail("a"), incomplete("b", "timeout")]),
      "incomplete",
      3,
    ],
  ];

  it.each(precedenceCases)(
    "applies unanimous precedence",
    (state, status, exitCode) => {
      expect(aggregateRun(state).status).toBe(status);
      expect(exitCodeFor(status, false)).toBe(exitCode);
    },
  );

  it("lets incomplete override findings and interruption override the exit code", () => {
    const state = suiteState([
      completedFail("first"),
      incomplete("second", "process_crashed"),
    ]);

    expect(aggregateRun(state).status).toBe("incomplete");
    expect(exitCodeFor("passed", true)).toBe(4);
    expect(exitCodeFor("findings", true)).toBe(4);
    expect(exitCodeFor("incomplete", true)).toBe(4);
  });

  it("rejects illegal completed to reviewing transitions", () => {
    const state = createSuiteState([resolvedReviewer({ id: "a" })]);
    state.transition("a", "probing");
    state.transition("a", "starting");
    state.transition("a", "reviewing");
    state.complete("a", completedPass("a").result, "enforced_read_only");

    expect(() => state.transition("a", "reviewing")).toThrow(
      "illegal reviewer transition",
    );
  });

  it("rejects direct terminal transitions without a terminal payload", () => {
    const state = createSuiteState([resolvedReviewer({ id: "a" })]);
    state.transition("a", "probing");
    state.transition("a", "starting");
    state.transition("a", "reviewing");

    expect(() => state.transition("a", "completed" as never)).toThrow(
      "illegal reviewer transition",
    );
    expect(() => state.transition("a", "incomplete" as never)).toThrow(
      "illegal reviewer transition",
    );
    expect(
      state.complete("a", completedPass("a").result, "prompt_only").status,
    ).toBe("completed");
  });

  it("allows a successfully probed reviewer to wait before starting", () => {
    const state = createSuiteState([resolvedReviewer({ id: "a" })]);

    state.transition("a", "probing");
    state.transition("a", "queued");

    expect(state.transition("a", "starting").status).toBe("starting");
  });

  it("rejects a duplicate terminal result", () => {
    const state = createSuiteState([resolvedReviewer({ id: "a" })]);
    state.transition("a", "probing");
    state.transition("a", "starting");
    state.transition("a", "reviewing");
    state.complete("a", completedPass("a").result, "enforced_read_only");

    expect(() =>
      state.complete("a", completedPass("a").result, "enforced_read_only"),
    ).toThrow("already terminal");
  });

  it("rejects state changes for reviewers outside the resolved roster", () => {
    const state = createSuiteState([resolvedReviewer({ id: "a" })]);

    expect(() => state.transition("missing", "probing")).toThrow(
      'unknown reviewer id: "missing"',
    );
  });

  it("tracks reviewer activity and reports exact lifecycle summary counts", () => {
    const state = createSuiteState([
      resolvedReviewer({ id: "queued" }),
      resolvedReviewer({ id: "probing" }),
      resolvedReviewer({ id: "reviewing" }),
      resolvedReviewer({ id: "complete" }),
      resolvedReviewer({ id: "incomplete" }),
    ]);
    state.transition("probing", "probing");
    state.transition("reviewing", "probing");
    state.transition("reviewing", "starting");
    state.transition("reviewing", "reviewing");
    state.recordActivity("reviewing", "reading files");
    state.transition("complete", "probing");
    state.transition("complete", "starting");
    state.transition("complete", "reviewing");
    state.complete("complete", completedPass("complete").result, "prompt_only");
    state.incomplete("incomplete", {
      reason: "timeout",
      message: "Timed out.",
      retryable: true,
    });

    expect(state.reviewer("reviewing").lastActivity?.message).toBe(
      "reading files",
    );
    expect(summarizeSuite(state)).toEqual({
      total: 5,
      queued: 1,
      running: 2,
      completed: 1,
      incomplete: 1,
    });
  });

  it("aggregates terminal records in resolved roster order", () => {
    const state = suiteState([
      completedPass("first"),
      completedFail("second"),
      completedPass("third"),
    ]);

    expect(
      aggregateRun(state).reviewers.map((reviewer) => reviewer.reviewer_id),
    ).toEqual(["first", "second", "third"]);
  });

  it("isolates caller-owned inputs and returned snapshots from stored state", () => {
    const reviewer = resolvedReviewer({ id: "a", purpose: "original" });
    const capabilities = {
      available: true,
      authenticated: true,
      model_available: true,
      streaming: true,
      cancellation: true,
      maximumIsolation: "enforced_read_only" as const,
      message: "original",
    };
    const result = completedPass("a").result;
    const state = createSuiteState([reviewer]);
    state.transition("a", "probing");
    state.setCapabilities("a", capabilities);
    state.transition("a", "starting");
    state.transition("a", "reviewing");
    const completed = state.complete("a", result, "enforced_read_only");

    reviewer.purpose = "mutated";
    capabilities.message = "mutated";
    result.summary = "mutated";
    completed.reviewer.purpose = "snapshot mutation";
    completed.capabilities!.message = "snapshot mutation";
    completed.result!.summary = "snapshot mutation";
    completed.completedAt!.setFullYear(2000);

    const stored = state.reviewer("a");
    const aggregate = aggregateRun(state);
    expect(stored.reviewer.purpose).toBe("original");
    expect(stored.capabilities?.message).toBe("original");
    expect(stored.result?.summary).toBe("No actionable findings.");
    expect(stored.completedAt?.getFullYear()).not.toBe(2000);
    expect(aggregate.reviewers[0]?.status).toBe("completed");
    expect(
      aggregate.reviewers[0]?.status === "completed" &&
        aggregate.reviewers[0].result.summary,
    ).toBe("No actionable findings.");
  });
});
