import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const summaryPrefix =
  "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\n\n";
const summarySuffix = "Tool calls will be rejected and you will fail the task.";

function isNativeSummary(body: unknown): body is Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const value = body as Record<string, unknown>;
  if (
    !Array.isArray(value.messages) ||
    !Array.isArray(value.tools) ||
    value.tools.length === 0
  )
    return false;
  // The trusted PreCompact/PostCompact phase gate is checked by the caller.
  // The SDK can append system metadata, but never search past an assistant.
  let index = value.messages.length - 1;
  while (index >= 0 && value.messages[index]?.role === "system") index--;
  const latest = value.messages[index] as
    { role?: unknown; content?: unknown } | undefined;
  if (latest?.role !== "user") return false;
  const content = latest.content;
  // Native tool results and hook metadata may surround the summary block.
  // Match its entire text, not a marker quoted inside source or older turns.
  const texts =
    typeof content === "string"
      ? [content]
      : Array.isArray(content)
        ? content
            .filter(
              (block) =>
                block?.type === "text" && typeof block.text === "string",
            )
            .map((block) => block.text as string)
        : [];
  return texts.some(
    (text) =>
      text.startsWith(summaryPrefix) &&
      text.endsWith(summarySuffix) &&
      text.includes(
        "Your task is to create a detailed summary of the conversation",
      ) &&
      text.includes("an <analysis> block followed by a <summary> block"),
  );
}

function reply(response: ServerResponse, status: number, message: string) {
  response.writeHead(status, {
    "content-type": "application/json",
    connection: "close",
  });
  response.end(
    JSON.stringify({ type: "error", error: { type: "api_error", message } }),
  );
}

/** A session-owned protocol adapter; the vendor SDK still owns inference and retries. */
export async function createClaudeSummaryTransport(options: {
  baseUrl: string;
  apiKey: string;
  signal: AbortSignal;
  isCompacting(): boolean;
}): Promise<{ baseUrl: string; apiKey: string; close(): Promise<void> }> {
  options.signal.throwIfAborted();
  const upstream = new URL(options.baseUrl);
  if (
    !["http:", "https:"].includes(upstream.protocol) ||
    !upstream.hostname ||
    upstream.username ||
    upstream.password ||
    upstream.search ||
    upstream.hash ||
    !options.apiKey
  )
    throw new Error("Claude summary transport configuration is invalid.");
  const credential = randomBytes(32).toString("hex");
  const credentialBytes = Buffer.from(credential);
  const active = new Set<AbortController>();
  const tasks = new Set<Promise<void>>();
  let closing: Promise<void> | undefined;
  let address = "";
  const authorized = (request: IncomingMessage) => {
    const key = request.headers["x-api-key"];
    if (typeof key !== "string" || key.length !== credential.length)
      return false;
    return timingSafeEqual(Buffer.from(key), credentialBytes);
  };
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    if (closing || options.signal.aborted) {
      reply(response, 503, "Claude transport is closing.");
      return;
    }
    if (
      !authorized(request) ||
      request.headers.origin !== undefined ||
      request.headers.host !== new URL(address).host
    ) {
      reply(response, 403, "Claude transport request is not authorized.");
      return;
    }
    const incoming = new URL(request.url ?? "/", address);
    const endpoint = incoming.pathname;
    if (
      request.method !== "POST" ||
      incoming.origin !== address ||
      !["/v1/messages", "/v1/messages/count_tokens"].includes(endpoint ?? "")
    ) {
      reply(response, 404, "Claude transport route is unavailable.");
      return;
    }
    const encoding = request.headers["content-encoding"];
    if (encoding !== undefined && encoding !== "identity") {
      reply(
        response,
        415,
        "Claude transport requires an uncompressed JSON request.",
      );
      return;
    }
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of request) {
      length += chunk.length;
      if (length > MAX_REQUEST_BYTES) {
        reply(
          response,
          413,
          "Claude transport request exceeds its bounded size.",
        );
        return;
      }
      chunks.push(Buffer.from(chunk));
    }
    let body = Buffer.concat(chunks, length);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      reply(response, 400, "Claude transport requires valid JSON.");
      return;
    }
    if (
      endpoint === "/v1/messages" &&
      options.isCompacting() &&
      isNativeSummary(parsed)
    )
      body = Buffer.from(
        JSON.stringify({ ...parsed, tool_choice: { type: "none" } }),
      );
    const controller = new AbortController();
    active.add(controller);
    const disconnect = () => {
      if (!response.writableFinished) controller.abort();
    };
    response.once("close", disconnect);
    try {
      if (options.signal.aborted || closing) {
        controller.abort();
        return;
      }
      const headers = new Headers({
        "content-type": "application/json",
        "x-api-key": options.apiKey,
      });
      // Forward SDK protocol metadata, never the local session key or client routing headers.
      for (const [key, value] of Object.entries(request.headers))
        if (
          typeof value === "string" &&
          (key.startsWith("anthropic-") ||
            key.startsWith("x-stainless-") ||
            key === "user-agent" ||
            key === "x-app")
        )
          headers.set(key, value);
      headers.set("accept-encoding", "identity");
      const url = new URL(upstream);
      url.pathname = `${upstream.pathname.replace(/\/$/, "")}${endpoint}`;
      url.search = incoming.search;
      const result = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
        redirect: "manual",
      });
      // Never relay redirects: the upstream authority is fixed for the session.
      if (result.status >= 300 && result.status < 400) {
        await result.body?.cancel();
        reply(
          response,
          502,
          "Claude transport upstream redirected unexpectedly.",
        );
        return;
      }
      const responseHeaders: Record<string, string> = {};
      for (const [key, value] of result.headers)
        if (
          ([
            "content-type",
            "retry-after",
            "retry-after-ms",
            "x-should-retry",
            "request-id",
            "x-request-id",
          ].includes(key) ||
            key.startsWith("anthropic-ratelimit-")) &&
          !value.includes(options.apiKey) &&
          !value.includes(credential)
        )
          responseHeaders[key] = value;
      response.writeHead(result.status, responseHeaders);
      if (result.body)
        await pipeline(Readable.fromWeb(result.body as never), response, {
          signal: controller.signal,
        });
      else response.end();
    } finally {
      response.off("close", disconnect);
      active.delete(controller);
    }
  };
  const server = createServer((request, response) => {
    const task = handle(request, response).catch(() => {
      if (!response.headersSent && !response.destroyed)
        reply(
          response,
          502,
          "Claude transport could not complete the upstream request.",
        );
      else response.destroy();
    });
    tasks.add(task);
    void task.finally(() => tasks.delete(task));
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 30000;
  const close = () =>
    (closing ??= (async () => {
      options.signal.removeEventListener("abort", abort);
      for (const controller of active) controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await Promise.allSettled([...tasks]);
    })());
  const abort = () => {
    void close();
  };
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const listening = server.address();
  if (!listening || typeof listening === "string")
    throw new Error("Claude transport did not obtain a loopback address.");
  address = `http://127.0.0.1:${listening.port}`;
  options.signal.addEventListener("abort", abort, { once: true });
  if (options.signal.aborted) {
    await close();
    options.signal.throwIfAborted();
  }
  return { baseUrl: address, apiKey: credential, close };
}
