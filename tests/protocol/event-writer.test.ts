import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  createEventWriter,
  type PersistedMirrorEvent,
} from "../../src/protocol/event-writer.js";
import type { PublicEvent } from "../../src/protocol/schemas.js";

class ControlledSink extends EventEmitter {
  readonly chunks: string[] = [];
  readonly callbacks: Array<(error?: Error | null) => void> = [];
  backpressured = false;

  write(
    chunk: string | Uint8Array,
    callback?: (error?: Error | null) => void,
  ): boolean {
    this.chunks.push(chunk.toString());
    if (callback !== undefined) this.callbacks.push(callback);
    return !this.backpressured;
  }
}

describe("EventWriter", () => {
  const largeResultEvent = () => ({
    event: "reviewer.result" as const,
    reviewer_id: "reviewer-1",
    data: {
      digest: "a".repeat(64),
      byte_count: 1_100_000,
      result: {
        schema_version: "3" as const,
        verdict: "pass" as const,
        review_markdown: "x".repeat(1_100_000),
        summary: "No findings.",
        actionable_findings: [],
        informational_notes: [],
      },
    },
  });

  it("keeps full stdout complete when an optional mirror overflows", async () => {
    const output = new PassThrough();
    let stdout = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      stdout += chunk;
    });
    const writer = createEventWriter({
      output,
      runId: "run-optional-overflow",
      onEvent: async () => undefined,
      onMirrorClose: async () => undefined,
      mirrorMaxPendingBytes: 1_024,
    });

    await writer.emit(largeResultEvent());
    await writer.emitFinal?.({
      event: "run.completed",
      data: {
        exit_code: 0,
        consistency_mode: "live_worktree",
        total_elapsed_ms: 1,
        results_complete: true,
        suite: {
          total: 1,
          deferred: 0,
          queued: 0,
          running: 0,
          completed: 1,
          incomplete: 0,
          skipped: 0,
        },
      },
    });

    expect(stdout).toContain('"event":"reviewer.result"');
    expect(stdout).toContain('"event":"run.completed"');
    expect(stdout).toContain('"results_complete":true');
  });

  it("persists a required large result through compact mirror accounting", async () => {
    const output = new PassThrough();
    output.resume();
    const writer = createEventWriter({
      output,
      runId: "run-required-overflow",
      onEvent: async () => undefined,
      onMirrorClose: async () => undefined,
      mirrorCloseRequired: true,
      mirrorMaxPendingBytes: 4 * 1_024,
    });

    await writer.emit(largeResultEvent());
    await expect(
      writer.emitFinal?.({
        event: "run.completed",
        data: {
          exit_code: 0,
          consistency_mode: "live_worktree",
          total_elapsed_ms: 1,
          results_complete: true,
          suite: {
            total: 1,
            deferred: 0,
            queued: 0,
            running: 0,
            completed: 1,
            incomplete: 0,
            skipped: 0,
          },
        },
      }),
    ).resolves.toMatchObject({ event: "run.completed" });
  });

  it("accounts for the recorder's compact persisted form when queuing a full result", async () => {
    const output = new PassThrough();
    output.resume();
    const mirrored: unknown[] = [];
    const writer = createEventWriter({
      output,
      runId: "run-required-large-result",
      onEvent: async (event) => {
        mirrored.push(event);
      },
      onMirrorClose: async () => undefined,
      mirrorCloseRequired: true,
      mirrorMaxPendingBytes: 4 * 1024,
    });

    await writer.emit(largeResultEvent());
    await writer.emitFinal?.({
      event: "run.completed",
      data: {
        exit_code: 0,
        consistency_mode: "live_worktree",
        total_elapsed_ms: 1,
        results_complete: true,
        suite: {
          total: 1,
          deferred: 0,
          queued: 0,
          running: 0,
          completed: 1,
          incomplete: 0,
          skipped: 0,
        },
      },
    });

    expect(mirrored).toContainEqual(
      expect.objectContaining({
        event: "reviewer.result",
        data: expect.not.objectContaining({ result: expect.anything() }),
      }),
    );
  });

  it("propagates an authoritative publication failure instead of swallowing it", async () => {
    const publicationFailure = new Error("immutable publication failed");
    const writer = createEventWriter({
      output: new PassThrough(),
      runId: "run-publication-failed",
      onEvent: async () => undefined,
      onMirrorClose: async () => {
        throw publicationFailure;
      },
      mirrorCloseRequired: true,
    });

    await writer.emit({
      event: "run.started",
      data: { consistency_mode: "live_worktree" },
    });

    await expect(writer.close()).rejects.toBe(publicationFailure);
  });

  it("bounds a required final mirror append that never settles", async () => {
    const writer = createEventWriter({
      output: new PassThrough(),
      runId: "run-final-mirror-stuck",
      onEvent: async () => new Promise<void>(() => undefined),
      onMirrorClose: async () => undefined,
      mirrorCloseRequired: true,
      mirrorFlushTimeoutMs: 10,
    });

    await writer.emit({
      event: "run.started",
      data: { consistency_mode: "live_worktree" },
    });
    await expect(
      writer.emitFinal?.({
        event: "run.completed",
        data: {
          exit_code: 0,
          consistency_mode: "live_worktree",
          total_elapsed_ms: 1,
          results_complete: true,
          suite: {
            total: 0,
            deferred: 0,
            queued: 0,
            running: 0,
            completed: 0,
            incomplete: 0,
            skipped: 0,
          },
        },
      }),
    ).rejects.toThrow(/persistence/i);
  });

  it("bounds a required final mirror close that never settles", async () => {
    let closes = 0;
    const writer = createEventWriter({
      output: new PassThrough(),
      runId: "run-final-close-stuck",
      onEvent: async () => undefined,
      onMirrorClose: async () => {
        closes += 1;
        return new Promise<void>(() => undefined);
      },
      mirrorCloseRequired: true,
      mirrorFlushTimeoutMs: 10,
    });

    await writer.emit({
      event: "run.started",
      data: { consistency_mode: "live_worktree" },
    });
    await expect(
      writer.emitFinal?.({
        event: "run.completed",
        data: {
          exit_code: 0,
          consistency_mode: "live_worktree",
          total_elapsed_ms: 1,
          results_complete: true,
          suite: {
            total: 0,
            deferred: 0,
            queued: 0,
            running: 0,
            completed: 0,
            incomplete: 0,
            skipped: 0,
          },
        },
      }),
    ).rejects.toThrow(/persistence/i);
    await expect(writer.close()).resolves.toBeUndefined();
    expect(closes).toBe(1);
  });

  it("injects the current run_id into every private record", async () => {
    const recorded: unknown[] = [];
    const writer = createEventWriter({
      output: new PassThrough(),
      runId: "run-bound",
      onRecord: async (record) => {
        recorded.push(record);
      },
    });

    await writer.record?.({ record: "context", context: { project: "demo" } });

    expect(recorded).toEqual([
      {
        record: "context",
        run_id: "run-bound",
        context: { project: "demo" },
      },
    ]);
  });

  it("rejects a private record that attempts to override the current run_id", async () => {
    const writer = createEventWriter({
      output: new PassThrough(),
      runId: "run-bound",
      onRecord: async () => undefined,
    });

    await expect(
      writer.record?.({
        record: "context",
        run_id: "different-run",
        context: {},
      }),
    ).rejects.toThrow(/run_id/i);
  });

  it("does not resolve an emission until its write callback succeeds", async () => {
    const output = new ControlledSink();
    const writer = createEventWriter({ output, runId: "run-callback" });
    let settled = false;

    const emission = writer
      .emit({
        event: "run.started",
        data: { consistency_mode: "live_worktree" },
      })
      .finally(() => {
        settled = true;
      });
    let closeSettled = false;
    const closing = writer.close().finally(() => {
      closeSettled = true;
    });
    await Promise.resolve();

    expect(output.callbacks).toHaveLength(1);
    expect(settled).toBe(false);
    expect(closeSettled).toBe(false);
    output.callbacks[0]?.(null);
    await expect(emission).resolves.toMatchObject({ event: "run.started" });
    await expect(closing).resolves.toBeUndefined();
    expect(settled).toBe(true);
    expect(closeSettled).toBe(true);
    expect(output.listenerCount("error")).toBe(1);
    expect(output.listenerCount("drain")).toBe(0);
  });

  it("waits for both write callback and drain under backpressure", async () => {
    const output = new ControlledSink();
    output.backpressured = true;
    const writer = createEventWriter({ output, runId: "run-drain" });
    let settled = false;
    const emission = writer
      .emit({
        event: "run.started",
        data: { consistency_mode: "live_worktree" },
      })
      .finally(() => {
        settled = true;
      });
    await Promise.resolve();

    output.callbacks[0]?.(null);
    await Promise.resolve();
    expect(settled).toBe(false);
    output.emit("drain");
    await expect(emission).resolves.toMatchObject({ event: "run.started" });
  });

  it("rejects callback failure once and keeps it sticky through close", async () => {
    const output = new ControlledSink();
    const writer = createEventWriter({ output, runId: "run-callback-error" });
    const emission = writer.emit({
      event: "run.started",
      data: { consistency_mode: "live_worktree" },
    });
    const closing = writer.close();
    await Promise.resolve();
    const failure = new Error("delayed callback failure");

    output.callbacks[0]?.(failure);
    output.emit("error", new Error("later duplicate stream failure"));

    await expect(emission).rejects.toBe(failure);
    await expect(closing).rejects.toBe(failure);
    expect(output.listenerCount("error")).toBe(1);
    expect(output.listenerCount("drain")).toBe(0);
  });

  it("rejects a delayed stream error before callback and ignores the later callback", async () => {
    const output = new ControlledSink();
    const writer = createEventWriter({ output, runId: "run-stream-error" });
    const emission = writer.emit({
      event: "run.started",
      data: { consistency_mode: "live_worktree" },
    });
    await Promise.resolve();
    const failure = new Error("delayed stream failure");

    output.emit("error", failure);
    output.callbacks[0]?.(null);

    await expect(emission).rejects.toBe(failure);
    await expect(writer.close()).rejects.toBe(failure);
    expect(output.listenerCount("error")).toBe(1);
    expect(output.listenerCount("drain")).toBe(0);
  });

  it("serializes concurrent emissions with strictly increasing sequence numbers", async () => {
    const output = new PassThrough();
    const chunks: string[] = [];
    output.setEncoding("utf8");
    output.on("data", (chunk) => chunks.push(chunk));

    const writer = createEventWriter({
      output,
      runId: "run-1",
      requestId: "caller-1",
      now: () => new Date("2026-08-29T10:00:00.000Z"),
    });

    await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        writer.emit({
          event: "reviewer.progress",
          reviewer_id: `reviewer-${index % 3}`,
          data: { phase: "reviewing", message: `step-${index}` },
        }),
      ),
    );
    await writer.close();

    const events = chunks
      .join("")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.map((event) => event.seq)).toEqual(
      Array.from({ length: 50 }, (_, index) => index + 1),
    );
    expect(events.every((event) => event.schema_version === "5")).toBe(true);
    expect(events.every((event) => event.request_id === "caller-1")).toBe(true);
  });

  it("rejects emission after close", async () => {
    const output = new PassThrough();
    const writer = createEventWriter({ output, runId: "run-2" });
    await writer.close();

    await expect(
      writer.emit({
        event: "run.started",
        data: { consistency_mode: "live_worktree" },
      }),
    ).rejects.toThrow(/closed/i);
  });

  it("keeps the first stream error sticky for later emissions", async () => {
    const output = new PassThrough();
    const writer = createEventWriter({ output, runId: "run-3" });
    const streamError = new Error("output failed");
    output.destroy(streamError);

    await expect(
      writer.emit({
        event: "run.started",
        data: { consistency_mode: "live_worktree" },
      }),
    ).rejects.toThrow("output failed");
    await expect(
      writer.emit({
        event: "run.started",
        data: { consistency_mode: "live_worktree" },
      }),
    ).rejects.toThrow("output failed");
  });

  it("rejects when a backpressured write reports an error synchronously", async () => {
    const streamError = new Error("output failed during write");
    const output = new PassThrough();
    output.write = () => {
      output.emit("error", streamError);
      return false;
    };
    const writer = createEventWriter({ output, runId: "run-4" });

    await expect(
      writer.emit({
        event: "run.started",
        data: { consistency_mode: "live_worktree" },
      }),
    ).rejects.toThrow("output failed during write");
  }, 100);

  it("mirrors a normalized event only after the authoritative stdout write succeeds", async () => {
    const output = new ControlledSink();
    const mirrored: unknown[] = [];
    const writer = createEventWriter({
      output,
      runId: "run-mirror",
      onEvent: async (event) => {
        mirrored.push(event);
      },
    });

    const emission = writer.emit({
      event: "run.started",
      data: { consistency_mode: "live_worktree" },
    });
    await Promise.resolve();
    expect(mirrored).toEqual([]);

    output.callbacks[0]?.(null);
    await expect(emission).resolves.toMatchObject({ event: "run.started" });
    expect(mirrored).toHaveLength(1);
  });

  it("keeps foreground emissions successful when the mirror fails and warns once", async () => {
    const output = new PassThrough();
    const failure = new Error("disk unavailable");
    let mirrorAttempts = 0;
    const warnings: Error[] = [];
    const writer = createEventWriter({
      output,
      runId: "run-mirror-failure",
      onEvent: async () => {
        mirrorAttempts += 1;
        throw failure;
      },
      onWarning: (error) => warnings.push(error),
    });

    await expect(
      writer.emit({
        event: "run.started",
        data: { consistency_mode: "live_worktree" },
      }),
    ).resolves.toMatchObject({ event: "run.started" });
    await expect(
      writer.emit({
        event: "reviewer.progress",
        reviewer_id: "reviewer-1",
        data: { phase: "reviewing" },
      }),
    ).resolves.toMatchObject({ event: "reviewer.progress" });

    expect(mirrorAttempts).toBe(1);
    expect(warnings).toEqual([failure]);
  });

  it("does not let a never-settling mirror delay later stdout events or bounded close", async () => {
    const output = new PassThrough();
    const stdout: string[] = [];
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => stdout.push(chunk));
    let resolveMirrorStarted!: () => void;
    const mirrorStarted = new Promise<void>((resolve) => {
      resolveMirrorStarted = resolve;
    });
    const never = new Promise<void>(() => undefined);
    const warnings: Error[] = [];
    const writer = createEventWriter({
      output,
      runId: "run-never-settles",
      onEvent: async () => {
        resolveMirrorStarted();
        await never;
      },
      onWarning: (error) => warnings.push(error),
      mirrorFlushTimeoutMs: 10,
    });

    await writer.emit({
      event: "run.started",
      data: { consistency_mode: "live_worktree" },
    });
    await mirrorStarted;
    await expect(
      writer.emit({
        event: "reviewer.progress",
        reviewer_id: "reviewer-1",
        data: { phase: "reviewing" },
      }),
    ).resolves.toMatchObject({ event: "reviewer.progress" });
    await expect(writer.close()).resolves.toBeUndefined();

    expect(stdout.join("")).toContain('"event":"reviewer.progress"');
    expect(warnings).toHaveLength(1);
  });

  it("drops a bounded mirror backlog when a stuck first append is saturated", async () => {
    const output = new PassThrough();
    output.resume();
    let releaseFirstAppend!: () => void;
    const firstAppendReleased = new Promise<void>((resolve) => {
      releaseFirstAppend = resolve;
    });
    let signalFirstAppendStarted!: () => void;
    const firstAppendStarted = new Promise<void>((resolve) => {
      signalFirstAppendStarted = resolve;
    });
    let closes = 0;
    const mirroredSequences: number[] = [];
    const warnings: Error[] = [];
    const writer = createEventWriter({
      output,
      runId: "run-mirror-capacity",
      onEvent: async (event) => {
        mirroredSequences.push(event.seq);
        if (event.seq === 1) {
          signalFirstAppendStarted();
          await firstAppendReleased;
        }
      },
      onMirrorClose: async () => {
        closes += 1;
      },
      onWarning: (error) => warnings.push(error),
      mirrorFlushTimeoutMs: 10,
      mirrorMaxPendingEvents: 8,
      mirrorMaxPendingBytes: 64 * 1024,
    });

    await writer.emit({
      event: "run.started",
      data: { consistency_mode: "live_worktree" },
    });
    await firstAppendStarted;
    await Promise.all(
      Array.from({ length: 2_000 }, (_, index) =>
        writer.emit({
          event: "reviewer.progress",
          reviewer_id: "reviewer-1",
          data: {
            phase: "reviewing",
            message: `sensitive-payload-${index}`,
          },
        }),
      ),
    );

    await expect(writer.close()).resolves.toBeUndefined();
    expect(mirroredSequences).toEqual([1]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toBe(
      "Run record persistence queue capacity exceeded.",
    );
    expect(warnings[0]?.message).not.toContain("sensitive-payload");

    releaseFirstAppend();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(mirroredSequences).toEqual([1]);
    expect(closes).toBe(1);
    expect(warnings).toHaveLength(1);
  });

  it("preserves mirror event order when the mirror is healthy", async () => {
    const output = new PassThrough();
    const mirrored: PersistedMirrorEvent[] = [];
    const writer = createEventWriter({
      output,
      runId: "run-mirror-order",
      onEvent: async (event) => {
        mirrored.push(event);
      },
    });

    await Promise.all([
      writer.emit({
        event: "run.started",
        data: { consistency_mode: "live_worktree" },
      }),
      writer.emit({
        event: "reviewer.progress",
        reviewer_id: "reviewer-1",
        data: { phase: "reviewing" },
      }),
    ]);
    await writer.close();

    expect(mirrored.map((event) => event.seq)).toEqual([1, 2]);
  });

  it("bounds a never-settling mirror close without changing the foreground outcome", async () => {
    const writer = createEventWriter({
      output: new PassThrough(),
      runId: "run-mirror-close",
      onEvent: async () => undefined,
      onMirrorClose: async () => new Promise<void>(() => undefined),
      mirrorFlushTimeoutMs: 10,
    });

    await writer.emit({
      event: "run.started",
      data: { consistency_mode: "live_worktree" },
    });

    await expect(writer.close()).resolves.toBeUndefined();
  });

  it("eventually closes an opened recorder after its mirror event fails", async () => {
    const failure = new Error("append failed after open");
    let opened = false;
    let closes = 0;
    const warnings: Error[] = [];
    const writer = createEventWriter({
      output: new PassThrough(),
      runId: "run-failed-recorder-close",
      onEvent: async () => {
        opened = true;
        throw failure;
      },
      onMirrorClose: async () => {
        expect(opened).toBe(true);
        closes += 1;
      },
      onWarning: (error) => warnings.push(error),
      mirrorFlushTimeoutMs: 10,
    });

    await writer.emit({
      event: "run.started",
      data: { consistency_mode: "live_worktree" },
    });
    await expect(writer.close()).resolves.toBeUndefined();

    expect(closes).toBe(1);
    expect(warnings).toEqual([failure]);
  });

  it("returns after the flush budget and closes a slow recorder once its append settles", async () => {
    let releaseAppend!: () => void;
    const appendReleased = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    let closes = 0;
    const warnings: Error[] = [];
    const writer = createEventWriter({
      output: new PassThrough(),
      runId: "run-slow-recorder-close",
      onEvent: async () => appendReleased,
      onMirrorClose: async () => {
        closes += 1;
        resolveClosed();
      },
      onWarning: (error) => warnings.push(error),
      mirrorFlushTimeoutMs: 10,
    });

    await writer.emit({
      event: "run.started",
      data: { consistency_mode: "live_worktree" },
    });
    await expect(writer.close()).resolves.toBeUndefined();
    expect(closes).toBe(0);
    expect(warnings).toHaveLength(1);

    releaseAppend();
    await closed;
    expect(closes).toBe(1);
    expect(warnings).toHaveLength(1);
  });

  it("closes an opened recorder before rethrowing a later authoritative stdout failure", async () => {
    const output = new ControlledSink();
    const mirrorFailure = new Error("recorder close failed");
    let resolveMirrored!: () => void;
    const mirrored = new Promise<void>((resolve) => {
      resolveMirrored = resolve;
    });
    let closes = 0;
    const warnings: Error[] = [];
    const writer = createEventWriter({
      output,
      runId: "run-stdout-failure-recorder-close",
      onEvent: async () => {
        resolveMirrored();
      },
      onMirrorClose: async () => {
        closes += 1;
        throw mirrorFailure;
      },
      onWarning: (error) => warnings.push(error),
      mirrorFlushTimeoutMs: 10,
    });

    const first = writer.emit({
      event: "run.started",
      data: { consistency_mode: "live_worktree" },
    });
    await Promise.resolve();
    output.callbacks[0]?.(null);
    await first;
    await mirrored;

    const stdoutFailure = new Error("stdout failed after recorder open");
    const second = writer.emit({
      event: "reviewer.progress",
      reviewer_id: "reviewer-1",
      data: { phase: "reviewing" },
    });
    await Promise.resolve();
    output.callbacks[1]?.(stdoutFailure);
    await expect(second).rejects.toBe(stdoutFailure);
    await expect(writer.close()).rejects.toBe(stdoutFailure);

    expect(closes).toBe(1);
    expect(warnings).toEqual([mirrorFailure]);
  });
});
