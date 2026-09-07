import { getEventListeners } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import type { AdapterEvent } from "../../src/adapters/types.js";

afterEach(() => vi.useRealTimers());

async function watchdog(timeoutMs = 300_000, maximumIdentities?: number) {
  const native = await import("../../src/orchestrator/native-progress.js");
  const controller = new AbortController();
  const timeout = vi.fn((error: Error) => controller.abort(error));
  const value = native.createNativeProgressWatchdog({
    timeoutMs,
    signal: controller.signal,
    onTimeout: timeout,
    ...(maximumIdentities === undefined ? {} : { maximumIdentities }),
  });
  return { native, controller, timeout, value };
}
const activity = (identity?: string, byteCount?: number): AdapterEvent => ({
  type: "activity",
  message: "Native runtime activity.",
  ...(identity === undefined ? {} : { identity }),
  ...(byteCount === undefined ? {} : { byteCount }),
});

it("enforces the configured silence limit without shortening a legitimate thinking interval", async () => {
  vi.useFakeTimers();
  const { native, controller, timeout, value } = await watchdog();
  await vi.advanceTimersByTimeAsync(299_999);
  expect(controller.signal.aborted).toBe(false);
  expect(value.snapshot().lastProgressAgeMs).toBe(299_999);
  await vi.advanceTimersByTimeAsync(1);
  expect(controller.signal.reason).toBeInstanceOf(native.NativeNoProgressError);
  expect(controller.signal.reason).toMatchObject({
    code: "no_progress_timeout",
  });
  expect(timeout).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
});

