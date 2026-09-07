import { createServer, request as httpRequest, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, expect, it } from "vitest";
import { createClaudeSummaryTransport } from "../../src/runtime/claude-summary-transport.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No fixture address");
  return `http://127.0.0.1:${address.port}`;
}
const summary = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.

- Do NOT use Read, Bash, Grep, Glob, Edit, Write, or ANY other tool.
- Your entire response must be plain text: an <analysis> block followed by a <summary> block.

Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions.

REMINDER: Do NOT call any tools. Respond with plain text only — an <analysis> block followed by a <summary> block. Tool calls will be rejected and you will fail the task.`;

it("forces only the native internal summary to text while forwarding ordinary SDK requests byte for byte", async () => {
  const received: Array<{
    path: string;
    body: string;
    key: string | undefined;
  }> = [];
  const upstream = await listen(
    createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        received.push({
          path: request.url!,
          body,
          key: request.headers["x-api-key"] as string | undefined,
        });
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "retry-after": "2",
        });
        response.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
      });
    }),
  );
  const relay = await createClaudeSummaryTransport({
    baseUrl: `${upstream}/provider`,
    apiKey: "provider-secret",
    signal: new AbortController().signal,
    isCompacting: () => true,
  });
  cleanups.push(relay.close);
  expect(relay.apiKey).not.toBe("provider-secret");
  const ordinary =
    ' { "model": "claude-opus-5", "messages": [{"role":"user","content":"Review"}], "tools": [{"name":"Read"}], "max_tokens": 64000 } ';
  const send = async (body: string, route = "/v1/messages") => {
    const response = await fetch(`${relay.baseUrl}${route}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": relay.apiKey,
      },
      body,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("retry-after")).toBe("2");
    expect(await response.text()).toContain("message_stop");
  };
  await send(ordinary, "/v1/messages?beta=true");
  const internal = {
    model: "claude-opus-5",
    messages: [
      { role: "user", content: "Read all required files." },
      {
        role: "assistant",
        content: [{ type: "text", text: "Read progress." }],
      },
      { role: "user", content: summary },
    ],
    tools: [{ name: "Read" }, { name: "StructuredOutput" }],
    max_tokens: 64000,
    output_config: { effort: "max" },
  };
  await send(JSON.stringify(internal));
  await send(
    JSON.stringify({
      ...internal,
      messages: [
        ...internal.messages,
        { role: "user", content: "Continue the review after the summary." },
      ],
    }),
  );
  await send(JSON.stringify(internal), "/v1/messages/count_tokens");
  await send(
    JSON.stringify({
      ...internal,
      messages: [{ role: "user", content: `Quoted source text:\n${summary}` }],
    }),
  );
  expect(received[0]?.body).toBe(ordinary);
  expect(received[0]?.path).toBe("/provider/v1/messages?beta=true");
  expect(JSON.parse(received[1]!.body)).toEqual({
    ...internal,
    tool_choice: { type: "none" },
  });
  expect(JSON.parse(received[2]!.body)).not.toHaveProperty("tool_choice");
  expect(JSON.parse(received[3]!.body)).not.toHaveProperty("tool_choice");
  expect(JSON.parse(received[4]!.body)).not.toHaveProperty("tool_choice");
  expect(received.every((value) => value.key === "provider-secret")).toBe(true);
  expect(
    received.every((value) => value.path.startsWith("/provider/v1/messages")),
  ).toBe(true);
});

