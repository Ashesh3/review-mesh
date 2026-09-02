import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdapterRegistry } from "../../src/adapters/registry.js";
import type {
  AdapterCapabilities,
  AdapterEvent,
  AdapterReviewInput,
  ReviewAdapter,
} from "../../src/adapters/types.js";
import { runReviewRound } from "../../src/orchestrator/run-review.js";
import type { PublicEvent } from "../../src/protocol/schemas.js";
import { FakeAdapter } from "../helpers/fake-adapter.js";
import {
  failResult,
  fakeAdapterReturning,
  passResult,
  roundInput,
} from "../helpers/fixtures.js";

const availableCapabilities: AdapterCapabilities = {
  available: true,
  authenticated: true,
  model_available: true,
  streaming: true,
  cancellation: true,
  maximumIsolation: "enforced_read_only",
};

function boundaryAdapter(
  run: (input: AdapterReviewInput) => AsyncIterable<AdapterEvent>,
  overrides: Partial<ReviewAdapter> = {},
): ReviewAdapter {
  return {
    id: "boundary",
    probe: async () => availableCapabilities,
    run,
    ...overrides,
  };
}

function writerWithStuckHeartbeat() {
  const emitted: Array<{ event: string; reviewer_id?: string }> = [];
  let resolveHeartbeatStarted!: () => void;
  const heartbeatStarted = new Promise<void>((resolve) => {
    resolveHeartbeatStarted = resolve;
  });
  return {
    emitted,
    heartbeatStarted,
    writer: {
      emit: vi.fn((draft: { event: string; reviewer_id?: string }) => {
        emitted.push(draft);
        if (draft.event === "reviewer.heartbeat") {
          resolveHeartbeatStarted();
          return new Promise<never>(() => undefined);
        }
        return Promise.resolve({});
      }),
      close: vi.fn(() => new Promise<void>(() => undefined)),
    },
  };
}

