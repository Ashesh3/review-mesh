import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createV9EventWriter } from "../../src/protocol/v9-event-writer.js";

const terminal = {
  run_outcome: "clear",
  gate_outcome: "no_gate_findings",
  coverage_outcome: "complete",
  exit_code: 0,
  raw_source_findings: 0,
  atomic_subfindings: 0,
  canonical_roots: 0,
  gate_eligible_subfindings: 0,
  advisory_subfindings: 0,
  rejected_subfindings: 0,
  needs_verification_subfindings: 0,
  non_gating_subfindings: 0,
  incomplete_lenses: 0,
  result_delivery: {
    completed_results: 0,
    artifact: "complete",
    planned_public_stream: "references_only",
  },
  lens_summaries: [],
  exclusions: [],
  warnings: [],
  deficit_samples: [],
};
describe("v6 public writer", () => {
  it("finalizes the artifact before terminal output and refuses post-terminal writes", async () => {
    const output = new PassThrough();
    let text = "";
    output.on("data", (chunk) => {
      text += chunk.toString();
    });
    const order: string[] = [];
    const writer = createV9EventWriter({
      output,
      runId: "run-1",
      now: () => new Date(0),
      recordEvent: async (event) => {
        order.push(event.event);
      },
      finalize: async () => {
        expect(text).not.toContain("run.completed");
        order.push("artifact-finalized");
        return {
          path: "/artifact",
          sha256: "a".repeat(64),
          byte_count: 100,
          completed_results: 0,
        };
      },
      observe: async (outcome) => {
        expect(text).toContain("run.completed");
        order.push(outcome);
      },
    });
    await writer.emit({
      event: "run.started",
      data: { consistency_mode: "live_worktree" },
    });
    await writer.finish(terminal);
    expect(order).toEqual([
      "run.started",
      "artifact-finalized",
      "references_only",
    ]);
    const events = text
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.map((event) => event.schema_version)).toEqual(["6", "6"]);
    expect(events.at(-1).data.artifact.sha256).toBe("a".repeat(64));
    await expect(
      writer.emit({
        event: "run.started",
        data: { consistency_mode: "live_worktree" },
      }),
    ).rejects.toThrow(/terminal/);
  });

  it("still finalizes an artifact after public output has failed", async () => {
    const output = new PassThrough();
    output.on("error", () => undefined);
    const order: string[] = [];
    const writer = createV9EventWriter({
      output,
      runId: "run-1",
      recordEvent: async () => undefined,
      finalize: async () => {
        order.push("finalized");
        return {
          path: "/artifact",
          sha256: "a".repeat(64),
          byte_count: 100,
          completed_results: 0,
        };
      },
      observe: async (outcome) => {
        order.push(outcome);
      },
    });
    output.destroy(new Error("closed"));
    await expect(
      writer.emit({
        event: "run.started",
        data: { consistency_mode: "live_worktree" },
      }),
    ).rejects.toThrow();
    await expect(writer.finish(terminal)).rejects.toThrow();
    expect(order).toEqual(["finalized", "failed"]);
  });

  it("keeps accepting liveness events while artifact finalization is in progress", async () => {
    vi.useFakeTimers();
    try {
      const output = new PassThrough();
      let text = "";
      output.on("data", (chunk) => {
        text += chunk.toString();
      });
      let releaseFinalize!: () => void;
      const finalizing = new Promise<void>((resolve) => {
        releaseFinalize = resolve;
      });
      const writer = createV9EventWriter({
        output,
        runId: "run-1",
        now: () => new Date(Date.now()),
        recordEvent: async () => undefined,
        finalize: async () => {
          await finalizing;
          return {
            path: "/artifact",
            sha256: "a".repeat(64),
            byte_count: 100,
            completed_results: 0,
          };
        },
        observe: async () => undefined,
      });

      const finish = writer.finish(terminal);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(
        writer.emit({
          event: "suite.heartbeat",
          data: {
            elapsed_ms: 1_000,
            model_runs: {
              total: 1,
              completed: 1,
              incomplete: 0,
              skipped: 0,
              running: 0,
              queued: 0,
            },
            run_deadline_remaining_ms: 1_000,
            active: [],
            minimal: true,
            detail_ref: "run.terminal_summary",
          },
        }),
      ).resolves.toBeUndefined();
      expect(text).toContain("suite.heartbeat");
      expect(text).not.toContain("run.completed");

      releaseFinalize();
      await finish;
      const events = text
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(events.map((event) => event.event)).toEqual([
        "suite.heartbeat",
        "run.completed",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
