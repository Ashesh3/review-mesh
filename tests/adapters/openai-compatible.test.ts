import {
  lstat,
  mkdtemp,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  createOpenAICompatibleAdapter,
  type OpenAICompatibleAdapterDependencies,
  type FileSystemIdentityFacade,
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

const execFileAsync = promisify(execFile);

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

const nodeIdentity: FileSystemIdentityFacade = {
  lstat: (path) => lstat(path, { bigint: true }),
  realpath,
};

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
    prepared.input.reviewer.effort = "high";

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
        "X-Client-Session-Id": expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        ),
      });
      expect(
        new Set(
          requests.map((request) =>
            new Headers(request.init?.headers).get("x-client-session-id"),
          ),
        ),
      ).toEqual(
        new Set([
          new Headers(requests[0]?.init?.headers).get("x-client-session-id"),
        ]),
      );
      expect(requests[0]?.body.model).toBe("review-model");
      expect(
        requests.every((request) => request.body.reasoning_effort === "high"),
      ).toBe(true);
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
          strict: false,
          schema: reviewerResultJsonSchema,
        },
      });
      expect(requests[2]?.body.tools).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses one distinct routing-affinity session for each reviewer execution", async () => {
    const sessionIds = ["reviewer-session-a", "reviewer-session-b"];
    const requestSessionIds: string[] = [];
    const responses = [
      assistantResponse({ role: "assistant", content: "Inspection complete." }),
      assistantResponse({
        role: "assistant",
        content: JSON.stringify(passResult("First reviewer passed.")),
      }),
      assistantResponse({ role: "assistant", content: "Inspection complete." }),
      assistantResponse({
        role: "assistant",
        content: JSON.stringify(passResult("Second reviewer passed.")),
      }),
    ];
    const prepared = setup("C:\\workspace", {
      sessionIdFactory: () => sessionIds.shift()!,
      fetch: fetchMock(async (_input, init) => {
        requestSessionIds.push(
          new Headers(init?.headers).get("x-client-session-id") ?? "missing",
        );
        return responses.shift()!;
      }),
    });

    expect(
      terminal(await collect(prepared.adapter, prepared.input)),
    ).toMatchObject({ type: "result" });
    expect(
      terminal(await collect(prepared.adapter, prepared.input)),
    ).toMatchObject({ type: "result" });
    expect(requestSessionIds).toEqual([
      "reviewer-session-a",
      "reviewer-session-a",
      "reviewer-session-b",
      "reviewer-session-b",
    ]);
  });

  it("repairs one malformed final result without exposing provider content", async () => {
    const bodies: any[] = [];
    const responses = [
      assistantResponse({ role: "assistant", content: "Done." }),
      assistantResponse({
        role: "assistant",
        content: JSON.stringify({ verdict: "pass", secret: "provider-secret" }),
      }),
      assistantResponse({
        role: "assistant",
        content: JSON.stringify(passResult("Repaired result.")),
      }),
    ];
    const prepared = setup("C:\\workspace", {
      fetch: fetchMock(async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return responses.shift()!;
      }),
    });

    const event = terminal(await collect(prepared.adapter, prepared.input));
    expect(event).toEqual({
      type: "result",
      result: passResult("Repaired result."),
      isolation: "runtime_read_only",
    });
    expect(bodies).toHaveLength(3);
    expect(bodies[2].messages.at(-1).content).toContain(
      "previous final result was invalid",
    );
    expect(JSON.stringify(event)).not.toContain("provider-secret");
  });

  it("repairs a semantic schema mismatch using bounded structural diagnostics", async () => {
    const bodies: any[] = [];
    const secret = "provider-secret-must-not-propagate";
    const responses = [
      assistantResponse({ role: "assistant", content: "Done." }),
      assistantResponse({
        role: "assistant",
        content: JSON.stringify({
          ...passResult(secret),
          verdict: "fail",
          actionable_findings: [],
        }),
      }),
      assistantResponse({
        role: "assistant",
        content: JSON.stringify(passResult("Semantically repaired.")),
      }),
    ];
    const prepared = setup("C:\\workspace", {
      fetch: fetchMock(async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return responses.shift()!;
      }),
    });

    const event = terminal(await collect(prepared.adapter, prepared.input));
    expect(event).toEqual({
      type: "result",
      result: passResult("Semantically repaired."),
      isolation: "runtime_read_only",
    });
    const repairPrompt = bodies[2].messages.at(-1).content;
    expect(repairPrompt).toContain("Schema issues: $");
    expect(repairPrompt).toContain(
      "fail requires at least one actionable finding",
    );
    expect(repairPrompt).not.toContain(secret);
    expect(JSON.stringify(event)).not.toContain(secret);
  });

  it("accepts bounded arrays of text content for ordinary and final messages", async () => {
    const bodies: any[] = [];
    const result = JSON.stringify(passResult("Array result."));
    const responses = [
      assistantResponse({
        role: "assistant",
        content: [{ type: "text", text: "Inspection " }, { text: "complete." }],
      }),
      assistantResponse({
        role: "assistant",
        content: [
          { type: "text", text: result.slice(0, 20) },
          { text: result.slice(20) },
        ],
      }),
    ];
    const prepared = setup("C:\\workspace", {
      fetch: fetchMock(async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return responses.shift()!;
      }),
    });

    expect(terminal(await collect(prepared.adapter, prepared.input))).toEqual({
      type: "result",
      result: passResult("Array result."),
      isolation: "runtime_read_only",
    });
    expect(bodies[1].messages.at(-2)).toEqual({
      role: "assistant",
      content: "Inspection complete.",
    });
  });

  it("rejects non-text assistant content parts without exposing them", async () => {
    const prepared = setup("C:\\workspace", {
      fetch: fetchMock(async () =>
        assistantResponse({
          role: "assistant",
          content: [{ type: "image", text: "provider-secret" }],
        }),
      ),
    });

    const event = terminal(await collect(prepared.adapter, prepared.input));
    expect(event).toMatchObject({
      type: "failure",
      failure: { reason: "protocol_violation" },
    });
    expect(JSON.stringify(event)).not.toContain("provider-secret");
  });

  it("fails after exactly one bounded structured-result repair", async () => {
    const responses = [
      assistantResponse({ role: "assistant", content: "Done." }),
      assistantResponse({ role: "assistant", content: "not json" }),
      assistantResponse({ role: "assistant", content: "still not json" }),
    ];
    const mockedFetch = fetchMock(async () => responses.shift()!);
    const prepared = setup("C:\\workspace", { fetch: mockedFetch });

    expect(
      terminal(await collect(prepared.adapter, prepared.input)),
    ).toMatchObject({
      type: "failure",
      failure: { reason: "invalid_result", retryable: false },
      isolation: "runtime_read_only",
    });
    expect(mockedFetch).toHaveBeenCalledTimes(3);
  });

  it("rejects a file swapped to an external symlink before open", async () => {
    const root = await mkdtemp(
      join(process.env.TEMP ?? "C:\\Temp", "mesh-oai-swap-"),
    );
    const workspace = join(root, "workspace");
    const outside = join(root, "outside.txt");
    const target = join(workspace, "target.txt");
    await mkdir(workspace);
    await writeFile(target, "inside-visible\n");
    await writeFile(outside, "outside-secret\n");
    const canonicalTarget = await realpath(target);
    const bodies: any[] = [];
    let swapped = false;
    const responses = [
      assistantResponse({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "read-1",
            type: "function",
            function: {
              name: "read_file",
              arguments: JSON.stringify({ path: "target.txt" }),
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
    const prepared = setup(
      root,
      {
        fetch: fetchMock(async (_input, init) => {
          bodies.push(JSON.parse(String(init?.body)));
          return responses.shift()!;
        }),
        workspaceHooks: {
          async beforeFileOpen(path) {
            if (swapped || (await realpath(path)) !== canonicalTarget) return;
            swapped = true;
            await rm(target);
            await symlink(
              outside,
              target,
              process.platform === "win32" ? "file" : undefined,
            );
          },
        },
      },
      { context: resolvedContext({ workspace }) },
    );

    try {
      expect(
        terminal(await collect(prepared.adapter, prepared.input)).type,
      ).toBe("result");
      const toolMessage = bodies[1].messages.find(
        (message: { role: string }) => message.role === "tool",
      );
      expect(JSON.parse(toolMessage.content)).toMatchObject({
        error: "The requested file is unavailable.",
      });
      expect(JSON.stringify(bodies[1])).not.toContain("outside-secret");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "does not block when a candidate file is swapped to a FIFO before open",
    async () => {
      const root = await mkdtemp(join("/tmp", "mesh-oai-fifo-"));
      const target = join(root, "target.txt");
      await writeFile(target, "visible\n");
      const bodies: any[] = [];
      let swapped = false;
      const responses = [
        assistantResponse({
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "read-1",
              type: "function",
              function: {
                name: "read_file",
                arguments: JSON.stringify({ path: "target.txt" }),
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
      const prepared = setup(root, {
        workspaceHooks: {
          async beforeFileOpen(path) {
            if (
              swapped ||
              (await realpath(path)) !== (await realpath(target))
            ) {
              return;
            }
            swapped = true;
            await rm(target);
            await execFileAsync("mkfifo", [target], { timeout: 5_000 });
          },
        },
        fetch: fetchMock(async (_input, init) => {
          bodies.push(JSON.parse(String(init?.body)));
          return responses.shift()!;
        }),
      });

      try {
        const outcome = await Promise.race([
          collect(prepared.adapter, prepared.input),
          new Promise<never>((_resolve, reject) =>
            setTimeout(() => reject(new Error("FIFO open blocked")), 2_000),
          ),
        ]);
        expect(terminal(outcome).type).toBe("result");
        const tool = bodies[1].messages.find(
          (message: { role: string }) => message.role === "tool",
        );
        expect(JSON.parse(tool.content)).toHaveProperty("error");
      } finally {
        await prepared.adapter.forceCleanup?.();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "preserves a literal backslash in a POSIX filename",
    async () => {
      const root = await mkdtemp(join("/tmp", "mesh-oai-backslash-"));
      const filename = "literal\\name.txt";
      await writeFile(join(root, filename), "backslash-visible\n");
      const bodies: any[] = [];
      const responses = [
        assistantResponse({
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "read-1",
              type: "function",
              function: {
                name: "read_file",
                arguments: JSON.stringify({ path: filename }),
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
      const prepared = setup(root, {
        fetch: fetchMock(async (_input, init) => {
          bodies.push(JSON.parse(String(init?.body)));
          return responses.shift()!;
        }),
      });
      try {
        expect(
          terminal(await collect(prepared.adapter, prepared.input)).type,
        ).toBe("result");
        expect(
          bodies[1].messages.find(
            (message: { role: string }) => message.role === "tool",
          ).content,
        ).toContain("backslash-visible");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("caps descriptor reads when a validated file grows", async () => {
    const root = await mkdtemp(
      join(process.env.TEMP ?? "C:\\Temp", "mesh-oai-grow-"),
    );
    const workspace = join(root, "workspace");
    const target = join(workspace, "target.txt");
    await mkdir(workspace);
    await writeFile(target, "small\n");
    const bodies: any[] = [];
    let grown = false;
    const responses = [
      assistantResponse({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "read-1",
            type: "function",
            function: {
              name: "read_file",
              arguments: JSON.stringify({ path: "target.txt" }),
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
      workspaceHooks: {
        async afterFileValidation(path) {
          if (grown || (await realpath(path)) !== (await realpath(target)))
            return;
          grown = true;
          const handle = await open(target, "r+");
          try {
            await handle.truncate(512 * 1_024 + 1);
          } finally {
            await handle.close();
          }
        },
      },
    });

    try {
      expect(
        terminal(await collect(prepared.adapter, prepared.input)).type,
      ).toBe("result");
      const toolMessage = bodies[1].messages.find(
        (message: { role: string }) => message.role === "tool",
      );
      expect(JSON.parse(toolMessage.content)).toMatchObject({
        error: "The requested file is unavailable.",
      });
      expect(toolMessage.content.length).toBeLessThan(1_000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not retain bytes when a same-inode file changes between capture reads", async () => {
    const root = await mkdtemp(
      join(process.env.TEMP ?? "C:\\Temp", "mesh-oai-torn-read-"),
    );
    const target = join(root, "target.txt");
    await writeFile(target, "original-content\n");
    const bodies: any[] = [];
    let mutated = false;
    const responses = [
      assistantResponse({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "read-1",
            type: "function",
            function: {
              name: "read_file",
              arguments: JSON.stringify({ path: "target.txt" }),
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
    const prepared = setup(root, {
      workspaceHooks: {
        async betweenSnapshotReads(path) {
          if (mutated || (await realpath(path)) !== (await realpath(target)))
            return;
          mutated = true;
          await writeFile(target, "mutated-secret!\n");
        },
      },
      fetch: fetchMock(async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return responses.shift()!;
      }),
    });

    try {
      expect(
        terminal(await collect(prepared.adapter, prepared.input)).type,
      ).toBe("result");
      const tool = bodies[1].messages.find(
        (message: { role: string }) => message.role === "tool",
      );
      expect(JSON.parse(tool.content)).toHaveProperty("error");
      expect(JSON.stringify(bodies[1])).not.toMatch(
        /original-content|mutated-secret/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("normalizes ./ prefixes consistently for read_file", async () => {
    const root = await mkdtemp(
      join(process.env.TEMP ?? "C:\\Temp", "mesh-oai-dot-path-"),
    );
    await writeFile(join(root, "target.txt"), "visible\n");
    const bodies: any[] = [];
    const responses = [
      assistantResponse({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "read-1",
            type: "function",
            function: {
              name: "read_file",
              arguments: JSON.stringify({ path: "./target.txt" }),
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
    const prepared = setup(root, {
      fetch: fetchMock(async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return responses.shift()!;
      }),
    });

    try {
      expect(
        terminal(await collect(prepared.adapter, prepared.input)).type,
      ).toBe("result");
      const tool = bodies[1].messages.find(
        (message: { role: string }) => message.role === "tool",
      );
      expect(tool.content).toContain("1: visible");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reuses one immutable in-memory snapshot", async () => {
    const root = await mkdtemp(
      join(process.env.TEMP ?? "C:\\Temp", "mesh-oai-lifecycle-"),
    );
    const workspace = join(root, "workspace");
    const target = join(workspace, "target.txt");
    await mkdir(workspace);
    await writeFile(target, "snapshot-original\n");
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
        ],
      }),
      assistantResponse({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "read-1",
            type: "function",
            function: {
              name: "read_file",
              arguments: JSON.stringify({ path: "target.txt" }),
            },
          },
          {
            id: "search-1",
            type: "function",
            function: {
              name: "search_text",
              arguments: JSON.stringify({ query: "snapshot-original" }),
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
    let call = 0;
    const prepared = setup(workspace, {
      fetch: fetchMock(async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        call += 1;
        if (call === 2) await writeFile(target, "source-mutated\n");
        return responses.shift()!;
      }),
    });

    try {
      expect(
        terminal(await collect(prepared.adapter, prepared.input)).type,
      ).toBe("result");
      const childrenDuringReview = bodies[2].messages.filter(
        (message: { role: string }) => message.role === "tool",
      );
      expect(childrenDuringReview[1].content).toContain("snapshot-original");
      expect(childrenDuringReview[1].content).not.toContain("source-mutated");
      expect(childrenDuringReview[2].content).toContain('"line":1');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("enforces the aggregate snapshot byte budget before retaining content", async () => {
    const root = await mkdtemp(
      join(process.env.TEMP ?? "C:\\Temp", "mesh-oai-budget-"),
    );
    await writeFile(join(root, "a.txt"), "12345");
    await writeFile(join(root, "b.txt"), "67890");
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
        ],
      }),
      assistantResponse({ role: "assistant", content: "Done." }),
      assistantResponse({
        role: "assistant",
        content: JSON.stringify(passResult()),
      }),
    ];
    const prepared = setup(root, {
      maxSnapshotBytes: 6,
      fetch: fetchMock(async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return responses.shift()!;
      }),
    });

    try {
      expect(
        terminal(await collect(prepared.adapter, prepared.input)).type,
      ).toBe("result");
      const listing = JSON.parse(
        bodies[1].messages.find(
          (message: { role: string }) => message.role === "tool",
        ).content,
      );
      expect(listing.files).toHaveLength(1);
      expect(listing.truncated).toBe(true);
      expect(listing.files[0].size).toBe(5);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("bounds repeated large tool results and gracefully asks for a final result", async () => {
    const root = await mkdtemp(
      join(process.env.TEMP ?? "C:\\Temp", "mesh-oai-conversation-"),
    );
    const largeLine = `${"😀".repeat(2_000)}\n`;
    await writeFile(join(root, "large.txt"), largeLine.repeat(10));
    const requests: any[] = [];
    let call = 0;
    const prepared = setup(root, {
      maxToolResultBytes: 8 * 1_024,
      maxConversationBytes: 24 * 1_024,
      fetch: fetchMock(async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        requests.push(body);
        expect(Buffer.byteLength(String(init?.body), "utf8")).toBeLessThan(
          64 * 1_024,
        );
        call += 1;
        if (call <= 4) {
          return assistantResponse({
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: `read-${call}`,
                type: "function",
                function: {
                  name: "read_file",
                  arguments: JSON.stringify({ path: "large.txt" }),
                },
              },
            ],
          });
        }
        return assistantResponse({
          role: "assistant",
          content: JSON.stringify(passResult("Budgeted final result.")),
        });
      }),
    });

    try {
      expect(terminal(await collect(prepared.adapter, prepared.input))).toEqual(
        {
          type: "result",
          result: passResult("Budgeted final result."),
          isolation: "runtime_read_only",
        },
      );
      const toolMessages = requests.flatMap((request) =>
        request.messages.filter(
          (message: { role: string }) => message.role === "tool",
        ),
      );
      expect(
        toolMessages.every(
          (message: { content: string }) =>
            Buffer.byteLength(message.content, "utf8") <= 8 * 1_024,
        ),
      ).toBe(true);
      expect(JSON.stringify(requests.at(-1))).toContain(
        "bounded inspection context is full",
      );
      expect(JSON.stringify(requests.at(-1))).not.toContain("�");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not retain oversized assistant text before finalization", async () => {
    const requests: any[] = [];
    const oversized = "😀".repeat(40_000);
    const responses = [
      assistantResponse({ role: "assistant", content: oversized }),
      assistantResponse({
        role: "assistant",
        content: JSON.stringify(passResult("Finalized after large text.")),
      }),
    ];
    const prepared = setup("C:\\workspace", {
      maxConversationBytes: 24 * 1_024,
      fetch: fetchMock(async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)));
        expect(Buffer.byteLength(String(init?.body), "utf8")).toBeLessThan(
          64 * 1_024,
        );
        return responses.shift()!;
      }),
    });

    expect(terminal(await collect(prepared.adapter, prepared.input))).toEqual({
      type: "result",
      result: passResult("Finalized after large text."),
      isolation: "runtime_read_only",
    });
    expect(JSON.stringify(requests[1])).not.toContain(oversized);
    expect(JSON.stringify(requests[1])).toContain(
      "bounded inspection context is full",
    );
  });

  it("bounds oversized tool-call arguments and returns a safe paired tool error", async () => {
    const root = await mkdtemp(
      join(process.env.TEMP ?? "C:\\Temp", "mesh-oai-large-args-"),
    );
    await writeFile(join(root, "target.txt"), "visible\n");
    const requests: any[] = [];
    const oversizedArguments = JSON.stringify({
      path: "target.txt",
      padding: "x".repeat(80_000),
    });
    const responses = [
      assistantResponse({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "large-args",
            type: "function",
            function: { name: "read_file", arguments: oversizedArguments },
          },
        ],
      }),
      assistantResponse({
        role: "assistant",
        content: JSON.stringify(passResult("Finalized after large args.")),
      }),
    ];
    const prepared = setup(root, {
      maxConversationBytes: 48 * 1_024,
      fetch: fetchMock(async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)));
        expect(Buffer.byteLength(String(init?.body), "utf8")).toBeLessThan(
          64 * 1_024,
        );
        return responses.shift()!;
      }),
    });

    try {
      expect(terminal(await collect(prepared.adapter, prepared.input))).toEqual(
        {
          type: "result",
          result: passResult("Finalized after large args."),
          isolation: "runtime_read_only",
        },
      );
      const subsequent = requests[1];
      const assistant = subsequent.messages.find(
        (message: { role: string }) => message.role === "assistant",
      );
      const tool = subsequent.messages.find(
        (message: { role: string }) => message.role === "tool",
      );
      expect(
        Buffer.byteLength(assistant.tool_calls[0].function.arguments, "utf8"),
      ).toBeLessThanOrEqual(16 * 1_024);
      expect(tool.tool_call_id).toBe("large-args");
      expect(tool.content).toContain("arguments exceeded the safe input limit");
      expect(JSON.stringify(subsequent)).toContain(
        "bounded inspection context is full",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("bounds an oversized initial user prompt before the first provider call", async () => {
    const requests: Array<{ body: any; bytes: number }> = [];
    const oversizedPrompt = "😀".repeat(50_000);
    const prepared = setup(
      "C:\\workspace",
      {
        maxConversationBytes: 24 * 1_024,
        fetch: fetchMock(async (_input, init) => {
          requests.push({
            body: JSON.parse(String(init?.body)),
            bytes: Buffer.byteLength(String(init?.body), "utf8"),
          });
          return assistantResponse({
            role: "assistant",
            content: JSON.stringify(passResult("Bounded initial prompt.")),
          });
        }),
      },
      {
        prompt: {
          system: "Trusted system prompt.",
          user: oversizedPrompt,
          combined: `Trusted system prompt.\n\n${oversizedPrompt}`,
        },
      },
    );

    expect(terminal(await collect(prepared.adapter, prepared.input))).toEqual({
      type: "result",
      result: passResult("Bounded initial prompt."),
      isolation: "runtime_read_only",
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]!.bytes).toBeLessThan(24 * 1_024);
    expect(requests[0]!.body.messages[0].content).toContain(
      "# TRUSTED TOOL POLICY",
    );
    expect(requests[0]!.body.messages[1].content).toContain(
      "truncated the untrusted review prompt",
    );
    expect(requests[0]!.body.messages[1].content).not.toContain("�");
  });

  it("fails locally when the conversation budget cannot fit trusted policy", async () => {
    const noFetch = fetchMock(async () => {
      throw new Error("must not fetch");
    });
    const prepared = setup("C:\\workspace", {
      maxConversationBytes: 64,
      fetch: noFetch,
    });

    expect(
      terminal(await collect(prepared.adapter, prepared.input)),
    ).toMatchObject({
      type: "failure",
      failure: { reason: "read_failure", retryable: false },
      isolation: "runtime_read_only",
    });
    expect(noFetch).not.toHaveBeenCalled();
  });

  it("fails locally when maximum tool-call pairing cannot fit a tiny budget", async () => {
    const calls = Array.from({ length: 32 }, (_, index) => ({
      id: `id-${index}-${"x".repeat(1_000)}`,
      type: "function",
      function: {
        name: `read_file_${"y".repeat(1_000)}`,
        arguments: JSON.stringify({ path: "z".repeat(10_000) }),
      },
    }));
    let requests = 0;
    const prepared = setup("C:\\workspace", {
      maxConversationBytes: 1_024,
      fetch: fetchMock(async (_input, init) => {
        requests += 1;
        expect(Buffer.byteLength(String(init?.body), "utf8")).toBeLessThan(
          8 * 1_024 * 1_024,
        );
        return assistantResponse({
          role: "assistant",
          content: null,
          tool_calls: calls,
        });
      }),
    });

    const event = terminal(await collect(prepared.adapter, prepared.input));
    expect(event).toMatchObject({
      type: "failure",
      failure: { reason: "read_failure", retryable: false },
    });
    expect(requests).toBeLessThanOrEqual(1);
  });

  it("cancels an active request after building the in-memory snapshot", async () => {
    const root = await mkdtemp(
      join(process.env.TEMP ?? "C:\\Temp", "mesh-oai-cancel-snapshot-"),
    );
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "target.txt"), "visible\n");
    let requestCount = 0;
    let secondStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    const prepared = setup(workspace, {
      fetch: fetchMock(async (_input, init) => {
        requestCount += 1;
        if (requestCount === 1) {
          return assistantResponse({
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "list-1",
                type: "function",
                function: { name: "list_files", arguments: "{}" },
              },
            ],
          });
        }
        secondStarted();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      }),
    });

    try {
      const completion = collect(prepared.adapter, prepared.input);
      await started;
      prepared.controller.abort();
      expect(terminal(await completion)).toMatchObject({
        type: "failure",
        failure: { reason: "cancelled" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails visibly when the workspace root identity is unavailable", async () => {
    const root = await mkdtemp(
      join(process.env.TEMP ?? "C:\\Temp", "mesh-oai-zero-identity-"),
    );
    await writeFile(join(root, "target.txt"), "visible\n");
    const prepared = setup(root, {
      fileSystemIdentity: {
        realpath,
        async lstat(path) {
          const metadata = await lstat(path, { bigint: true });
          return Object.assign(metadata, { dev: 0n, ino: 0n });
        },
      },
      fetch: fetchMock(async () =>
        assistantResponse({
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "list-1",
              type: "function",
              function: { name: "list_files", arguments: "{}" },
            },
          ],
        }),
      ),
    });

    try {
      expect(
        terminal(await collect(prepared.adapter, prepared.input)),
      ).toMatchObject({
        type: "failure",
        failure: { reason: "read_failure", retryable: false },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails visibly when the workspace root has zero device but a nonzero inode", async () => {
    const root = await mkdtemp(
      join(process.env.TEMP ?? "C:\\Temp", "mesh-oai-zero-root-dev-"),
    );
    await writeFile(join(root, "target.txt"), "visible\n");
    const prepared = setup(root, {
      fileSystemIdentity: {
        realpath,
        async lstat(path) {
          const metadata = await lstat(path, { bigint: true });
          return Object.assign(metadata, { dev: 0n, ino: 17n });
        },
      },
      fetch: fetchMock(async () =>
        assistantResponse({
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "list-1",
              type: "function",
              function: { name: "list_files", arguments: "{}" },
            },
          ],
        }),
      ),
    });

    try {
      expect(
        terminal(await collect(prepared.adapter, prepared.input)),
      ).toMatchObject({
        type: "failure",
        failure: { reason: "read_failure", retryable: false },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails visibly when a workspace file identity is unavailable", async () => {
    const root = await mkdtemp(
      join(process.env.TEMP ?? "C:\\Temp", "mesh-oai-zero-file-identity-"),
    );
    const target = join(root, "target.txt");
    await writeFile(target, "visible\n");
    const prepared = setup(root, {
      fileSystemIdentity: {
        realpath,
        async lstat(path) {
          const metadata = await lstat(path, { bigint: true });
          if ((await realpath(path)) === (await realpath(target)))
            return Object.assign(metadata, { dev: 0n, ino: 0n });
          return metadata;
        },
      },
      fetch: fetchMock(async () =>
        assistantResponse({
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "list-1",
              type: "function",
              function: { name: "list_files", arguments: "{}" },
            },
          ],
        }),
      ),
    });

    try {
      expect(
        terminal(await collect(prepared.adapter, prepared.input)),
      ).toMatchObject({
        type: "failure",
        failure: { reason: "read_failure" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails visibly when a workspace file has zero device but a nonzero inode", async () => {
    const root = await mkdtemp(
      join(process.env.TEMP ?? "C:\\Temp", "mesh-oai-zero-file-dev-"),
    );
    const target = join(root, "target.txt");
    await writeFile(target, "visible\n");
    const prepared = setup(root, {
      fileSystemIdentity: {
        realpath,
        async lstat(path) {
          const metadata = await lstat(path, { bigint: true });
          if ((await realpath(path)) === (await realpath(target))) {
            return Object.assign(metadata, { dev: 0n, ino: 23n });
          }
          return metadata;
        },
      },
      fetch: fetchMock(async () =>
        assistantResponse({
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "list-1",
              type: "function",
              function: { name: "list_files", arguments: "{}" },
            },
          ],
        }),
      ),
    });

    try {
      expect(
        terminal(await collect(prepared.adapter, prepared.input)),
      ).toMatchObject({
        type: "failure",
        failure: { reason: "read_failure", retryable: false },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails when the workspace root path is swapped after identity pinning", async () => {
    const root = await mkdtemp(
      join(process.env.TEMP ?? "C:\\Temp", "mesh-oai-root-swap-"),
    );
    const workspace = join(root, "workspace");
    const replacement = join(root, "replacement");
    const original = join(root, "workspace-original");
    await mkdir(workspace);
    await mkdir(replacement);
    await writeFile(join(workspace, "inside.txt"), "inside-visible\n");
    await writeFile(join(replacement, "outside.txt"), "outside-secret\n");
    let rootChecks = 0;
    const prepared = setup(workspace, {
      fileSystemIdentity: {
        lstat: nodeIdentity.lstat,
        async realpath(path) {
          const canonical = await realpath(path);
          if (path === workspace) {
            rootChecks += 1;
            if (rootChecks === 2) {
              await rename(workspace, original);
              await rename(replacement, workspace);
              return realpath(workspace);
            }
          }
          return canonical;
        },
      },
      fetch: fetchMock(async () =>
        assistantResponse({
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "list-1",
              type: "function",
              function: { name: "list_files", arguments: "{}" },
            },
          ],
        }),
      ),
    });

    try {
      const event = terminal(await collect(prepared.adapter, prepared.input));
      expect(event).toMatchObject({
        type: "failure",
        failure: { reason: "read_failure" },
      });
      expect(JSON.stringify(event)).not.toContain("outside-secret");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("joins an in-flight in-memory snapshot build during forced cleanup", async () => {
    const root = await mkdtemp(
      join(process.env.TEMP ?? "C:\\Temp", "mesh-oai-force-cleanup-"),
    );
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "target.txt"), "visible\n");
    let releaseMarker!: () => void;
    const markerReleased = new Promise<void>((resolve) => {
      releaseMarker = resolve;
    });
    let buildPaused!: () => void;
    const paused = new Promise<void>((resolve) => {
      buildPaused = resolve;
    });
    const prepared = setup(workspace, {
      workspaceHooks: {
        async snapshotBuildPaused() {
          buildPaused();
          await markerReleased;
        },
      },
      fetch: fetchMock(async () =>
        assistantResponse({
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "list-1",
              type: "function",
              function: { name: "list_files", arguments: "{}" },
            },
          ],
        }),
      ),
    });

    try {
      const completion = collect(prepared.adapter, prepared.input);
      await paused;
      const cleanup = prepared.adapter.forceCleanup?.();
      releaseMarker();
      await cleanup;
      expect(terminal(await completion)).toMatchObject({
        type: "failure",
        failure: { reason: "cancelled" },
      });
    } finally {
      releaseMarker();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a directory swapped to an external junction before traversal", async () => {
    const root = await mkdtemp(
      join(process.env.TEMP ?? "C:\\Temp", "mesh-oai-dir-swap-"),
    );
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    const source = join(workspace, "src");
    await mkdir(source, { recursive: true });
    await mkdir(outside);
    await writeFile(join(source, "visible.ts"), "inside-visible\n");
    await writeFile(join(outside, "secret.txt"), "outside-secret\n");
    const bodies: any[] = [];
    let swapped = false;
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
            id: "search-1",
            type: "function",
            function: {
              name: "search_text",
              arguments: JSON.stringify({ query: "outside-secret" }),
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
      workspaceHooks: {
        async beforeDirectoryOpen(path) {
          if (swapped || path !== source) return;
          swapped = true;
          const moved = join(dirname(source), `${basename(source)}-moved`);
          await rename(source, moved);
          await symlink(
            outside,
            source,
            process.platform === "win32" ? "junction" : "dir",
          );
        },
      },
    });

    try {
      expect(
        terminal(await collect(prepared.adapter, prepared.input)).type,
      ).toBe("result");
      const tools = bodies[1].messages.filter(
        (message: { role: string }) => message.role === "tool",
      );
      expect(
        tools.map((message: { content: string }) => message.content).join("\n"),
      ).not.toContain("outside-secret");
      expect(tools).toHaveLength(2);
      expect(JSON.parse(tools[1].content).matches).toEqual([]);
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

  it("rejects provider output that violates the reviewer result schema twice", async () => {
    const responses = [
      assistantResponse({ role: "assistant", content: "Done." }),
      assistantResponse({
        role: "assistant",
        content: JSON.stringify({ ...passResult(), extra: true }),
      }),
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
