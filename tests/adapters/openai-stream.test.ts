import { describe, expect, it, vi } from "vitest";
import {
  OpenAIStreamError,
  parseOpenAIChatStream,
} from "../../src/adapters/openai-stream.js";

function chunkedBody(chunks: readonly Uint8Array[], onCancel?: () => void) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
    cancel() {
      onCancel?.();
    },
  });
}

function encodedChunks(value: string, boundaries: readonly number[]) {
  const bytes = new TextEncoder().encode(value);
  const chunks: Uint8Array[] = [];
  let start = 0;
  for (const end of boundaries) {
    chunks.push(bytes.subarray(start, end));
    start = end;
  }
  chunks.push(bytes.subarray(start));
  return chunks;
}

describe("OpenAI-compatible SSE reconstruction", () => {
  it("reconstructs fragmented UTF-8 content, tool calls, finish reason, and usage losslessly", async () => {
    const stream = [
      'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"A €"},"finish_reason":null}]}\r\n\r\n',
      'data: {"choices":[{"index":0,"delta":{"content":" and 🚀","tool_calls":[{"index":0,"id":"call_","type":"function","function":{"name":"read_","arguments":"{\\"pa"}}]},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"1","function":{"name":"file","arguments":"th\\":\\"src/a.ts\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":3,"total_tokens":13}}\n\n',
      "data: [DONE]\n\n",
    ].join("");
    const euroStart = new TextEncoder().encode(stream.slice(0, stream.indexOf("€"))).length;
    const rocketStart = new TextEncoder().encode(stream.slice(0, stream.indexOf("🚀"))).length;

    const result = await parseOpenAIChatStream(
      chunkedBody(
        encodedChunks(stream, [
          1,
          7,
          euroStart + 1,
          euroStart + 2,
          rocketStart + 1,
          rocketStart + 3,
          new TextEncoder().encode(stream).length - 2,
        ]),
      ),
      { signal: new AbortController().signal },
    );

    expect(result).toEqual({
      message: {
        role: "assistant",
        content: "A € and 🚀",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "read_file",
              arguments: '{"path":"src/a.ts"}',
            },
          },
        ],
      },
      finish_reason: "tool_calls",
      usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
      response_bytes: new TextEncoder().encode(stream).byteLength,
    });
  });

  it("joins repeated content deltas exactly without inventing content", async () => {
    const stream = [
      'data: {"choices":[{"index":0,"delta":{"content":"{\\"review_"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"markdown\\":\\"line 1\\\\nline 2\\"}"},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ].join("");

    await expect(
      parseOpenAIChatStream(
        chunkedBody(encodedChunks(stream, [13, 29, 57, 91])),
        { signal: new AbortController().signal },
      ),
    ).resolves.toMatchObject({
      message: {
        content: '{"review_markdown":"line 1\\nline 2"}',
      },
      finish_reason: "stop",
    });
  });

  it("rejects malformed events and streams that end without DONE", async () => {
    await expect(
      parseOpenAIChatStream(
        chunkedBody([new TextEncoder().encode("data: {not-json}\n\n")]),
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({
      code: "invalid_stream",
    });

    await expect(
      parseOpenAIChatStream(
        chunkedBody([
          new TextEncoder().encode(
            'data: {"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":"stop"}]}\n\n',
          ),
        ]),
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({
      code: "invalid_stream",
    });
  });

  it("rejects an oversized stream before accepting the result", async () => {
    const stream =
      'data: {"choices":[{"index":0,"delta":{"content":"too large"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    await expect(
      parseOpenAIChatStream(
        chunkedBody([new TextEncoder().encode(stream)]),
        { signal: new AbortController().signal, maximumBytes: 32 },
      ),
    ).rejects.toMatchObject({
      code: "response_too_large",
    });
  });

  it("cancels a blocked reader when the caller aborts", async () => {
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>(() => undefined);
      },
      cancel: cancelled,
    });
    const controller = new AbortController();
    const parsing = parseOpenAIChatStream(body, {
      signal: controller.signal,
    });

    controller.abort(new Error("stop"));

    await expect(parsing).rejects.toMatchObject({
      code: "cancelled",
    });
    expect(cancelled).toHaveBeenCalledOnce();
  });
});
