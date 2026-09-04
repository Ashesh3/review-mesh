import { describe, expect, it } from "vitest";
import { createActivityTracker } from "../../src/orchestrator/activity.js";

describe("bounded run activity", () => {
  it("starts no-progress at admission and accepts reused identities in a new attempt", () => {
    const tracker = createActivityTracker({ startedAt: 0 });
    tracker.record({ reviewerId: "a", phase: "queued", at: 1 });
    tracker.admitAttempt("a", "attempt-1", 300_000);
    expect(tracker.snapshot("a", 300_010).lastProgressAgeMs).toBe(10);
    tracker.record({
      reviewerId: "a",
      phase: "reviewing",
      at: 300_020,
      attemptId: "attempt-1",
      progress: { kind: "tool", identity: "read-1" },
    });
    tracker.admitAttempt("a", "attempt-2", 600_000);
    tracker.record({
      reviewerId: "a",
      phase: "reviewing",
      at: 600_005,
      attemptId: "attempt-1",
      progress: { kind: "tool", identity: "late" },
    });
    expect(tracker.snapshot("a", 600_010).lastProgressAgeMs).toBe(10);
    tracker.record({
      reviewerId: "a",
      phase: "reviewing",
      at: 600_020,
      attemptId: "attempt-2",
      progress: { kind: "tool", identity: "read-1" },
    });
    expect(tracker.snapshot("a", 600_030).lastProgressAgeMs).toBe(10);
  });

  it("does not let one reviewer exhaust another reviewer's progress identities", () => {
    const tracker = createActivityTracker({
      startedAt: 0,
      maximumIdentities: 1,
    });
    tracker.record({
      reviewerId: "a",
      phase: "reviewing",
      at: 1,
      progress: { kind: "tool", identity: "a" },
    });
    tracker.record({
      reviewerId: "a",
      phase: "reviewing",
      at: 2,
      progress: { kind: "tool", identity: "b" },
    });
    tracker.record({
      reviewerId: "b",
      phase: "reviewing",
      at: 3,
      progress: { kind: "tool", identity: "a" },
    });
    expect(tracker.snapshot("b", 4).lastProgressAgeMs).toBe(1);
  });

  it("retains terminal activity after failures fill the buffer", () => {
    const tracker = createActivityTracker({ startedAt: 0, maximumRecords: 2 });
    tracker.record({
      reviewerId: "a",
      phase: "reviewing",
      at: 1,
      material: "failure",
    });
    tracker.record({
      reviewerId: "a",
      phase: "reviewing",
      at: 2,
      material: "failure",
    });
    tracker.record({
      reviewerId: "a",
      phase: "terminal",
      at: 3,
      material: "terminal",
    });
    expect(
      tracker.records().some((record) => record.material === "terminal"),
    ).toBe(true);
    expect(tracker.summaries()[0]?.material_counts).toEqual({
      failure: 2,
      terminal: 1,
    });
  });

  it("keeps first and last timestamps correct for out-of-order delivery", () => {
    const tracker = createActivityTracker({ startedAt: 0 });
    tracker.record({ reviewerId: "a", phase: "reviewing", at: 20 });
    tracker.record({ reviewerId: "a", phase: "reviewing", at: 10 });
    expect(tracker.summaries()[0]).toMatchObject({
      first_at: 10,
      last_at: 20,
      phases: [{ first_at: 10, last_at: 20 }],
    });
  });
  it("does not count duplicate phase text or a repeated progress identity as progress", () => {
    const tracker = createActivityTracker({ startedAt: 0 });
    tracker.record({
      reviewerId: "one",
      phase: "reviewing",
      at: 10,
      message: "Working",
    });
    tracker.record({
      reviewerId: "one",
      phase: "reviewing",
      at: 20,
      message: "Working",
    });
    expect(tracker.snapshot("one", 30).lastProgressAgeMs).toBe(30);
    tracker.record({
      reviewerId: "one",
      phase: "reviewing",
      at: 40,
      progress: { kind: "tool", identity: "tool-1" },
    });
    tracker.record({
      reviewerId: "one",
      phase: "reviewing",
      at: 50,
      progress: { kind: "tool", identity: "tool-1" },
    });
    expect(tracker.snapshot("one", 60).lastProgressAgeMs).toBe(20);
    expect(tracker.snapshot("one", 60).coalescedCount).toBe(2);
  });

  it("requires stream byte counts to advance for the same response", () => {
    const tracker = createActivityTracker({ startedAt: 0 });
    for (const [at, bytes] of [
      [10, 10],
      [20, 10],
      [30, 5],
      [40, 11],
    ] as const) {
      tracker.record({
        reviewerId: "one",
        phase: "reviewing",
        at,
        progress: { kind: "bytes", identity: "response-1", bytes },
      });
    }
    expect(tracker.snapshot("one", 50).lastProgressAgeMs).toBe(10);
    tracker.record({
      reviewerId: "one",
      phase: "reviewing",
      at: 60,
      progress: { kind: "bytes", identity: "response-2", bytes: 1 },
    });
    expect(tracker.snapshot("one", 70).lastProgressAgeMs).toBe(10);
  });

  it("keeps ten thousand repeated activities bounded and preserves final phase summaries", () => {
    const tracker = createActivityTracker({ startedAt: 0 });
    for (let index = 1; index <= 10_000; index++) {
      tracker.record({
        reviewerId: "one",
        phase: "reviewing",
        at: index,
        message: "Still waiting",
      });
    }
    tracker.record({
      reviewerId: "one",
      phase: "finalizing",
      at: 10_001,
      material: "failure",
      message: "Provider failed",
    });
    const records = tracker.records();
    const summary = tracker.summaries()[0]!;
    expect(records.length).toBeLessThanOrEqual(2_048);
    expect(
      Buffer.byteLength(JSON.stringify(records), "utf8"),
    ).toBeLessThanOrEqual(1024 * 1024);
    expect(records.some((record) => record.material === "failure")).toBe(true);
    expect(summary.suppressed_count).toBe(9_999);
    expect(summary.first_at).toBe(1);
    expect(summary.last_at).toBe(10_001);
    expect(summary.phases).toMatchObject([
      { phase: "reviewing", first_at: 1, last_at: 10_000, events: 10_000 },
      { phase: "finalizing", first_at: 10_001, last_at: 10_001, events: 1 },
    ]);
  });

  it("continues tracking material summaries after its activity byte budget fills", () => {
    const tracker = createActivityTracker({
      startedAt: 0,
      maximumRecords: 3,
      maximumBytes: 700,
    });
    for (let index = 1; index <= 20; index++) {
      tracker.record({
        reviewerId: "one",
        phase: "reviewing",
        at: index,
        material: "file_access",
        message: `File ${index}`,
        progress: { kind: "tool", identity: `read-${index}` },
      });
    }
    tracker.record({
      reviewerId: "one",
      phase: "finalizing",
      at: 21,
      material: "terminal",
    });
    expect(tracker.records().length).toBeLessThanOrEqual(3);
    expect(tracker.byteCount).toBeLessThanOrEqual(700);
    const summary = tracker.summaries()[0]!;
    expect(summary.overflow).toBe(true);
    expect(summary.material_counts.file_access).toBe(20);
    expect(summary.material_counts.terminal).toBe(1);
    expect(summary.last_progress_at).toBe(20);
    expect(summary.phases.at(-1)?.phase).toBe("finalizing");
  });

  it("does not reset no-progress when retained identity capacity is exhausted", () => {
    const tracker = createActivityTracker({
      startedAt: 0,
      maximumIdentities: 2,
    });
    tracker.record({
      reviewerId: "one",
      phase: "reviewing",
      at: 1,
      progress: { kind: "tool", identity: "a" },
    });
    tracker.record({
      reviewerId: "one",
      phase: "reviewing",
      at: 2,
      progress: { kind: "tool", identity: "b" },
    });
    tracker.record({
      reviewerId: "one",
      phase: "reviewing",
      at: 3,
      progress: { kind: "tool", identity: "c" },
    });
    tracker.record({
      reviewerId: "one",
      phase: "reviewing",
      at: 4,
      progress: { kind: "tool", identity: "a" },
    });
    expect(tracker.snapshot("one", 5).lastProgressAgeMs).toBe(3);
    expect(tracker.summaries()[0]?.identity_overflow).toBe(true);
  });

  it("uses independent progress clocks and returns defensive copies", () => {
    const tracker = createActivityTracker({ startedAt: 0 });
    tracker.record({
      reviewerId: "a",
      phase: "reviewing",
      at: 4,
      progress: { kind: "page", identity: "page-0" },
    });
    tracker.record({
      reviewerId: "b",
      phase: "reviewing",
      at: 8,
      progress: { kind: "response", identity: "response" },
    });
    expect(tracker.snapshot("a", 10).lastProgressAgeMs).toBe(6);
    expect(tracker.snapshot("b", 10).lastProgressAgeMs).toBe(2);
    tracker.records()[0]!.phase = "changed";
    expect(tracker.records()[0]?.phase).toBe("reviewing");
    expect(tracker.snapshot("a", 10, true).coalescedCount).toBe(0);
  });

  it("redacts private activity text and exposes overflow in explicit full detail mode", () => {
    const tracker = createActivityTracker({
      startedAt: 0,
      detail: "full",
      maximumRecords: 2,
    });
    tracker.record({
      reviewerId: "a",
      phase: "reviewing",
      at: 1,
      message: "api_key=do-not-store-this",
    });
    tracker.record({
      reviewerId: "a",
      phase: "reviewing",
      at: 2,
      message: "Waiting",
    });
    tracker.record({
      reviewerId: "a",
      phase: "reviewing",
      at: 3,
      message: "Waiting",
    });
    expect(JSON.stringify(tracker.records())).not.toContain(
      "do-not-store-this",
    );
    expect(tracker.records()).toHaveLength(2);
    expect(tracker.summaries()[0]).toMatchObject({
      overflow: true,
      suppressed_count: 1,
    });
  });
});
