import { expect, it } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createNativeClaudeAdapter } from "../../src/adapters/native-claude.js";
import type { AdapterEvent } from "../../src/adapters/types.js";
import { resolvedContext, resolvedReviewer } from "../helpers/fixtures.js";

async function activities(messages: unknown[]) {
  const adapter = createNativeClaudeAdapter(
    { type: "claude", api_key_env: "KEY" },
    {
      environment: { KEY: "fixture" },
      runtime: () => ({
        executablePath: "fixture",
        pathEntries: [],
        sdkVersion: "fixture",
        runtimeVersion: "fixture",
        mode: "managed_process",
      }),
      query: () =>
        (async function* () {
          for (const message of messages) yield message as SDKMessage;
        })(),
    },
  );
  const events: Array<Extract<AdapterEvent, { type: "activity" }>> = [];
  for await (const event of adapter.run({
    runId: "fixture",
    reviewer: resolvedReviewer({ adapter: { type: "claude" } }),
    context: resolvedContext(),
    prompt: { system: "Review", user: "Input", combined: "Review Input" },
    resultJsonSchema: { type: "object" },
    isolationPolicy: "prefer_enforced",
    signal: new AbortController().signal,
  }))
    if (event.type === "activity") events.push(event);
  return events;
}

it("identifies native tool progress by semantic request and completion rather than heartbeat IDs", async () => {
  const call = (id: string, input: unknown) => ({
    type: "assistant",
    message: {
      id: "model-message",
      content: [{ type: "tool_use", id, name: "Read", input }],
    },
  });
  const complete = (id: string) => ({
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: id,
          content: "private source content",
        },
      ],
    },
  });
  const events = await activities([
    call("call-1", { file_path: "private-source.ts", offset: 0 }),
    complete("call-1"),
    call("call-2", { offset: 0, file_path: "private-source.ts" }),
    complete("call-2"),
    call("call-3", { file_path: "private-source.ts", offset: 40 }),
    {
      type: "tool_progress",
      tool_use_id: "call-3",
      elapsed_time_seconds: 1,
      uuid: "heartbeat-1",
    },
    {
      type: "tool_progress",
      tool_use_id: "call-3",
      elapsed_time_seconds: 2,
      uuid: "heartbeat-2",
    },
  ]);
  expect(events[0]?.identity).toMatch(/^claude:tool:/);
  expect(events[1]?.identity).toMatch(/^claude:tool-result:/);
  expect(events[2]?.identity).toBe(events[0]?.identity);
  expect(events[3]?.identity).toBe(events[1]?.identity);
  expect(events[4]?.identity).not.toBe(events[0]?.identity);
  expect(events[5]?.identity).toBeUndefined();
  expect(events[6]?.identity).toBeUndefined();
  expect(JSON.stringify(events)).not.toContain("private-source");
  expect(JSON.stringify(events)).not.toContain("private source content");
});

it("counts streaming output without exposing text or treating envelope IDs as new work", async () => {
  const stream = (uuid: string, event: unknown) => ({
    type: "stream_event",
    uuid,
    parent_tool_use_id: null,
    event,
  });
  const events = await activities([
    stream("start", {
      type: "message_start",
      message: { id: "assistant-message" },
    }),
    stream("delta-1", {
      type: "content_block_delta",
      delta: { type: "text_delta", text: "é" },
    }),
    stream("delta-2", {
      type: "content_block_delta",
      delta: { type: "thinking_delta", thinking: "private thought" },
    }),
    stream("delta-2", {
      type: "content_block_delta",
      delta: { type: "thinking_delta", thinking: "private thought" },
    }),
    stream("stop", { type: "message_stop" }),
  ]);
  expect(events[0]?.identity).toBeUndefined();
  expect(events[1]).toMatchObject({
    identity: expect.stringMatching(/^claude:output:/),
    byteCount: 2,
  });
  expect(events[2]).toMatchObject({
    identity: events[1]?.identity,
    byteCount: 17,
  });
  expect(events[3]?.byteCount).toBe(17);
  expect(events[4]?.identity).toBeUndefined();
  expect(JSON.stringify(events)).not.toContain("private thought");
  expect(JSON.stringify(events)).not.toContain("assistant-message");
});

it("reports compaction completion once by boundary while repeated compacting statuses stay bounded", async () => {
  const events = await activities([
    {
      type: "system",
      subtype: "status",
      status: "compacting",
      uuid: "status-a",
    },
    {
      type: "system",
      subtype: "status",
      status: "compacting",
      uuid: "status-b",
    },
    { type: "system", subtype: "compact_boundary", uuid: "boundary-a" },
    { type: "system", subtype: "compact_boundary", uuid: "boundary-a" },
  ]);
  expect(events[0]?.identity).toMatch(/^claude:compaction-start:/);
  expect(events[1]?.identity).toBe(events[0]?.identity);
  expect(events[2]?.identity).toMatch(/^claude:compaction-complete:/);
  expect(events[3]?.identity).toBe(events[2]?.identity);
});

it("keeps failed tools and unknown streaming envelopes from extending meaningful progress", async () => {
  const events = await activities([
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "failed-read",
            name: "Read",
            input: { file_path: "missing.ts" },
          },
        ],
      },
    },
    {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "failed-read",
            is_error: true,
            content: "Missing",
          },
        ],
      },
    },
    {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "unknown-read",
            content: "Uncorrelated",
          },
        ],
      },
    },
    {
      type: "stream_event",
      uuid: "unknown-stream",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Not a correlated message" },
      },
    },
    { type: "system", subtype: "init", uuid: "init-repeated" },
  ]);
  expect(events[0]?.identity).toMatch(/^claude:tool:/);
  expect(
    events
      .slice(1)
      .every(
        (event) =>
          event.identity === undefined && event.byteCount === undefined,
      ),
  ).toBe(true);
});
