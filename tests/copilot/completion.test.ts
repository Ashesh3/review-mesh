import { getEventListeners } from "node:events";
import type { SessionEvent } from "@github/copilot-sdk";
import { afterEach, expect, it, vi } from "vitest";
import { sendCopilotReviewAndWait } from "../../src/runtime/copilot-completion.js";
import {
  createTestCopilotSession,
  type TestCopilotSession,
} from "../helpers/copilot-session.js";

afterEach(() => vi.useRealTimers());

function session(send: () => Promise<unknown>) {
  return createTestCopilotSession({
    sendRequest: send,
  });
}
function idle(value: TestCopilotSession) {
  value._dispatchEvent({
    id: "idle",
    timestamp: new Date().toISOString(),
    parentId: null,
    type: "session.idle",
    ephemeral: true,
    data: {},
  });
}
function failed(value: TestCopilotSession) {
  value._dispatchEvent({
    id: "error",
    timestamp: new Date().toISOString(),
    parentId: null,
    type: "session.error",
    data: { errorType: "fixture", message: "Provider failed" },
  } as SessionEvent);
}

it.each(["before_send", "pending_ack", "after_ack"] as const)(
  "cancels the completion wait at %s without retaining timers or abort listeners",
  async (stage) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const reason = new Error("Requested cancellation");
    const send = vi.fn(() =>
      stage === "pending_ack"
        ? new Promise<never>(() => {})
        : Promise.resolve({ messageId: "sent" }),
    );
    const value = session(send);
    if (stage === "before_send") controller.abort(reason);
    const pending = sendCopilotReviewAndWait(
      value,
      { prompt: "Review" },
      60000,
      controller.signal,
    );
    const rejected = expect(pending).rejects.toBe(reason);
    if (stage === "after_ack") await vi.advanceTimersByTimeAsync(0);
    controller.abort(reason);
    value._markDisconnected();
    await rejected;
    expect(send).toHaveBeenCalledTimes(stage === "before_send" ? 0 : 1);
    expect(vi.getTimerCount()).toBe(0);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  },
);

it("waits for the send acknowledgement when idle arrives first", async () => {
  vi.useFakeTimers();
  let acknowledge: (result: unknown) => void;
  const value = session(
    () =>
      new Promise((resolve) => {
        acknowledge = resolve;
      }),
  );
  const controller = new AbortController();
  let completed = false;
  const pending = sendCopilotReviewAndWait(
    value,
    { prompt: "Review" },
    60000,
    controller.signal,
  ).then(() => {
    completed = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  idle(value);
  await vi.advanceTimersByTimeAsync(0);
  expect(completed).toBe(false);
  acknowledge!({ messageId: "sent" });
  await pending;
  expect(completed).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
});

it("releases its wait when the session errors while send is pending", async () => {
  vi.useFakeTimers();
  const value = session(() => new Promise<never>(() => {}));
  const controller = new AbortController();
  const pending = sendCopilotReviewAndWait(
    value,
    { prompt: "Review" },
    60000,
    controller.signal,
  );
  const rejected = expect(pending).rejects.toThrow("Provider failed");
  failed(value);
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
});

it("bounds a missing send acknowledgement and clears the completion timer", async () => {
  vi.useFakeTimers();
  const value = session(() => new Promise<never>(() => {}));
  const controller = new AbortController();
  const pending = sendCopilotReviewAndWait(
    value,
    { prompt: "Review" },
    100,
    controller.signal,
  );
  const rejected = expect(pending).rejects.toThrow("Timeout after 100ms");
  await vi.advanceTimersByTimeAsync(100);
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
});

it("preserves a send rejection even when its reason is undefined", async () => {
  vi.useFakeTimers();
  const value = session(() => Promise.reject(undefined));
  const controller = new AbortController();
  const pending = sendCopilotReviewAndWait(
    value,
    { prompt: "Review" },
    60000,
    controller.signal,
  );
  await expect(pending).rejects.toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
});
