import { z } from "zod";

const DEFAULT_MAXIMUM_STREAM_BYTES = 8 * 1024 * 1024;

export type OpenAIStreamErrorCode =
  "cancelled" | "invalid_stream" | "response_too_large";

export class OpenAIStreamError extends Error {
  constructor(
    readonly code: OpenAIStreamErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OpenAIStreamError";
  }
}

const toolCallDeltaSchema = z.object({
  index: z.number().int().nonnegative(),
  id: z.string().optional(),
  type: z.string().optional(),
  function: z
    .object({
      name: z.string().optional(),
      arguments: z.string().optional(),
    })
    .optional(),
});

const streamEventSchema = z.object({
  choices: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      delta: z.object({
        role: z.string().optional(),
        content: z.string().nullable().optional(),
        tool_calls: z.array(toolCallDeltaSchema).optional(),
      }),
      finish_reason: z.string().nullable().optional(),
    }),
  ),
  usage: z.record(z.string(), z.unknown()).nullable().optional(),
});

export interface OpenAIStreamToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OpenAIStreamResult {
  message: {
    role: string;
    content: string | null;
    tool_calls?: OpenAIStreamToolCall[];
  };
  finish_reason?: string;
  usage?: Record<string, unknown>;
  response_bytes: number;
}

export interface ParseOpenAIChatStreamOptions {
  signal: AbortSignal;
  maximumBytes?: number;
  onProgress?(event: { byteCount: number; totalBytes: number }): void;
}

interface ToolCallAccumulator {
  id: string;
  type?: string;
  name: string;
  arguments: string;
}

function invalidStream(message: string): OpenAIStreamError {
  return new OpenAIStreamError("invalid_stream", message);
}

function validateMaximumBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("maximumBytes must be a positive safe integer");
  }
  return value;
}

/**
 * Consumes an OpenAI-compatible chat-completions SSE body and reconstructs the
 * first choice without altering any received content or tool-call fragments.
 */
export async function parseOpenAIChatStream(
  body: ReadableStream<Uint8Array>,
  options: ParseOpenAIChatStreamOptions,
): Promise<OpenAIStreamResult> {
  const maximumBytes = validateMaximumBytes(
    options.maximumBytes ?? DEFAULT_MAXIMUM_STREAM_BYTES,
  );
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let responseBytes = 0;
  let pending = "";
  let dataLines: string[] = [];
  let done = false;
  let role = "assistant";
  let content = "";
  let receivedContent = false;
  let receivedChoice = false;
  let finishReason: string | undefined;
  let usage: Record<string, unknown> | undefined;
  const toolCalls = new Map<number, ToolCallAccumulator>();

  const onAbort = () => {
    void reader.cancel(options.signal.reason).catch(() => undefined);
  };
  options.signal.addEventListener("abort", onAbort, { once: true });

  const throwIfCancelled = () => {
    if (options.signal.aborted) {
      throw new OpenAIStreamError("cancelled", "Stream parsing was cancelled.");
    }
  };

  const consumeEvent = () => {
    if (dataLines.length === 0) return;
    const encoded = dataLines.join("\n");
    dataLines = [];
    if (encoded === "[DONE]") {
      done = true;
      return;
    }
    if (done) throw invalidStream("The stream emitted data after [DONE].");
    let value: unknown;
    try {
      value = JSON.parse(encoded);
    } catch {
      throw invalidStream("The stream contained an invalid JSON event.");
    }
    const parsed = streamEventSchema.safeParse(value);
    if (!parsed.success) {
      throw invalidStream("The stream contained an invalid chat delta.");
    }
    let meaningful = false;
    if (parsed.data.usage !== undefined && parsed.data.usage !== null) {
      usage = parsed.data.usage;
      meaningful = true;
    }
    for (const choice of parsed.data.choices) {
      if (choice.index !== 0) continue;
      receivedChoice = true;
      if (choice.delta.role !== undefined) role = choice.delta.role;
      if (typeof choice.delta.content === "string") {
        receivedContent = true;
        content += choice.delta.content;
        if (choice.delta.content.length > 0) meaningful = true;
      }
      for (const delta of choice.delta.tool_calls ?? []) {
        meaningful = true;
        const accumulator = toolCalls.get(delta.index) ?? {
          id: "",
          name: "",
          arguments: "",
        };
        if (delta.id !== undefined) accumulator.id += delta.id;
        if (delta.type !== undefined) accumulator.type = delta.type;
        if (delta.function?.name !== undefined) {
          accumulator.name += delta.function.name;
        }
        if (delta.function?.arguments !== undefined) {
          accumulator.arguments += delta.function.arguments;
        }
        toolCalls.set(delta.index, accumulator);
      }
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        finishReason = choice.finish_reason;
        meaningful = true;
      }
    }
    if (meaningful) {
      options.onProgress?.({
        byteCount: Buffer.byteLength(encoded, "utf8"),
        totalBytes: responseBytes,
      });
    }
  };

  const consumeLine = (line: string) => {
    if (line === "") {
      consumeEvent();
      return;
    }
    if (line.startsWith(":")) return;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") dataLines.push(value);
  };

  const consumeDecoded = (value: string, final: boolean) => {
    pending += value;
    for (;;) {
      const newline = pending.indexOf("\n");
      if (newline < 0) break;
      const rawLine = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      consumeLine(rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine);
    }
    if (final && pending.length > 0) {
      consumeLine(pending.endsWith("\r") ? pending.slice(0, -1) : pending);
      pending = "";
    }
  };

  try {
    throwIfCancelled();
    while (!done) {
      const next = await reader.read();
      throwIfCancelled();
      if (next.done) break;
      responseBytes += next.value.byteLength;
      if (responseBytes > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new OpenAIStreamError(
          "response_too_large",
          "The stream exceeded its configured byte limit.",
        );
      }
      try {
        consumeDecoded(decoder.decode(next.value, { stream: true }), false);
      } catch (error) {
        if (error instanceof OpenAIStreamError) throw error;
        throw invalidStream("The stream was not valid UTF-8.");
      }
    }
    if (!done) {
      try {
        consumeDecoded(decoder.decode(), true);
      } catch (error) {
        if (error instanceof OpenAIStreamError) throw error;
        throw invalidStream("The stream was not valid UTF-8.");
      }
      if (dataLines.length > 0) consumeEvent();
    }
    if (!done) throw invalidStream("The stream ended without [DONE].");
    if (!receivedChoice) {
      throw invalidStream("The stream did not contain a primary choice.");
    }

    const reconstructedCalls = [...toolCalls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, call]) => {
        if (
          call.id.length === 0 ||
          call.name.length === 0 ||
          (call.type !== undefined && call.type !== "function")
        ) {
          throw invalidStream(
            "The stream ended with an incomplete function tool call.",
          );
        }
        return {
          id: call.id,
          type: "function" as const,
          function: { name: call.name, arguments: call.arguments },
        };
      });

    return {
      message: {
        role,
        content: receivedContent ? content : null,
        ...(reconstructedCalls.length === 0
          ? {}
          : { tool_calls: reconstructedCalls }),
      },
      ...(finishReason === undefined ? {} : { finish_reason: finishReason }),
      ...(usage === undefined ? {} : { usage }),
      response_bytes: responseBytes,
    };
  } finally {
    options.signal.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}