describe("runReviewRound", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T10:00:00.000Z"));
  });

  afterEach(() => {
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("limits concurrent capability probes to max concurrency", async () => {
    let activeProbes = 0;
    let maximumActiveProbes = 0;
    const started: string[] = [];
    const releases = new Map<string, () => void>();
    const adapters = Object.fromEntries(
      ["first", "second", "third"].map((id) => [
        id,
        boundaryAdapter(
          async function* () {
            yield {
              type: "result",
              result: passResult(),
              isolation: "enforced_read_only",
            };
          },
          {
            probe: async () => {
              activeProbes += 1;
              maximumActiveProbes = Math.max(maximumActiveProbes, activeProbes);
              started.push(id);
              await new Promise<void>((resolve) => releases.set(id, resolve));
              activeProbes -= 1;
              return availableCapabilities;
            },
          },
        ),
      ]),
    );
    const completionPromise = runReviewRound(
      roundInput({
        adapters,
        config: { execution: { max_concurrency: 2 } },
      }),
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual(["first", "second"]);
    expect(maximumActiveProbes).toBe(2);

    releases.get("first")?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual(["first", "second", "third"]);
    expect(maximumActiveProbes).toBe(2);

    releases.get("second")?.();
    releases.get("third")?.();
    await vi.runAllTimersAsync();
    await completionPromise;
  });

  it("starts reviewers up to max concurrency and drains the queue in roster order", async () => {
    const first = fakeAdapterReturning(passResult("first"), 30);
    const second = fakeAdapterReturning(passResult("second"), 10);
    const third = fakeAdapterReturning(passResult("third"), 1);
    const adapters = { first, second, third };
    const creations: string[] = [];
    const events: PublicEvent[] = [];
    const registry = new AdapterRegistry();
    registry.register("command", (registration) => {
      if (registration.type !== "command") throw new Error("expected command");
      creations.push(registration.command);
      return adapters[registration.command as keyof typeof adapters];
    });
    const completionPromise = runReviewRound(
      roundInput({
        adapters,
        registry,
        onEvent: (event) => events.push(event),
        config: {
          execution: { max_concurrency: 2, heartbeat_interval_ms: 5 },
        },
      }),
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(creations).toEqual(["first", "second", "third"]);
    expect([
      first.probeCalls.length,
      second.probeCalls.length,
      third.probeCalls.length,
    ]).toEqual([1, 1, 1]);
    expect([first.runCalls, second.runCalls, third.runCalls]).toEqual([
      1, 1, 0,
    ]);
    await vi.advanceTimersByTimeAsync(5);
    expect(
      events.find((event) => event.event === "reviewer.heartbeat"),
    ).toMatchObject({
      data: {
        suite: { total: 3, queued: 1, running: 2, completed: 0, incomplete: 0 },
      },
    });
    await vi.advanceTimersByTimeAsync(5);
    expect([first.runCalls, second.runCalls, third.runCalls]).toEqual([
      1, 1, 1,
    ]);
    await vi.runAllTimersAsync();

    expect(
      (await completionPromise).reviewers.map((item) => item.reviewer_id),
    ).toEqual(["first", "second", "third"]);
  });

  it("reports resolved runtime details and immediate probing and queued progress", async () => {
    const events: PublicEvent[] = [];
    const completionPromise = runReviewRound(
      roundInput({
        adapters: { detailed: fakeAdapterReturning(passResult(), 1) },
        onEvent: (event) => events.push(event),
        config: {
          execution: {
            max_concurrency: 1,
            heartbeat_interval_ms: 25,
            shutdown_grace_period_ms: 10,
          },
          selection: { source: "defaults" },
          reviewers: [
            { effort: "high", timeoutMs: 321_000, purpose: "Find regressions" },
          ],
        },
      }),
    );

    await vi.runAllTimersAsync();
    await completionPromise;

    expect(
      events.find((event) => event.event === "suite.resolved"),
    ).toMatchObject({
      data: {
        execution: {
          max_concurrency: 1,
          heartbeat_interval_ms: 25,
          shutdown_grace_period_ms: 10,
        },
        reviewers: [
          {
            id: "detailed",
            adapter_type: "command",
            effort: "high",
            timeout_ms: 321_000,
          },
        ],
      },
    });
    expect(
      events.filter((event) => event.event === "reviewer.progress"),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reviewer_id: "detailed",
          data: expect.objectContaining({ phase: "probing" }),
        }),
        expect.objectContaining({
          reviewer_id: "detailed",
          data: expect.objectContaining({ phase: "queued" }),
        }),
      ]),
    );
    expect(
      events.find((event) => event.event === "reviewer.started"),
    ).toMatchObject({
      reviewer_id: "detailed",
      data: { effort: "high", timeout_ms: 321_000 },
    });
  });

  it("emits liveness while a capability probe is silent", async () => {
    let releaseProbe!: () => void;
    const probing = boundaryAdapter(
      async function* () {
        yield {
          type: "result",
          result: passResult(),
          isolation: "enforced_read_only",
        };
      },
      {
        probe: () =>
          new Promise<AdapterCapabilities>((resolve) => {
            releaseProbe = () => resolve(availableCapabilities);
          }),
      },
    );
    const events: PublicEvent[] = [];
    const completionPromise = runReviewRound(
      roundInput({
        adapters: { probing },
        onEvent: (event) => events.push(event),
        config: { execution: { heartbeat_interval_ms: 10 } },
      }),
    );

    await vi.advanceTimersByTimeAsync(25);
    expect(
      events.find(
        (event) =>
          event.event === "reviewer.heartbeat" &&
          event.reviewer_id === "probing",
      ),
    ).toMatchObject({
      data: {
        phase: "probing",
        last_activity_message:
          "Checking the configured adapter, authentication, model, and isolation capability.",
        suite: { total: 1, queued: 0, running: 1, completed: 0, incomplete: 0 },
      },
    });
    expect(JSON.stringify(events)).not.toMatch(/percent/i);

    releaseProbe();
    await vi.runAllTimersAsync();
    await completionPromise;
  });

  it("waits for the full suite after actionable findings", async () => {
    const first = fakeAdapterReturning(failResult("first"), 5);
    const second = fakeAdapterReturning(passResult(), 50);
    const events: PublicEvent[] = [];
    const completionPromise = runReviewRound(
      roundInput({
        adapters: { first, second },
        onEvent: (event) => events.push(event),
      }),
    );

    await vi.runAllTimersAsync();
    const completion = await completionPromise;

    expect(first.runCalls).toBe(1);
    expect(second.runCalls).toBe(1);
    expect(completion.status).toBe("findings");
    expect(events.at(-1)?.event).toBe("run.completed");
  });

  it("runs available reviewers when another probe is definitively unavailable", async () => {
    const unavailable = new FakeAdapter({
      capabilities: {
        available: false,
        authenticated: "unknown",
        model_available: "unknown",
        streaming: false,
        cancellation: false,
        maximumIsolation: "unknown",
        message: "Executable not found.",
      },
    });
    const available = fakeAdapterReturning(passResult(), 5);
    const completionPromise = runReviewRound(
      roundInput({ adapters: { unavailable, available } }),
    );

    await vi.runAllTimersAsync();
    const completion = await completionPromise;

    expect(unavailable.runCalls).toBe(0);
    expect(available.runCalls).toBe(1);
    expect(completion.reviewers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reviewer_id: "unavailable",
          reason: "adapter_unavailable",
        }),
        expect.objectContaining({
          reviewer_id: "available",
          status: "completed",
        }),
      ]),
    );
  });

  it("times out a non-cooperative probe without blocking other reviewers", async () => {
    let probeSignal: AbortSignal | undefined;
    let cleanupCalls = 0;
    const stuck = boundaryAdapter(
      async function* () {
        yield {
          type: "result",
          result: passResult(),
          isolation: "enforced_read_only",
        };
      },
      {
        probe: (_reviewer, signal) => {
          probeSignal = signal;
          return new Promise<AdapterCapabilities>(() => undefined);
        },
        forceCleanup: async () => {
          cleanupCalls += 1;
        },
      },
    );
    const available = fakeAdapterReturning(passResult(), 5);
    const completionPromise = runReviewRound(
      roundInput({
        adapters: { stuck, available },
        config: {
          reviewers: [{ timeoutMs: 25 }, { timeoutMs: 100 }],
        },
      }),
    );

    await vi.advanceTimersByTimeAsync(25);
    await vi.runAllTimersAsync();
    const completion = await completionPromise;

    expect(probeSignal?.aborted).toBe(true);
    expect(cleanupCalls).toBe(1);
    expect(completion.reviewers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reviewer_id: "stuck",
          reason: "timeout",
          retryable: true,
        }),
        expect.objectContaining({
          reviewer_id: "available",
          status: "completed",
        }),
      ]),
    );
  });

  it("caps probe time independently of a much longer reviewer deadline", async () => {
    const stuck = boundaryAdapter(
      async function* () {
        yield {
          type: "result",
          result: passResult(),
          isolation: "enforced_read_only",
        };
      },
      {
        probe: () => new Promise<AdapterCapabilities>(() => undefined),
      },
    );
    let completion: Awaited<ReturnType<typeof runReviewRound>> | undefined;
    void runReviewRound(
      roundInput({
        adapters: { stuck },
        config: { reviewers: [{ timeoutMs: 120_000 }] },
      }),
    ).then((result) => {
      completion = result;
    });

    await vi.advanceTimersByTimeAsync(29_999);
    expect(completion).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await vi.runAllTimersAsync();

    expect(completion?.reviewers).toEqual([
      expect.objectContaining({ reason: "timeout", retryable: true }),
    ]);
  });

  it("emits factual heartbeats during a silent reviewer without inventing percentages", async () => {
    const silent = fakeAdapterReturning(passResult(), 250);
    const events: PublicEvent[] = [];
    const completionPromise = runReviewRound(
      roundInput({
        adapters: { silent },
        onEvent: (event) => events.push(event),
      }),
    );

    await vi.advanceTimersByTimeAsync(210);
    const heartbeats = events.filter(
      (event) => event.event === "reviewer.heartbeat",
    );
    expect(heartbeats).toHaveLength(2);
    expect(heartbeats[0]).toMatchObject({
      reviewer_id: "silent",
      data: {
        phase: "reviewing",
        elapsed_ms: 100,
        last_activity_message: expect.any(String),
        suite: { total: 1, queued: 0, running: 1, completed: 0, incomplete: 0 },
      },
    });
    expect(JSON.stringify(heartbeats)).not.toMatch(/percent/i);

    await vi.runAllTimersAsync();
    await completionPromise;
  });

  it("bounds a stuck heartbeat writer when a reviewer times out", async () => {
    const stuck = boundaryAdapter(() => ({
      [Symbol.asyncIterator](): AsyncIterator<AdapterEvent> {
        return {
          next: () =>
            new Promise<IteratorResult<AdapterEvent>>(() => undefined),
        };
      },
    }));
    const { emitted, heartbeatStarted, writer } = writerWithStuckHeartbeat();
    let outcome: "pending" | "resolved" | "rejected" = "pending";
    const completionPromise = runReviewRound(
      roundInput({
        adapters: { stuck },
        writer,
        config: {
          execution: {
            heartbeat_interval_ms: 10,
            shutdown_grace_period_ms: 20,
          },
          reviewers: [{ timeoutMs: 30 }],
        },
      }),
    );
    void completionPromise.then(
      () => {
        outcome = "resolved";
      },
      () => {
        outcome = "rejected";
      },
    );

    await vi.advanceTimersByTimeAsync(10);
    await heartbeatStarted;
    await vi.advanceTimersByTimeAsync(200);

    await expect(completionPromise).rejects.toThrow(
      "The public event stream became unavailable.",
    );
    expect(outcome).toBe("rejected");
    expect(
      emitted.filter((event) => event.event === "reviewer.heartbeat"),
    ).toHaveLength(1);
    expect(
      emitted.filter((event) => event.event === "reviewer.incomplete"),
    ).toHaveLength(0);
    expect(
      emitted.filter((event) => event.event === "run.completed"),
    ).toHaveLength(0);
  });

  it("bounds a stuck heartbeat writer during caller cancellation", async () => {
    const stuck = boundaryAdapter(() => ({
      [Symbol.asyncIterator](): AsyncIterator<AdapterEvent> {
        return {
          next: () =>
            new Promise<IteratorResult<AdapterEvent>>(() => undefined),
        };
      },
    }));
    const controller = new AbortController();
    const { emitted, heartbeatStarted, writer } = writerWithStuckHeartbeat();
    let outcome: "pending" | "resolved" | "rejected" = "pending";
    const completionPromise = runReviewRound(
      roundInput({
        adapters: { stuck },
        signal: controller.signal,
        writer,
        config: {
          execution: {
            heartbeat_interval_ms: 10,
            shutdown_grace_period_ms: 20,
          },
        },
      }),
    );
    void completionPromise.then(
      () => {
        outcome = "resolved";
      },
      () => {
        outcome = "rejected";
      },
    );

    await vi.advanceTimersByTimeAsync(10);
    await heartbeatStarted;
    controller.abort();
    await vi.advanceTimersByTimeAsync(200);

    await expect(completionPromise).rejects.toThrow(
      "The public event stream became unavailable.",
    );
    expect(outcome).toBe("rejected");
    expect(
      emitted.filter((event) => event.event === "reviewer.heartbeat"),
    ).toHaveLength(1);
    expect(
      emitted.filter((event) => event.event === "reviewer.incomplete"),
    ).toHaveLength(0);
    expect(
      emitted.filter((event) => event.event === "run.completed"),
    ).toHaveLength(0);
  });

  it("converts deadline expiry to timeout and aborts the adapter signal", async () => {
    let adapterSignal: AbortSignal | undefined;
    const timedOut = new FakeAdapter({
      onRun: async (_queue, input) => {
        adapterSignal = input.signal;
        await new Promise<void>((resolve) =>
          input.signal.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
      },
    });
    const completionPromise = runReviewRound(
      roundInput({
        adapters: { timedOut },
        config: { reviewers: [{ timeoutMs: 100 }] },
      }),
    );

    await vi.advanceTimersByTimeAsync(100);
    const completion = await completionPromise;

    expect(adapterSignal?.aborted).toBe(true);
    expect(completion.reviewers[0]).toMatchObject({
      reviewer_id: "timedOut",
      status: "incomplete",
      reason: "timeout",
    });
  });

  it("shares cleanup when parent interruption overlaps deadline grace", async () => {
    let cleanupCalls = 0;
    const overlapping = boundaryAdapter(
      () => ({
        [Symbol.asyncIterator](): AsyncIterator<AdapterEvent> {
          return {
            next: () =>
              new Promise<IteratorResult<AdapterEvent>>(() => undefined),
          };
        },
      }),
      {
        forceCleanup: () => {
          cleanupCalls += 1;
          return new Promise<void>((resolve) => setTimeout(resolve, 50));
        },
      },
    );
    const controller = new AbortController();
    const completionPromise = runReviewRound(
      roundInput({
        adapters: { overlapping },
        signal: controller.signal,
        config: {
          execution: {
            heartbeat_interval_ms: 1_000,
            shutdown_grace_period_ms: 50,
          },
          reviewers: [{ timeoutMs: 50 }],
        },
      }),
    );

    await vi.advanceTimersByTimeAsync(75);
    expect(cleanupCalls).toBe(0);
    controller.abort(new Error("caller interrupted during deadline grace"));
    await vi.advanceTimersByTimeAsync(50);
    expect(cleanupCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(50);
    const completion = await completionPromise;

    expect(cleanupCalls).toBe(1);
    expect(completion.exitCode).toBe(4);
    expect(completion.reviewers[0]).toMatchObject({ reason: "cancelled" });
  });

  it("keeps completed findings when another reviewer is incomplete", async () => {
    const finding = fakeAdapterReturning(failResult("kept"), 5);
    const timedOut = new FakeAdapter({
      onRun: async (_queue, input) => {
        await new Promise<void>((resolve) =>
          input.signal.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
      },
    });
    const completionPromise = runReviewRound(
      roundInput({
        adapters: { finding, timedOut },
        config: {
          reviewers: [{ timeoutMs: 100 }, { timeoutMs: 20 }],
        },
      }),
    );

    await vi.runAllTimersAsync();
    const completion = await completionPromise;

    expect(completion.status).toBe("incomplete");
    expect(completion.reviewers[0]).toMatchObject({
      status: "completed",
      result: {
        actionable_findings: [expect.objectContaining({ id: "kept" })],
      },
    });
    expect(completion.reviewers[1]).toMatchObject({ reason: "timeout" });
  });

  it("stops queueing and cancels every nonterminal reviewer on caller abort", async () => {
    let activeQueue: { end(): void } | undefined;
    let resolveRun!: () => void;
    const active = new FakeAdapter({
      onRun: (queue) => {
        activeQueue = queue;
        return new Promise<void>((resolve) => {
          resolveRun = resolve;
        });
      },
    });
    const forceCleanup = vi.fn(async () => {
      activeQueue?.end();
      resolveRun();
    });
    const activeWithCleanup = Object.assign(active, { forceCleanup });
    const queued = fakeAdapterReturning(passResult(), 1);
    const controller = new AbortController();
    const completionPromise = runReviewRound(
      roundInput({
        adapters: { active: activeWithCleanup, queued },
        signal: controller.signal,
        config: {
          execution: { max_concurrency: 1, shutdown_grace_period_ms: 50 },
        },
      }),
    );

    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(50);
    const completion = await completionPromise;

    expect(active.inputs[0]?.signal.aborted).toBe(true);
    expect(queued.runCalls).toBe(0);
    expect(forceCleanup).toHaveBeenCalledOnce();
    expect(completion.exitCode).toBe(4);
    expect(completion.reviewers).toEqual([
      expect.objectContaining({ reviewer_id: "active", reason: "cancelled" }),
      expect.objectContaining({ reviewer_id: "queued", reason: "cancelled" }),
    ]);
  });

  it("emits one terminal event per reviewer and run.completed last", async () => {
    const duplicate = new FakeAdapter({
      onRun: (queue) => {
        queue.push({
          type: "result",
          result: passResult(),
          isolation: "prompt_only",
        });
        queue.push({
          type: "result",
          result: passResult(),
          isolation: "prompt_only",
        });
      },
    });
    const normal = fakeAdapterReturning(passResult(), 5);
    const events: PublicEvent[] = [];
    const completionPromise = runReviewRound(
      roundInput({
        adapters: { duplicate, normal },
        onEvent: (event) => events.push(event),
      }),
    );

    await vi.runAllTimersAsync();
    const completion = await completionPromise;
    const terminalEvents = events.filter(
      (event) =>
        event.event === "reviewer.completed" ||
        event.event === "reviewer.incomplete",
    );

    expect(events.slice(0, 3).map((event) => event.event)).toEqual([
      "run.started",
      "context.resolved",
      "suite.resolved",
    ]);
    expect(terminalEvents.map((event) => event.reviewer_id).sort()).toEqual([
      "duplicate",
      "normal",
    ]);
    expect(completion.reviewers[0]).toMatchObject({
      reason: "protocol_violation",
    });
    expect(events.at(-1)?.event).toBe("run.completed");
  });

  it("terminalizes a synchronous adapter.run exception and still completes the run", async () => {
    const events: PublicEvent[] = [];
    const broken = boundaryAdapter(() => {
      throw new Error("Authorization: Bearer secret-value");
    });
    const completionPromise = runReviewRound(
      roundInput({
        adapters: { broken },
        onEvent: (event) => events.push(event),
      }),
    );

    await vi.runAllTimersAsync();
    const completion = await completionPromise;

    expect(completion.reviewers).toEqual([
      expect.objectContaining({
        reviewer_id: "broken",
        status: "incomplete",
        reason: "process_crashed",
        message: "[redacted]",
      }),
    ]);
    expect(
      events.filter((event) => event.event === "reviewer.incomplete"),
    ).toHaveLength(1);
    expect(events.at(-1)?.event).toBe("run.completed");
  });

  it("terminalizes a synchronous async-iterator exception and still completes the run", async () => {
    const events: PublicEvent[] = [];
    const broken = boundaryAdapter(() => ({
      [Symbol.asyncIterator](): AsyncIterator<AdapterEvent> {
        throw new Error("iterator construction failed");
      },
    }));
    const completionPromise = runReviewRound(
      roundInput({
        adapters: { broken },
        onEvent: (event) => events.push(event),
      }),
    );

    await vi.runAllTimersAsync();
    const completion = await completionPromise;

    expect(completion.reviewers[0]).toMatchObject({
      reviewer_id: "broken",
      status: "incomplete",
      reason: "process_crashed",
    });
    expect(
      events.filter((event) => event.event === "reviewer.incomplete"),
    ).toHaveLength(1);
    expect(events.at(-1)?.event).toBe("run.completed");
  });

  it("bounds a hanging forceCleanup and finalizes cancellation after the second grace period", async () => {
    let cleanupCalls = 0;
    const stuck = boundaryAdapter(
      () => ({
        [Symbol.asyncIterator](): AsyncIterator<AdapterEvent> {
          return {
            next: () =>
              new Promise<IteratorResult<AdapterEvent>>(() => undefined),
          };
        },
      }),
      {
        forceCleanup: () => {
          cleanupCalls += 1;
          return new Promise<void>(() => undefined);
        },
      },
    );
    const controller = new AbortController();
    let completion: Awaited<ReturnType<typeof runReviewRound>> | undefined;
    void runReviewRound(
      roundInput({
        adapters: { stuck },
        signal: controller.signal,
        config: { execution: { shutdown_grace_period_ms: 50 } },
      }),
    ).then((result) => {
      completion = result;
    });

    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(99);
    expect(completion).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);

    expect(cleanupCalls).toBe(1);
    expect(completion).toMatchObject({
      exitCode: 4,
      reviewers: [expect.objectContaining({ reason: "cancelled" })],
    });
  });

  it("contains a rejected forceCleanup and still emits the cancelled terminal run", async () => {
    const events: PublicEvent[] = [];
    const stuck = boundaryAdapter(
      () => ({
        [Symbol.asyncIterator](): AsyncIterator<AdapterEvent> {
          return {
            next: () =>
              new Promise<IteratorResult<AdapterEvent>>(() => undefined),
          };
        },
      }),
      { forceCleanup: async () => Promise.reject(new Error("cleanup failed")) },
    );
    const controller = new AbortController();
    const completionPromise = runReviewRound(
      roundInput({
        adapters: { stuck },
        signal: controller.signal,
        onEvent: (event) => events.push(event),
        config: { execution: { shutdown_grace_period_ms: 50 } },
      }),
    );

    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(50);
    const completion = await completionPromise;

    expect(completion.exitCode).toBe(4);
    expect(completion.reviewers[0]).toMatchObject({ reason: "cancelled" });
    expect(events.at(-1)?.event).toBe("run.completed");
  });

  it("detaches a non-cooperative iterator and handles its late next and return rejections", async () => {
    let rejectNext!: (error: Error) => void;
    let rejectReturn!: (error: Error) => void;
    let returnCalls = 0;
    const stuck = boundaryAdapter(
      () => ({
        [Symbol.asyncIterator](): AsyncIterator<AdapterEvent> {
          return {
            next: () =>
              new Promise<IteratorResult<AdapterEvent>>((_resolve, reject) => {
                rejectNext = reject;
              }),
            return: () => {
              returnCalls += 1;
              return new Promise<IteratorResult<AdapterEvent>>(
                (_resolve, reject) => {
                  rejectReturn = reject;
                },
              );
            },
          };
        },
      }),
      { forceCleanup: async () => undefined },
    );
    const controller = new AbortController();
    const completionPromise = runReviewRound(
      roundInput({
        adapters: { stuck },
        signal: controller.signal,
        config: { execution: { shutdown_grace_period_ms: 50 } },
      }),
    );

    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(50);
    const completion = await completionPromise;
    rejectNext(new Error("late next rejection"));
    rejectReturn(new Error("late return rejection"));
    await Promise.resolve();

    expect(returnCalls).toBe(1);
    expect(completion.exitCode).toBe(4);
  });

  it("bounds a non-cooperative probe cleanup and handles a late probe rejection", async () => {
    let rejectProbe!: (error: Error) => void;
    let markProbeStarted!: () => void;
    const probeStarted = new Promise<void>((resolve) => {
      markProbeStarted = resolve;
    });
    let cleanupCalls = 0;
    const stuck = boundaryAdapter(
      async function* () {
        yield {
          type: "result",
          result: passResult(),
          isolation: "enforced_read_only",
        };
      },
      {
        probe: () =>
          new Promise<AdapterCapabilities>((_resolve, reject) => {
            rejectProbe = reject;
            markProbeStarted();
          }),
        forceCleanup: () => {
          cleanupCalls += 1;
          return new Promise<void>(() => undefined);
        },
      },
    );
    const controller = new AbortController();
    let completion: Awaited<ReturnType<typeof runReviewRound>> | undefined;
    void runReviewRound(
      roundInput({
        adapters: { stuck },
        signal: controller.signal,
        config: { execution: { shutdown_grace_period_ms: 50 } },
      }),
    ).then((result) => {
      completion = result;
    });

    await probeStarted;
    controller.abort();
    for (let index = 0; index < 20 && vi.getTimerCount() === 0; index += 1) {
      await Promise.resolve();
    }
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(1);
    await vi.advanceTimersByTimeAsync(50);
    for (let index = 0; index < 20 && cleanupCalls === 0; index += 1) {
      await Promise.resolve();
    }
    expect(cleanupCalls).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(50);
    rejectProbe(new Error("late probe rejection"));
    await Promise.resolve();

    expect(completion).toMatchObject({
      exitCode: 4,
      reviewers: [expect.objectContaining({ reason: "cancelled" })],
    });
  });
});