it("ignores generic messages and duplicate semantic identities", async () => {
  vi.useFakeTimers();
  const { controller, value } = await watchdog(1000);
  await vi.advanceTimersByTimeAsync(100);
  expect(value.record(activity("read:source-1"))).toBe(true);
  for (let index = 0; index < 4; index++) {
    await vi.advanceTimersByTimeAsync(200);
    expect(value.record(activity("read:source-1"))).toBe(false);
    expect(value.record(activity())).toBe(false);
  }
  await vi.advanceTimersByTimeAsync(199);
  expect(controller.signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(controller.signal.reason).toMatchObject({
    code: "no_progress_timeout",
  });
  expect(value.snapshot()).toMatchObject({
    activityCount: 9,
    meaningfulCount: 1,
    identityCount: 1,
  });
});

it("resets only when cumulative bytes advance for the same response", async () => {
  vi.useFakeTimers();
  const { controller, value } = await watchdog(1000);
  expect(value.record(activity("response", 0))).toBe(false);
  await vi.advanceTimersByTimeAsync(100);
  expect(value.record(activity("response", 10))).toBe(true);
  await vi.advanceTimersByTimeAsync(300);
  expect(value.record(activity("response", 10))).toBe(false);
  expect(value.record(activity("response", 5))).toBe(false);
  await vi.advanceTimersByTimeAsync(300);
  expect(value.record(activity("response", 11))).toBe(true);
  await vi.advanceTimersByTimeAsync(999);
  expect(controller.signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(controller.signal.aborted).toBe(true);
  expect(value.snapshot().meaningfulCount).toBe(2);
});

it("lets new files and compaction transitions extend progress without replay credit", async () => {
  vi.useFakeTimers();
  const { controller, value } = await watchdog(1000);
  for (const identity of [
    "read:first",
    "read:second",
    "compaction:start:one",
    "compaction:complete:one",
  ]) {
    await vi.advanceTimersByTimeAsync(900);
    expect(value.record(activity(identity))).toBe(true);
    expect(value.record(activity(identity))).toBe(false);
    expect(controller.signal.aborted).toBe(false);
  }
  value.close();
  expect(vi.getTimerCount()).toBe(0);
});

it("bounds identity storage without allowing evicted replays to reset the timer", async () => {
  vi.useFakeTimers();
  const { controller, value } = await watchdog(1000, 2);
  expect(value.record(activity("first"))).toBe(true);
  await vi.advanceTimersByTimeAsync(100);
  expect(value.record(activity("stream", 1))).toBe(true);
  await vi.advanceTimersByTimeAsync(100);
  expect(value.record(activity("overflow"))).toBe(false);
  expect(value.record(activity("first"))).toBe(false);
  expect(value.record(activity("stream", 2))).toBe(true);
  expect(value.snapshot()).toMatchObject({
    identityCount: 2,
    identityOverflow: true,
  });
  await vi.advanceTimersByTimeAsync(1000);
  expect(controller.signal.aborted).toBe(true);
});

it.each(["cancel", "close", "result", "failure", "already_cancelled"] as const)(
  "clears its timer and abort listener on %s",
  async (mode) => {
    vi.useFakeTimers();
    const native = await import("../../src/orchestrator/native-progress.js");
    const controller = new AbortController();
    if (mode === "already_cancelled") controller.abort();
    const timeout = vi.fn();
    const value = native.createNativeProgressWatchdog({
      timeoutMs: 1000,
      signal: controller.signal,
      onTimeout: timeout,
    });
    if (mode === "cancel") controller.abort(new Error("Caller stopped"));
    else if (mode === "result")
      value.record({ type: "result" } as AdapterEvent);
    else if (mode === "failure")
      value.record({ type: "failure" } as AdapterEvent);
    else value.close();
    value.close();
    expect(value.record(activity("late"))).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(10000);
    expect(timeout).not.toHaveBeenCalled();
  },
);

it("ignores invalid identities and cumulative byte counts without retaining source data", async () => {
  vi.useFakeTimers();
  const { value } = await watchdog(1000);
  for (const event of [
    activity(""),
    activity("x".repeat(4097)),
    activity("negative", -1),
    activity("nan", NaN),
    activity("fraction", 1.5),
  ])
    expect(value.record(event)).toBe(false);
  expect(value.record(activity("private-source-identity"))).toBe(true);
  expect(JSON.stringify(value.snapshot())).not.toContain(
    "private-source-identity",
  );
  expect(value.snapshot().identityCount).toBe(1);
  value.close();
});

it("does not revive an elapsed deadline when the timer callback was delayed", async () => {
  vi.useFakeTimers();
  const native = await import("../../src/orchestrator/native-progress.js");
  const controller = new AbortController();
  let time = 0;
  const timeout = vi.fn((error: Error) => controller.abort(error));
  const value = native.createNativeProgressWatchdog({
    timeoutMs: 1000,
    signal: controller.signal,
    onTimeout: timeout,
    now: () => time,
  });
  time = 1000;
  expect(value.record(activity("late-first-result-byte", 1))).toBe(false);
  expect(controller.signal.reason).toMatchObject({
    code: "no_progress_timeout",
  });
  expect(timeout).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("does not share progress or cancellation between concurrent reviewers", async () => {
  vi.useFakeTimers();
  const first = await watchdog(1000);
  const second = await watchdog(1000);
  await vi.advanceTimersByTimeAsync(900);
  expect(second.value.record(activity("read:second-reviewer"))).toBe(true);
  await vi.advanceTimersByTimeAsync(100);
  expect(first.controller.signal.aborted).toBe(true);
  expect(second.controller.signal.aborted).toBe(false);
  expect(vi.getTimerCount()).toBe(1);
  second.value.close();
  expect(vi.getTimerCount()).toBe(0);
});

it("uses elapsed monotonic time when the wall clock jumps", async () => {
  vi.useFakeTimers();
  const { controller, value } = await watchdog(1000);
  await vi.advanceTimersByTimeAsync(400);
  vi.setSystemTime(Date.now() + 60_000);
  expect(value.record(activity("read:new-file"))).toBe(true);
  await vi.advanceTimersByTimeAsync(999);
  expect(controller.signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(controller.signal.aborted).toBe(true);
});

it("keeps one active timer during sustained streaming output", async () => {
  vi.useFakeTimers();
  const { controller, value } = await watchdog(1000);
  for (let bytes = 1; bytes <= 5000; bytes++) {
    expect(value.record(activity("response:one", bytes))).toBe(true);
  }
  expect(value.snapshot()).toMatchObject({
    identityCount: 1,
    meaningfulCount: 5000,
    identityOverflow: false,
  });
  expect(vi.getTimerCount()).toBe(1);
  value.close();
  expect(vi.getTimerCount()).toBe(0);
  expect(controller.signal.aborted).toBe(false);
});

it.each([0, -1, 0.5, NaN, Infinity, 2_147_483_648])(
  "rejects invalid timeout %s without creating a timer",
  async (timeoutMs) => {
    vi.useFakeTimers();
    const native = await import("../../src/orchestrator/native-progress.js");
    const signal = new AbortController().signal;
    expect(() =>
      native.createNativeProgressWatchdog({
        timeoutMs,
        signal,
        onTimeout: () => {},
      }),
    ).toThrow(TypeError);
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(signal, "abort")).toHaveLength(0);
  },
);
