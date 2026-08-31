import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createOpenAICompatibleAdapter,
  type OpenAICompatibleAdapterDependencies,
} from "../../src/adapters/openai-compatible.js";
import { AdapterRegistry } from "../../src/adapters/registry.js";
import type {
  AdapterEvent,
  AdapterReviewInput,
  ReviewAdapter,
} from "../../src/adapters/types.js";
import { reviewerResultJsonSchema } from "../../src/protocol/json-schema.js";
import {
  passResult,
  resolvedContext,
  resolvedReviewer,
} from "../helpers/fixtures.js";

const registration = {
  type: "openai_compatible" as const,
  base_url_env: "TEST_OPENAI_BASE_URL",
  api_key_env: "TEST_OPENAI_API_KEY",
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function assistantResponse(message: Record<string, unknown>): Response {
  return jsonResponse({ choices: [{ message }] });
}

function fetchMock(
  implementation: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>,
): typeof fetch {
  return vi.fn(implementation) as unknown as typeof fetch;
}

async function collect(adapter: ReviewAdapter, input: AdapterReviewInput) {
  const events: AdapterEvent[] = [];
  for await (const event of adapter.run(input)) events.push(event);
  return events;
}

function terminal(events: AdapterEvent[]) {
  const event = events.find(
    (candidate) => candidate.type === "result" || candidate.type === "failure",
  );
  if (event === undefined) throw new Error("missing terminal event");
  return event;
}

function setup(
  workspace: string,
  dependencies: OpenAICompatibleAdapterDependencies,
  overrides?: Partial<AdapterReviewInput>,
) {
  const reviewer = resolvedReviewer({
    adapterId: "gateway",
    adapter: registration,
    model: "review-model",
  });
  const controller = new AbortController();
  const input: AdapterReviewInput = {
    runId: "run-1",
    reviewer,
    context: resolvedContext({ workspace }),
    prompt: {
      system: "Trusted system prompt.",
      user: "Review this workspace.",
      combined: "Trusted system prompt.\n\nReview this workspace.",
    },
    resultJsonSchema: reviewerResultJsonSchema,
    isolationPolicy: "prefer_enforced",
    signal: controller.signal,
    ...overrides,
  };
  return {
    adapter: createOpenAICompatibleAdapter(registration, {
      environment: {
        TEST_OPENAI_BASE_URL: "https://gateway.example/v1",
        TEST_OPENAI_API_KEY: "test-secret",
      },
      ...dependencies,
    }),
    controller,
    input,
    reviewer,
  };
}

describe("OpenAI-compatible adapter", () => {
  it("uses only bounded direct read tools and validates a strict final result", async () => {
    const root = await mkdtemp(
      join(process.env.TEMP ?? "C:\\Temp", "mesh-oai-"),
    );
    await mkdir(join(root, "src"));
    await writeFile(
      join(root, "src", "math.ts"),
      "export const divide = (a: number, b: number) => a / b;\n",
    );
    const requests: Array<{
      url: string;
      init: RequestInit | undefined;
      body: any;
    }> = [];
    const responses = [
      assistantResponse({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "list-1",
            type: "function",
            function: { name: "list_files", arguments: "{}" },
          },
          {
            id: "read-1",
            type: "function",
            function: {
              name: "read_file",
              arguments: JSON.stringify({ path: "src/math.ts" }),
            },
          },
          {
            id: "search-1",
            type: "function",
            function: {
              name: "search_text",
              arguments: JSON.stringify({ query: "divide", path: "src" }),
            },
          },
        ],
      }),
      assistantResponse({ role: "assistant", content: "Inspection complete." }),
      assistantResponse({
        role: "assistant",
        content: JSON.stringify(passResult("The inspected source is sound.")),
      }),
    ];
    const mockedFetch = fetchMock(async (input, init) => {
      requests.push({
        url: String(input),
        init,
        body:
          typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      const response = responses.shift();
      if (response === undefined) throw new Error("unexpected request");
      return response;
    });
    const prepared = setup(root, { fetch: mockedFetch });

    try {
      const events = await collect(prepared.adapter, prepared.input);

      expect(terminal(events)).toEqual({
        type: "result",
        result: passResult("The inspected source is sound."),
        isolation: "runtime_read_only",
      });
      expect(requests).toHaveLength(3);
      expect(requests[0]?.url).toBe(
        "https://gateway.example/v1/chat/completions",
      );
      expect(requests[0]?.init?.headers).toMatchObject({
        Authorization: "Bearer test-secret",
        "Content-Type": "application/json",
      });
      expect(requests[0]?.body.model).toBe("review-model");
      expect(requests[0]?.body.messages[0].content).toContain(
        "Never execute shell commands",
      );
      expect(requests[0]?.body.messages[0].content).toContain(
        "Never write, edit, create, delete, rename",
      );
      expect(
        requests[0]?.body.tools.map(
          (tool: { function: { name: string } }) => tool.function.name,
        ),
      ).toEqual(["list_files", "read_file", "search_text"]);
      expect(JSON.stringify(requests[0]?.body.tools)).not.toMatch(
        /shell|bash|command|execute|write|edit|git|web/i,
      );
      const toolMessages = requests[1]?.body.messages.filter(
        (message: { role: string }) => message.role === "tool",
      );
      expect(toolMessages).toHaveLength(3);
      expect(toolMessages[0]?.content).toContain("src/math.ts");
      expect(toolMessages[1]?.content).toContain("1: export const divide");
      expect(toolMessages[2]?.content).toContain('"line":1');
      expect(requests[2]?.body.response_format).toEqual({
        type: "json_schema",
        json_schema: {
          name: "reviewer_result",
          strict: true,
          schema: reviewerResultJsonSchema,
        },
      });
      expect(requests[2]?.body.tools).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("confines explicit and recursive reads across symlinks and excluded directories", async () => {
    const root = await mkdtemp(
      join(process.env.TEMP ?? "C:\\Temp", "mesh-oai-"),
    );
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    await mkdir(join(workspace, "src"), { recursive: true });
    await mkdir(join(workspace, ".git"));
    await mkdir(join(workspace, "node_modules", "pkg"), { recursive: true });
    await mkdir(outside);
    await writeFile(
      join(workspace, "src", "visible.ts"),
      "export const visible = true;\n",
    );
    await writeFile(join(workspace, ".git", "config"), "git-secret\n");
    await writeFile(
      join(workspace, "node_modules", "pkg", "index.js"),
      "dependency-secret\n",
    );
    await writeFile(join(outside, "secret.txt"), "outside-secret\n");
    await symlink(
      outside,
      join(workspace, "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const bodies: any[] = [];
    const responses = [
      assistantResponse({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "list-1",
            type: "function",
            function: { name: "list_files", arguments: "{}" },
          },
          {
            id: "outside-1",
            type: "function",
            function: {
              name: "read_file",
              arguments: JSON.stringify({ path: "escape/secret.txt" }),
            },
          },
          {
            id: "git-1",
            type: "function",
            function: {
              name: "read_file",
              arguments: JSON.stringify({ path: ".git/config" }),
            },
          },
        ],
      }),
      assistantResponse({ role: "assistant", content: "Done." }),
      assistantResponse({
        role: "assistant",
        content: JSON.stringify(passResult()),
      }),
    ];
    const prepared = setup(workspace, {
      fetch: fetchMock(async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return responses.shift()!;
      }),
    });

    try {
      const events = await collect(prepared.adapter, prepared.input);
      expect(terminal(events).type).toBe("result");
      const encoded = JSON.stringify(bodies[1]);
      expect(encoded).toContain("src/visible.ts");
      expect(encoded).not.toMatch(
        /git-secret|dependency-secret|outside-secret/,
      );
      const toolMessages = bodies[1].messages.filter(
        (message: { role: string }) => message.role === "tool",
      );
      expect(toolMessages[0].content).not.toMatch(
        /node_modules|\.git\/config|escape\/secret/,
      );
      expect(JSON.parse(toolMessages[1].content)).toHaveProperty("error");
      expect(JSON.parse(toolMessages[2].content)).toHaveProperty("error");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("cancels an active provider request", async () => {
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    const prepared = setup("C:\\workspace", {
      fetch: fetchMock(
        async (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            requestStarted();
            init?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("aborted", "AbortError")),
              { once: true },
            );
          }),
      ),
    });

    const completion = collect(prepared.adapter, prepared.input);
    await started;
    prepared.controller.abort();
    const event = terminal(await completion);

    expect(event).toMatchObject({
      type: "failure",
      failure: { reason: "cancelled", retryable: false },
      isolation: "runtime_read_only",
    });
  });

  it("bounds individual provider requests with a timeout", async () => {
    const prepared = setup("C:\\workspace", {
      requestTimeoutMs: 10,
      fetch: fetchMock(
        async (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("aborted", "AbortError")),
              { once: true },
            );
          }),
      ),
    });

    expect(
      terminal(await collect(prepared.adapter, prepared.input)),
    ).toMatchObject({
      type: "failure",
      failure: { reason: "timeout", retryable: true },
      isolation: "runtime_read_only",
    });
  });

  it("rejects provider output that violates the reviewer result schema", async () => {
    const responses = [
      assistantResponse({ role: "assistant", content: "Done." }),
      assistantResponse({
        role: "assistant",
        content: JSON.stringify({ ...passResult(), extra: true }),
      }),
    ];
    const prepared = setup("C:\\workspace", {
      fetch: fetchMock(async () => responses.shift()!),
    });

    expect(
      terminal(await collect(prepared.adapter, prepared.input)),
    ).toMatchObject({
      type: "failure",
      failure: { reason: "invalid_result", retryable: false },
      isolation: "runtime_read_only",
    });
  });

  it("classifies provider failures without publishing credentials or response bodies", async () => {
    const prepared = setup("C:\\workspace", {
      fetch: fetchMock(async () =>
        jsonResponse(
          { error: { message: "Authorization: Bearer test-secret" } },
          401,
        ),
      ),
    });

    const event = terminal(await collect(prepared.adapter, prepared.input));
    expect(event).toMatchObject({
      type: "failure",
      failure: { reason: "authentication_failed" },
      isolation: "runtime_read_only",
    });
    expect(JSON.stringify(event)).not.toContain("test-secret");
  });

  it("probes the models endpoint and reports exact model readiness", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const prepared = setup("C:\\workspace", {
      fetch: fetchMock(async (input, init) => {
        calls.push({ url: String(input), init });
        return jsonResponse({ data: [{ id: "review-model" }] });
      }),
    });

    await expect(
      prepared.adapter.probe(prepared.reviewer, prepared.controller.signal),
    ).resolves.toMatchObject({
      available: true,
      authenticated: true,
      model_available: true,
      cancellation: true,
      maximumIsolation: "runtime_read_only",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://gateway.example/v1/models");
    expect(calls[0]?.init?.method).toBe("GET");
  });

  it("fails closed without credentials or when enforced isolation is required", async () => {
    const noFetch = fetchMock(async () => {
      throw new Error("must not fetch");
    });
    const missing = createOpenAICompatibleAdapter(registration, {
      environment: {},
      fetch: noFetch,
    });
    const reviewer = resolvedReviewer({
      adapter: registration,
      isolationPolicy: "prefer_enforced",
    });
    await expect(
      missing.probe(reviewer, new AbortController().signal),
    ).resolves.toMatchObject({
      available: false,
      authenticated: false,
      maximumIsolation: "runtime_read_only",
    });

    const enforced = setup("C:\\workspace", { fetch: noFetch });
    enforced.reviewer.isolationPolicy = "require_enforced";
    await expect(
      enforced.adapter.probe(enforced.reviewer, enforced.controller.signal),
    ).resolves.toMatchObject({
      available: false,
      maximumIsolation: "runtime_read_only",
    });
    expect(noFetch).not.toHaveBeenCalled();
  });

  it("is registered as a first-class adapter", () => {
    const registry = new AdapterRegistry();
    expect(registry.create("gateway", registration).id).toBe(
      "openai_compatible",
    );
  });
});
