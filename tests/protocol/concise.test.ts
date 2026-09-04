import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  boundedList,
  createHeartbeatBudget,
  runOutcome,
} from "../../src/protocol/concise.js";

describe("concise public output", () => {
  it("samples in deterministic order and hashes the full omitted list", () => {
    const input = Array.from(
      { length: 40 },
      (_, index) => `lens-${String(index).padStart(2, "0")}`,
    ).reverse();
    const result = boundedList(input, (value) => value);
    expect(result.items).toEqual([
      "lens-00",
      "lens-01",
      "lens-02",
      "lens-03",
      "lens-04",
      "lens-05",
      "lens-06",
      "lens-07",
    ]);
    expect(result.total).toBe(40);
    expect(result.omitted).toBe(32);
    const expected = Array.from(
      { length: 40 },
      (_, index) => `lens-${String(index).padStart(2, "0")}`,
    );
    expect(result.sha256).toBe(
      createHash("sha256").update(JSON.stringify(expected)).digest("hex"),
    );
    expect(input[0]).toBe("lens-39");
  });

  it("leads with cancellation then incomplete coverage, regardless of known findings", () => {
    expect(
      runOutcome({ cancelled: true, coverage: "partial", gateFindings: 2 }),
    ).toBe("cancelled");
    expect(
      runOutcome({ cancelled: false, coverage: "partial", gateFindings: 2 }),
    ).toBe("inconclusive");
    expect(
      runOutcome({ cancelled: false, coverage: "complete", gateFindings: 2 }),
    ).toBe("gate_findings");
    expect(
      runOutcome({ cancelled: false, coverage: "complete", gateFindings: 0 }),
    ).toBe("clear");
  });

  it("switches to minimal liveness and keeps emitting after detailed bytes are exhausted", () => {
    const budget = createHeartbeatBudget({
      intervalMs: 1000,
      maximumBytes: 750,
    });
    const detailed = {
      elapsed_ms: 1000,
      active: [{ reviewer_id: "x".repeat(300) }],
    };
    const minimal = { elapsed_ms: 1000, active_count: 1 };
    expect(budget.select(0, detailed, minimal)).toMatchObject({
      minimal: false,
    });
    expect(budget.select(999, detailed, minimal)).toBeUndefined();
    expect(budget.select(1000, detailed, minimal)).toMatchObject({
      minimal: false,
    });
    expect(budget.select(2000, detailed, minimal)).toMatchObject({
      minimal: true,
      data: minimal,
    });
    for (let now = 3000; now <= 81 * 60_000; now += 1000) {
      expect(budget.select(now, detailed, minimal)?.minimal).toBe(true);
    }
    expect(budget.detailedBytes).toBeLessThanOrEqual(750);
  });

  it("does not let material updates postpone scheduled heartbeats", () => {
    const budget = createHeartbeatBudget({ intervalMs: 1000 });
    expect(budget.select(0, { elapsed_ms: 0 }, {})).toBeDefined();
    expect(budget.select(950, { elapsed_ms: 950 }, {})).toBeUndefined();
    expect(budget.select(1000, { elapsed_ms: 1000 }, {})).toBeDefined();
  });

  it("rejects oversize minimal liveness instead of stopping future heartbeats silently", () => {
    const budget = createHeartbeatBudget({ intervalMs: 1000, maximumBytes: 1 });
    expect(() => budget.select(0, {}, { text: "x".repeat(16 * 1024) })).toThrow(
      /16 KiB/,
    );
    expect(budget.select(0, {}, { elapsed_ms: 0 })).toMatchObject({
      minimal: true,
    });
  });

  it("rejects oversized detailed events without hiding them in minimal mode", () => {
    const budget = createHeartbeatBudget({ intervalMs: 1000 });
    expect(() => budget.select(0, { text: "x".repeat(16 * 1024) }, {})).toThrow(
      /16 KiB/,
    );
    expect(budget.select(0, { elapsed_ms: 0 }, {})).toMatchObject({
      minimal: false,
    });
  });
});
