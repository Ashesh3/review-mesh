import { describe, expect, it } from "vitest";
import {
  prioritizeSegmentReads,
  type SourceRange,
} from "../../src/adapters/segment-followups.js";

const range = (
  path: string,
  offset: number,
  byte_count: number,
  kind: SourceRange["kind"] = "snapshot",
): SourceRange => ({ kind, path, offset, byte_count });
const bytes = (ranges: SourceRange[]) =>
  [
    ...new Set(
      ranges.flatMap((r) =>
        Array.from(
          { length: r.byte_count },
          (_, i) => `${r.kind}:${r.path}:${r.offset + i}`,
        ),
      ),
    ),
  ].sort();

describe("follow-up queue prioritization", () => {
  it("moves requested pending slices forward without duplicates or lost bytes", () => {
    const queue = [
      range("<caller-context>", 0, 4, "context"),
      range("a", 0, 10),
      range("b", 0, 5),
    ];
    const requested = [range("a", 3, 4), range("a", 5, 4), range("b", 1, 2)];
    const result = prioritizeSegmentReads(queue, requested);
    expect(result).toEqual([
      queue[0],
      range("a", 3, 4),
      range("a", 7, 2),
      range("b", 1, 2),
      range("a", 0, 3),
      range("a", 9, 1),
      range("b", 0, 1),
      range("b", 3, 2),
    ]);
    expect(bytes(result)).toEqual(bytes([...queue, ...requested]));
    expect(result.reduce((sum, r) => sum + r.byte_count, 0)).toBe(
      bytes(result).length,
    );
    expect(queue).toEqual([
      range("<caller-context>", 0, 4, "context"),
      range("a", 0, 10),
      range("b", 0, 5),
    ]);
  });
  it("appends supporting and repeated delivered reads behind pending mandatory work", () => {
    const queue = [range("required", 20, 10), range("later", 0, 5)];
    const requested = [
      range("required", 0, 5),
      range("support", 0, 8),
      range("support", 0, 8),
    ];
    expect(prioritizeSegmentReads(queue, requested)).toEqual([
      ...queue,
      requested[0],
      requested[1],
    ]);
    // On the next checkpoint another reread cannot displace pending work.
    expect(prioritizeSegmentReads(queue, [range("required", 0, 5)])[0]).toEqual(
      queue[0],
    );
  });
  it("keeps partially pending context ahead of every source request", () => {
    const queue = [
      range("<caller-context>", 10, 10, "context"),
      range("source", 0, 10),
    ];
    const requested = [
      range("source", 5, 2),
      range("<caller-context>", 15, 10, "context"),
    ];
    const result = prioritizeSegmentReads(queue, requested);
    expect(result[0]).toEqual(queue[0]);
    expect(result[1]).toEqual(requested[0]);
    expect(result.at(-1)).toEqual(range("<caller-context>", 20, 5, "context"));
    expect(bytes(result)).toEqual(bytes([...queue, ...requested]));
  });
  it("retains empty-file delivery obligations once and keeps kinds separate", () => {
    const queue = [range("empty", 0, 0), range("shared", 0, 2, "diff")];
    const requested = [range("empty", 0, 0), range("shared", 0, 2, "snapshot")];
    expect(prioritizeSegmentReads(queue, requested)).toEqual([
      ...queue,
      requested[1],
    ]);
  });
});