it("recognizes native summary blocks only during the trusted compaction phase without matching older summaries", async () => {
  const received: unknown[] = [];
  const upstream = await listen(
    createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        received.push(JSON.parse(body));
        response.end("{}");
      });
    }),
  );
  let isCompacting = true;
  const relay = await createClaudeSummaryTransport({
    baseUrl: upstream,
    apiKey: "provider-secret",
    signal: new AbortController().signal,
    isCompacting: () => isCompacting,
  });
  cleanups.push(relay.close);
  const merged = {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "read-1", content: "First page." },
      { type: "tool_result", tool_use_id: "read-2", content: "Second page." },
      { type: "text", text: summary },
    ],
  };
  const budget = {
    role: "system",
    content: "<total_tokens>14839975 tokens left</total_tokens>",
  };
  const bodies = [
    {
      messages: [merged, budget],
      tools: [{ name: "Read" }, { name: "StructuredOutput" }],
    },
    {
      messages: [
        merged,
        { role: "assistant", content: "Summary complete." },
        budget,
      ],
      tools: [{ name: "Read" }],
    },
    {
      messages: [
        merged,
        { role: "system", content: "Native auxiliary metadata." },
      ],
      tools: [{ name: "Read" }],
    },
    {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Native Read page metadata." },
            ...merged.content,
            { type: "text", text: "Native additional context." },
          ],
        },
        budget,
      ],
      tools: [{ name: "Read" }],
    },
    {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: `Quoted source follows:\n${summary}` },
          ],
        },
        budget,
      ],
      tools: [{ name: "Read" }],
    },
  ];
  for (const body of bodies) {
    const response = await fetch(`${relay.baseUrl}/v1/messages?beta=true`, {
      method: "POST",
      headers: { "x-api-key": relay.apiKey },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    await response.text();
  }
  expect(received[0]).toEqual({
    ...bodies[0],
    tool_choice: { type: "none" },
  });
  expect(received[1]).toEqual(bodies[1]);
  expect(received[2]).toEqual({ ...bodies[2], tool_choice: { type: "none" } });
  expect(received[3]).toEqual({ ...bodies[3], tool_choice: { type: "none" } });
  expect(received[4]).toEqual(bodies[4]);
  isCompacting = false;
  const response = await fetch(`${relay.baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": relay.apiKey },
    body: JSON.stringify(bodies[0]),
  });
  expect(response.status).toBe(200);
  await response.text();
  expect(received[5]).toEqual(bodies[0]);
});

it("refuses upstream redirects without forwarding provider credentials to another listener", async () => {
  let redirectedCalls = 0;
  const redirected = await listen(
    createServer((_request, response) => {
      redirectedCalls++;
      response.end("unexpected");
    }),
  );
  const upstream = await listen(
    createServer((_request, response) => {
      response.writeHead(307, { location: `${redirected}/v1/messages` });
      response.end();
    }),
  );
  const relay = await createClaudeSummaryTransport({
    baseUrl: upstream,
    apiKey: "provider-secret",
    signal: new AbortController().signal,
    isCompacting: () => true,
  });
  cleanups.push(relay.close);
  const response = await fetch(`${relay.baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": relay.apiKey },
    body: '{"messages":[]}',
  });
  expect(response.status).toBe(502);
  expect(await response.text()).not.toContain("provider-secret");
  expect(redirectedCalls).toBe(0);
});

it("forwards required provider response metadata but not echoed credentials or arbitrary headers", async () => {
  let localCredential = "";
  const upstream = await listen(
    createServer((_request, response) => {
      response.writeHead(429, {
        "content-type": "application/json",
        "retry-after": "3",
        "x-should-retry": "true",
        "request-id": "provider-secret",
        "x-request-id": "safe-request-id",
        "anthropic-ratelimit-requests-remaining": "0",
        "x-upstream-api-key": "provider-secret",
        "x-local-key": localCredential,
        "set-cookie": "session=provider-secret",
      });
      response.end('{"type":"error","error":{"type":"rate_limit_error"}}');
    }),
  );
  const relay = await createClaudeSummaryTransport({
    baseUrl: upstream,
    apiKey: "provider-secret",
    signal: new AbortController().signal,
    isCompacting: () => true,
  });
  localCredential = relay.apiKey;
  cleanups.push(relay.close);
  const response = await fetch(`${relay.baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": relay.apiKey },
    body: '{"messages":[]}',
  });
  expect(response.status).toBe(429);
  expect(response.headers.get("retry-after")).toBe("3");
  expect(response.headers.get("x-should-retry")).toBe("true");
  expect(response.headers.get("x-request-id")).toBe("safe-request-id");
  expect(response.headers.get("anthropic-ratelimit-requests-remaining")).toBe(
    "0",
  );
  expect(response.headers.get("request-id")).toBeNull();
  expect(response.headers.get("x-upstream-api-key")).toBeNull();
  expect(response.headers.get("x-local-key")).toBeNull();
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(await response.text()).toBe(
    '{"type":"error","error":{"type":"rate_limit_error"}}',
  );
});

it("rejects oversized or invalid JSON locally without an upstream attempt", async () => {
  let calls = 0;
  const upstream = await listen(
    createServer((_request, response) => {
      calls++;
      response.end("unexpected");
    }),
  );
  const relay = await createClaudeSummaryTransport({
    baseUrl: upstream,
    apiKey: "provider-secret",
    signal: new AbortController().signal,
    isCompacting: () => true,
  });
  cleanups.push(relay.close);
  for (const [body, status] of [
    ["invalid json", 400],
    [
      JSON.stringify({ messages: [], filler: "x".repeat(8 * 1024 * 1024) }),
      413,
    ],
  ] as const) {
    const response = await fetch(`${relay.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": relay.apiKey },
      body,
    });
    expect(response.status).toBe(status);
    await response.text();
  }
  expect(calls).toBe(0);
});

