import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { AdapterRegistry } from "../../src/adapters/registry.js";
import { runV9Review } from "../../src/orchestrator/run-v9.js";
import {
  createV9EventWriter,
  PublicDeliveryError,
  type DeliveryFailure,
} from "../../src/protocol/v9-event-writer.js";
import { resolvedContext, roundInput } from "../helpers/fixtures.js";

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Collector artifact finalization", () => {
  it("retains a heartbeat output failure without appending after the artifact seal", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "mesh-finalization-regression-"),
    );
    const finalizationEntered = latch();
    const releaseFinalization = latch();
    const heartbeatFailed = latch();
    let sealed = false;
    let finalized = false;
    let postSealAppendAttempts = 0;
    let finalizeCount = 0;
    let sealedSummary: Record<string, unknown> | undefined;
    const records: Array<Record<string, any>> = [];
    const publicEvents: Array<Record<string, any>> = [];
    const observations: Array<{ outcome: string; failure?: DeliveryFailure }> =
      [];
    const cause = Object.assign(
      new Error("heartbeat pipe failed during publication"),
      { code: "EPIPE" },
    );
    const output = new Writable({
      write(chunk, _encoding, callback) {
        const event = JSON.parse(String(chunk));
        publicEvents.push(event);
        if (sealed && event.event === "suite.heartbeat") {
          callback(cause);
          heartbeatFailed.resolve();
          return;
        }
        callback();
      },
    });
    const append = async (record: Record<string, unknown>) => {
      if (sealed) {
        postSealAppendAttempts++;
        throw new Error("private artifact is sealed");
      }
      records.push(record);
    };
    const writer = createV9EventWriter({
      output,
      runId: "collector-finalization-regression",
      now: () => new Date(Date.now()),
      recordEvent: append,
      finalize: async (summary) => {
        finalizeCount++;
        sealedSummary = structuredClone(summary);
        sealed = true;
        finalizationEntered.resolve();
        await releaseFinalization.promise;
        finalized = true;
        return {
          path: "/synthetic-final-artifact",
          sha256: "a".repeat(64),
          byte_count: 1,
          completed_results: 1,
        };
      },
      observe: async (outcome, failure) => {
        observations.push({
          outcome,
          ...(failure === undefined ? {} : { failure }),
        });
      },
    });
    const base = roundInput();
    const reviewer = base.config.reviewers[0]!;
    reviewer.agentId = "collector";
    reviewer.providerGroup = "synthetic";
    reviewer.timeoutMs = 30_000;
    reviewer.policy = {
      applicability: { mode: "always" },
      requiredCallerContext: [],
      passQuorum: 1,
      minimumProviderGroups: 1,
      adjudication: "off",
      gateMinimumSeverity: "medium",
      gateMinimumConfidence: "medium",
      lensDeadlineMs: 60_000,
      changeCoverage: {
        relevantPaths: ["**"],
        minimumInspection: "full_file",
        proof: "observed",
      },
    };
    Object.assign(base.config.execution, {
      deadline_mode: "fixed",
      run_deadline_ms: 60_000,
      heartbeat_interval_ms: 1_000,
      retry_attempts: 1,
    });
    const registry = new AdapterRegistry();
    registry.register("command", () => ({
      id: "synthetic",
      probe: async () => ({
        available: true,
        authenticated: true,
        model_available: true,
        streaming: false,
        cancellation: true,
        maximumIsolation: "runtime_read_only",
        observed_file_access: true,
        progress_observable: true,
      }),
      async *run() {
        yield {
          type: "result",
          isolation: "runtime_read_only",
          result: {
            schema_version: "4",
            verdict: "pass",
            summary: "Synthetic review complete.",
            review_markdown: "",
            actionable_findings: [],
            informational_notes: [],
          },
        };
      },
    }));

    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "Date",
      ],
    });
    vi.setSystemTime(new Date("2026-09-06T00:00:00Z"));
    const run = runV9Review({
      runId: "collector-finalization-regression",
      config: base.config,
      context: resolvedContext({
        workspace,
        review_scope: { mode: "full", source: "request" },
      }),
      registry,
      signal: new AbortController().signal,
      writer,
      record: append,
      recordResult: async (reviewerId, result) =>
        append({ record: "reviewer.result", reviewer_id: reviewerId, result }),
    });
    const completion = run.then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    );
    try {
      await finalizationEntered.promise;
      const recordCountAtSeal = records.length;
      expect(finalized).toBe(false);

      // Advance only after the explicit finalization gate has sealed the sink.
      // The first scheduled heartbeat, not a sleep or deadline, causes failure.
      await vi.advanceTimersByTimeAsync(1_000);
      await heartbeatFailed.promise;
      expect(writer.failureDetails()).toMatchObject({
        stage: "output_write",
        event: "suite.heartbeat",
        native_error_code: "EPIPE",
        message: cause.message,
      });
      const firstFailure = structuredClone(writer.failureDetails());
      expect(publicEvents.at(-1)?.data.run_deadline_remaining_ms).toBe(59_000);
      expect(postSealAppendAttempts).toBe(0);
      expect(records).toHaveLength(recordCountAtSeal);
      expect(records.some((record) => record.record === "run.error")).toBe(
        false,
      );

      releaseFinalization.resolve();
      const ended = await completion;
      expect(ended.error).toBeInstanceOf(PublicDeliveryError);
      expect(finalized).toBe(true);
      expect(finalizeCount).toBe(1);
      expect(sealedSummary).toMatchObject({
        run_outcome: "clear",
        incomplete_lenses: 0,
        result_delivery: { artifact: "complete", completed_results: 1 },
      });
      expect(observations).toEqual([
        { outcome: "failed", failure: firstFailure },
      ]);
      expect(writer.failureDetails()).toEqual(firstFailure);
      expect(postSealAppendAttempts).toBe(0);
      expect(records).toHaveLength(recordCountAtSeal);
      expect(JSON.stringify(records)).not.toMatch(
        /attempt_deadline_exceeded|lens_deadline_exceeded|run_deadline_exceeded/,
      );
      expect(
        publicEvents.some((event) => event.event === "run.persistence_failed"),
      ).toBe(false);
      expect(
        publicEvents.some((event) => event.event === "reviewer.incomplete"),
      ).toBe(false);
    } finally {
      releaseFinalization.resolve();
      await completion;
      await writer.close();
      vi.useRealTimers();
      output.destroy();
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
