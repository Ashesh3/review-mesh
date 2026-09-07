import { expect, it } from "vitest";
import type { SessionEvent } from "@github/copilot-sdk";
import { createCopilotProgressTracker } from "../../src/runtime/copilot-progress.js";

function event(type: string, data: unknown, id = "event-1"): SessionEvent {
  return {
    type,
    data,
    id,
    timestamp: "2026-09-07T00:00:00Z",
    parentId: null,
  } as SessionEvent;
}

it("identifies repeated tool reads by canonical arguments instead of fresh call IDs", () => {
  const track = createCopilotProgressTracker();
  const first = track(
    event("tool.execution_start", {
      toolName: "view",
      toolCallId: "one",
      arguments: { path: "private-path.ts", view_range: [1, 30] },
    }),
  );
  const replay = track(
    event("tool.execution_start", {
      toolName: "view",
      toolCallId: "two",
      arguments: { view_range: [1, 30], path: "private-path.ts" },
    }),
  );
  const next = track(
    event("tool.execution_start", {
      toolName: "view",
      toolCallId: "three",
      arguments: { path: "private-path.ts", view_range: [31, 60] },
    }),
  );
  expect(first?.identity).toMatch(/^copilot:tool:start:[a-f0-9]{64}$/);
  expect(replay?.identity).toBe(first?.identity);
  expect(next?.identity).not.toBe(first?.identity);
  const complete = track(
    event("tool.execution_complete", { toolCallId: "one", success: true }),
  );
  expect(complete?.identity).toBe(
    first?.identity?.replace(":start:", ":complete:"),
  );
  expect(
    track(
      event("tool.execution_complete", { toolCallId: "two", success: false }),
    )?.identity,
  ).toBeUndefined();
  expect(JSON.stringify([first, replay, next, complete])).not.toContain(
    "private-path",
  );
  expect(track(event("assistant.turn_start", {}))?.identity).toBeUndefined();
});

it.each(["assistant.message_delta", "assistant.reasoning_delta"])(
  "reports incremental %s byte counts without raw text or replay credit",
  (type) => {
    const track = createCopilotProgressTracker();
    const key =
      type === "assistant.message_delta" ? "messageId" : "reasoningId";
    const first = track(
      event(
        type,
        { [key]: "private-response-id", deltaContent: "private-secret" },
        "delta-1",
      ),
    );
    const replay = track(
      event(
        type,
        { [key]: "private-response-id", deltaContent: "private-secret" },
        "delta-1",
      ),
    );
    const next = track(
      event(
        type,
        { [key]: "private-response-id", deltaContent: "é" },
        "delta-2",
      ),
    );
    expect(first?.byteCount).toBe(Buffer.byteLength("private-secret"));
    expect(replay).toBeUndefined();
    expect(next?.identity).toBe(first?.identity);
    expect(next?.byteCount).toBe(Buffer.byteLength("private-secreté"));
    expect(JSON.stringify([first, replay, next])).not.toContain("private");
  },
);

it("emits explicit compaction identities and keeps long streams advancing with bounded replay memory", () => {
  const track = createCopilotProgressTracker(2);
  const first = track(event("session.compaction_start", {}, "compaction-a"));
  expect(first?.identity).toMatch(/^copilot:compaction:/);
  expect(
    track(event("session.compaction_start", {}, "compaction-a"))?.identity,
  ).toBe(first?.identity);
  const delta = (id: string) =>
    event(
      "assistant.message_delta",
      { messageId: "message", deltaContent: "x" },
      id,
    );
  expect(track(delta("one"))?.byteCount).toBe(1);
  expect(track(delta("two"))?.byteCount).toBe(2);
  expect(track(delta("three"))?.byteCount).toBe(3);
  expect(track(delta("two"))).toBeUndefined();
  expect(track(delta("three"))).toBeUndefined();
});