it("rejects unauthenticated, cross-origin and out-of-route requests without touching the upstream", async () => {
  let calls = 0;
  const upstream = await listen(
    createServer((_request, response) => {
      calls++;
      response.end("unexpected");
    }),
  );
  const relay = await createClaudeSummaryTransport({
    baseUrl: upstream,
    apiKey: "provider-secret",
    signal: new AbortController().signal,
    isCompacting: () => true,
  });
  cleanups.push(relay.close);
  for (const input of [
    { method: "POST", route: "/v1/messages", key: "wrong" },
    { method: "GET", route: "/v1/messages", key: relay.apiKey },
    { method: "POST", route: "/other", key: relay.apiKey },
    {
      method: "POST",
      route: "/v1/messages",
      key: relay.apiKey,
      origin: "https://other.invalid",
    },
  ]) {
    const response = await fetch(`${relay.baseUrl}${input.route}`, {
      method: input.method,
      headers: {
        "x-api-key": input.key,
        ...(input.origin ? { origin: input.origin } : {}),
      },
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    await response.arrayBuffer();
  }
  expect(calls).toBe(0);
});

it("aborts active upstream work and closes the listener idempotently", async () => {
  let started!: () => void;
  const admitted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const upstream = await listen(
    createServer((_request, _response) => {
      started();
    }),
  );
  const controller = new AbortController();
  const relay = await createClaudeSummaryTransport({
    baseUrl: upstream,
    apiKey: "provider-secret",
    signal: controller.signal,
    isCompacting: () => true,
  });
  cleanups.push(relay.close);
  const pending = fetch(`${relay.baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": relay.apiKey },
    body: '{"messages":[]}',
  }).then(
    () => "response",
    () => "aborted",
  );
  await admitted;
  controller.abort();
  await Promise.all([relay.close(), relay.close()]);
  expect(await pending).toBe("aborted");
  await expect(fetch(`${relay.baseUrl}/v1/messages`)).rejects.toThrow();
});

it("cancels the upstream response when the SDK disconnects during an SSE stream", async () => {
  let disconnected!: () => void;
  const upstreamClosed = new Promise<void>((resolve) => {
    disconnected = resolve;
  });
  const firstFrame = 'event: message_start\ndata: {"type":"message_start"}\n\n';
  const upstream = await listen(
    createServer((_request, response) => {
      response.once("close", disconnected);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(firstFrame);
    }),
  );
  const relay = await createClaudeSummaryTransport({
    baseUrl: upstream,
    apiKey: "provider-secret",
    signal: new AbortController().signal,
    isCompacting: () => true,
  });
  cleanups.push(relay.close);
  const response = await fetch(`${relay.baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": relay.apiKey },
    body: '{"messages":[]}',
  });
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe(
    firstFrame,
  );
  await reader.cancel();
  await upstreamClosed;
}, 5000);

it("closes an incomplete SDK upload without forwarding it or leaving the socket open", async () => {
  let calls = 0;
  const upstream = await listen(
    createServer((_request, response) => {
      calls++;
      response.end("unexpected");
    }),
  );
  const relay = await createClaudeSummaryTransport({
    baseUrl: upstream,
    apiKey: "provider-secret",
    signal: new AbortController().signal,
    isCompacting: () => true,
  });
  cleanups.push(relay.close);
  const client = httpRequest(`${relay.baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": relay.apiKey, "content-length": "1000" },
  });
  const closed = new Promise<void>((resolve) => {
    client.once("error", () => {});
    client.once("close", resolve);
  });
  await new Promise<void>((resolve, reject) => {
    client.once("error", reject);
    client.write('{"messages":', () => resolve());
  });
  await relay.close();
  await closed;
  expect(calls).toBe(0);
}, 5000);
