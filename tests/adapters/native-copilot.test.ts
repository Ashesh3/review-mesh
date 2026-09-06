import { afterEach, expect, it } from "vitest";
import {
  mkdtemp,
  readdir,
  rm,
  mkdir,
  writeFile,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createNativeCopilotAdapter } from "../../src/adapters/native-copilot.js";
import { resolvedReviewer, resolvedContext } from "../helpers/fixtures.js";
import type {
  CopilotClient,
  SessionConfig,
  CopilotClientOptions,
} from "@github/copilot-sdk";
import {
  CopilotClient as RealCopilotClient,
  RuntimeConnection,
} from "@github/copilot-sdk";
import { resolveSdkRuntime } from "../../src/runtime/sdk-runtime.js";
import { buildAllowlistedEnvironment } from "../../src/adapters/types.js";
import type {
  AdapterEvent,
  AdapterReviewInput,
} from "../../src/adapters/types.js";
import { nativeResultJsonSchema } from "../../src/protocol/native-review.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const fakeRuntime = () => ({
  executablePath: "fixture",
  pathEntries: [],
  sdkVersion: "sdk-fixture",
  runtimeVersion: "runtime-fixture",
  mode: "managed_process" as const,
});
const registration = {
  type: "copilot" as const,
  base_url_env: "URL",
  api_key_env: "KEY",
};
function reviewInput(
  workspace = "F:/fixture",
  signal = new AbortController().signal,
): AdapterReviewInput {
  const reviewer = resolvedReviewer({
    model: "kimi-k3",
    adapter: { type: "copilot" },
    timeoutMs: 10000,
  });
  return {
    runId: "test",
    reviewer,
    context: resolvedContext({
      workspace,
      review_scope: { mode: "full", source: "request" },
    }),
    prompt: {
      system: "Review only. Do not edit files.",
      user: "Inspect a.ts then submit_review.",
      combined: "Review",
    },
    resultJsonSchema: nativeResultJsonSchema(reviewer),
    isolationPolicy: "prefer_enforced",
    signal,
  };
}
async function collect(stream: AsyncIterable<AdapterEvent>) {
  const events: AdapterEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}
async function temporary() {
  const root = await mkdtemp(join(tmpdir(), "copilot-native-test-"));
  roots.push(root);
  return root;
}

it("reports missing runtime metadata as unavailable instead of escaping probe", async () => {
  const adapter = createNativeCopilotAdapter(registration, {
    runtime: () => {
      throw new Error("Missing packaged runtime");
    },
    environment: { URL: "http://127.0.0.1:1", KEY: "fixture" },
    applicationDataDirectory: await temporary(),
  });
  await expect(
    adapter.probe(reviewInput().reviewer, new AbortController().signal),
  ).resolves.toMatchObject({
    available: false,
    message: "Missing packaged runtime",
  });
});

it("does not use provider credentials inherited through an environment prototype", async () => {
  let clients = 0;
  const adapter = createNativeCopilotAdapter(registration, {
    runtime: fakeRuntime,
    environment: Object.create({ URL: "http://127.0.0.1:1", KEY: "inherited" }),
    applicationDataDirectory: await temporary(),
    createClient: () => {
      clients++;
      throw new Error("must not construct");
    },
  });
  const result = await adapter.probe(
    reviewInput().reviewer,
    new AbortController().signal,
  );
  expect(result).toMatchObject({
    available: false,
    message: "Configured SDK provider URL is missing.",
  });
  expect(clients).toBe(0);
});

it("rejects a configured API key without a provider URL instead of using a logged-in identity", async () => {
  let clients = 0;
  const adapter = createNativeCopilotAdapter(
    { type: "copilot", api_key_env: "KEY" },
    {
      runtime: fakeRuntime,
      environment: { KEY: "fixture" },
      applicationDataDirectory: await temporary(),
      createClient: () => {
        clients++;
        throw new Error("unexpected identity fallback");
      },
    },
  );
  const probe = await adapter.probe(
    reviewInput().reviewer,
    new AbortController().signal,
  );
  expect(probe).toMatchObject({
    available: false,
    message: "Configured SDK API key requires a provider URL.",
  });
  expect(clients).toBe(0);
});

it("uses product Copilot login storage with isolated client and session state", async () => {
  const root = await temporary();
  let options: CopilotClientOptions | undefined,
    sessionConfig: SessionConfig | undefined;
  const adapter = createNativeCopilotAdapter(
    { type: "copilot", use_logged_in_user: true },
    {
      runtime: fakeRuntime,
      environment: {},
      applicationDataDirectory: root,
      createClient: (input) => {
        options = input;
        return {
          async start() {},
          async stop() {
            return [];
          },
          async forceStop() {},
          async createSession(config: SessionConfig) {
            sessionConfig = config;
            return {
              on() {
                return () => {};
              },
              async sendAndWait() {},
              async disconnect() {},
              async abort() {},
            };
          },
        } as unknown as CopilotClient;
      },
    },
  );
  await collect(adapter.run(reviewInput()));
  expect(options?.baseDirectory).toBe(join(root, "runtime", "copilot"));
  expect(options?.useLoggedInUser).toBe(true);
  expect(sessionConfig?.configDirectory).toBe(options?.workingDirectory);
  expect(sessionConfig?.configDirectory).not.toBe(options?.baseDirectory);
  await expect(readdir(options!.baseDirectory!)).resolves.toBeDefined();
  await expect(readdir(options!.workingDirectory!)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("starts simultaneous packaged clients sharing the product login home", async () => {
  const root = await temporary(),
    baseDirectory = join(root, "auth");
  await mkdir(baseDirectory);
  const clients: RealCopilotClient[] = [];
  try {
    for (let index = 0; index < 2; index++) {
      const workingDirectory = join(root, `work-${index}`);
      await mkdir(workingDirectory);
      clients.push(
        new RealCopilotClient({
          mode: "empty",
          connection: RuntimeConnection.forStdio({
            path: resolveSdkRuntime("copilot").executablePath,
          }),
          baseDirectory,
          workingDirectory,
          env: buildAllowlistedEnvironment([], process.env),
          useLoggedInUser: false,
          logLevel: "error",
        }),
      );
    }
    const statuses = await Promise.all(
      clients.map(async (client) => {
        await client.start();
        return client.getAuthStatus();
      }),
    );
    expect(statuses).toEqual([
      expect.objectContaining({ isAuthenticated: false }),
      expect.objectContaining({ isAuthenticated: false }),
    ]);
  } finally {
    await Promise.all(
      clients.map(async (client) => {
        const errors = await client.stop();
        if (errors.length) await client.forceStop();
      }),
    );
  }
}, 15000);

it("gives concurrent clients separate state directories and removes them on close", async () => {
  const directories: string[] = [];
  const adapter = createNativeCopilotAdapter(registration, {
    runtime: fakeRuntime,
    environment: { URL: "http://127.0.0.1:1", KEY: "fixture" },
    applicationDataDirectory: await temporary(),
    createClient: (options) => {
      directories.push(options.baseDirectory!);
      return {
        async start() {},
        async stop() {
          return [];
        },
        async forceStop() {},
      } as unknown as CopilotClient;
    },
  });
  const results = await Promise.all([
    adapter.probe(reviewInput().reviewer, new AbortController().signal),
    adapter.probe(reviewInput().reviewer, new AbortController().signal),
  ]);
  expect(results.every((result) => result.available)).toBe(true);
  expect(
    results.every(
      (result) =>
        result.sdk_version === "sdk-fixture" &&
        result.runtime_version === "runtime-fixture",
    ),
  ).toBe(true);
  expect(new Set(directories).size).toBe(2);
  for (const directory of directories)
    await expect(readdir(directory)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["create", "start", "session", "model"] as const)(
  "cancels during %s without restarting or waiting for a hung SDK promise",
  async (stage) => {
    const controller = new AbortController();
    let starts = 0,
      sessions = 0,
      sends = 0,
      stops = 0;
    const never = () => new Promise<never>(() => {});
    const adapter = createNativeCopilotAdapter(registration, {
      runtime: fakeRuntime,
      environment: { URL: "http://127.0.0.1:1", KEY: "fixture" },
      applicationDataDirectory: await temporary(),
      createClient: () => {
        if (stage === "create") controller.abort();
        return {
          async start() {
            starts++;
            if (stage === "start") {
              controller.abort();
              await never();
            }
          },
          async stop() {
            stops++;
            return [];
          },
          async forceStop() {},
          async createSession() {
            sessions++;
            if (stage === "session") {
              controller.abort();
              await never();
            }
            return {
              on() {
                return () => {};
              },
              async abort() {},
              async disconnect() {},
              async sendAndWait() {
                sends++;
                controller.abort();
                await never();
              },
            };
          },
        } as unknown as CopilotClient;
      },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const events = await Promise.race([
        collect(adapter.run(reviewInput("F:/fixture", controller.signal))),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Cancellation did not settle")),
            500,
          );
        }),
      ]);
      expect(events.at(-1)).toMatchObject({
        type: "failure",
        failure: { reason: "cancelled" },
      });
      expect(stops).toBe(1);
      expect(starts).toBe(stage === "create" ? 0 : 1);
      expect(sessions).toBe(["create", "start"].includes(stage) ? 0 : 1);
      expect(sends).toBe(stage === "model" ? 1 : 0);
    } finally {
      if (timer) clearTimeout(timer);
      await adapter.forceCleanup?.();
    }
  },
);

it.each(["create", "start", "auth", "models"] as const)(
  "cancels a probe during %s and handles rejected force-stop promises",
  async (stage) => {
    const controller = new AbortController();
    let starts = 0,
      stops = 0;
    const never = () => new Promise<never>(() => {});
    const adapter = createNativeCopilotAdapter(
      { type: "copilot", use_logged_in_user: false },
      {
        runtime: fakeRuntime,
        environment: {},
        applicationDataDirectory: await temporary(),
        createClient: () => {
          if (stage === "create") controller.abort();
          return {
            async start() {
              starts++;
              if (stage === "start") {
                controller.abort();
                await never();
              }
            },
            async getAuthStatus() {
              if (stage === "auth") {
                controller.abort();
                await never();
              }
              return { isAuthenticated: true };
            },
            async listModels() {
              controller.abort();
              await never();
            },
            async stop() {
              stops++;
              return [];
            },
            async forceStop() {
              throw new Error("already stopped");
            },
          } as unknown as CopilotClient;
        },
      },
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([
        adapter.probe(reviewInput().reviewer, controller.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Probe cancellation did not settle")),
            500,
          );
        }),
      ]);
      expect(value.available).toBe(false);
      expect(stops).toBe(1);
      expect(starts).toBe(stage === "create" ? 0 : 1);
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      if (timer) clearTimeout(timer);
      await adapter.forceCleanup?.();
    }
  },
);

it("does not restart a reviewer after a terminal SDK request failure", async () => {
  let starts = 0,
    sends = 0;
  const adapter = createNativeCopilotAdapter(registration, {
    runtime: fakeRuntime,
    environment: { URL: "http://127.0.0.1:1", KEY: "fixture" },
    applicationDataDirectory: await temporary(),
    createClient: () =>
      ({
        async start() {
          starts++;
        },
        async stop() {
          return [];
        },
        async forceStop() {},
        async createSession() {
          return {
            on() {
              return () => {};
            },
            async abort() {},
            async disconnect() {},
            async sendAndWait() {
              sends++;
              throw new Error("rate limited");
            },
          };
        },
      }) as unknown as CopilotClient,
  });
  const events = await collect(adapter.run(reviewInput()));
  expect(events.at(-1)).toMatchObject({
    type: "failure",
    failure: { reason: "process_crashed" },
  });
  expect(starts).toBe(1);
  expect(sends).toBe(1);
});

it("aborts a packaged Copilot request and releases the runtime state directory", async () => {
  const root = await temporary(),
    workspace = join(root, "workspace");
  await mkdir(workspace);
  const controller = new AbortController();
  let requests = 0;
  const server = createServer((request) => {
    request.resume();
    request.on("end", () => {
      requests++;
      controller.abort(new Error("cancel pending provider"));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const adapter = createNativeCopilotAdapter(registration, {
    applicationDataDirectory: join(root, "application"),
    environment: {
      ...process.env,
      URL: `http://127.0.0.1:${port}/v1`,
      KEY: "PUBLIC_LOOPBACK_FIXTURE",
    },
  });
  const guard = setTimeout(
    () => controller.abort(new Error("fixture timeout")),
    15000,
  );
  try {
    const events = await collect(
      adapter.run(reviewInput(workspace, controller.signal)),
    );
    expect(events.at(-1)).toMatchObject({
      type: "failure",
      failure: { reason: "cancelled" },
    });
    expect(requests).toBe(1);
    expect(
      await readdir(join(root, "application", "runtime", "copilot-native")),
    ).toEqual([]);
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    clearTimeout(guard);
    await adapter.forceCleanup?.();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 20000);

it("runs packaged Copilot file inspection and terminal submission against a loopback provider", async () => {
  const root = await temporary(),
    workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "a.ts"), "NATIVE_FILE_EVIDENCE");
  const requests: Array<{
    path: string;
    auth: string | undefined;
    body: Record<string, any>;
  }> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      requests.push({
        path: request.url ?? "",
        auth: request.headers.authorization,
        body,
      });
      const name = requests.length === 1 ? "view" : "submit_review";
      const args =
        name === "view"
          ? { path: join(workspace, "a.ts") }
          : {
              schema_version: "4",
              verdict: "pass",
              review_markdown: "Full loopback native report",
              summary: "Clear",
              actionable_findings: [],
              informational_notes: [],
              native_scope_attestation: {
                complete: true,
                reviewed_paths: ["a.ts"],
                limitations: [],
              },
            };
      const completion = {
        id: `fixture-${requests.length}`,
        object: "chat.completion",
        created: 1,
        model: "kimi-k3",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: `call-${requests.length}`,
                  type: "function",
                  function: { name, arguments: JSON.stringify(args) },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
      if (body.stream) {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write(
          `data: ${JSON.stringify({ id: completion.id, object: "chat.completion.chunk", created: 1, model: "kimi-k3", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, ...completion.choices[0]!.message.tool_calls[0] }] }, finish_reason: null }] })}\n\n`,
        );
        response.end(
          `data: ${JSON.stringify({ id: completion.id, object: "chat.completion.chunk", created: 1, model: "kimi-k3", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: completion.usage })}\n\ndata: [DONE]\n\n`,
        );
      } else {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(completion));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const adapter = createNativeCopilotAdapter(registration, {
    applicationDataDirectory: join(root, "application"),
    environment: {
      ...process.env,
      URL: `http://127.0.0.1:${port}/v1`,
      KEY: "PUBLIC_LOOPBACK_FIXTURE",
    },
  });
  const input = reviewInput(workspace, AbortSignal.timeout(20000));
  try {
    const probe = await adapter.probe(input.reviewer, input.signal);
    expect(probe).toMatchObject({ available: true, authenticated: true });
    const events = await collect(adapter.run(input));
    expect(
      events.at(-1),
      JSON.stringify(
        requests.map((r) => ({
          path: r.path,
          keys: Object.keys(r.body),
          tools: r.body.tools?.map((t: any) => t.function?.name),
        })),
      ),
    ).toMatchObject({
      type: "result",
      result: { review_markdown: "Full loopback native report" },
    });
    expect(requests).toHaveLength(2);
    expect(
      requests.every((r) => r.auth === "Bearer PUBLIC_LOOPBACK_FIXTURE"),
    ).toBe(true);
    const tools = requests[0]!.body.tools.map(
      (tool: any) => tool.function.name,
    );
    expect(tools).toEqual(
      expect.arrayContaining(["view", "grep", "glob", "submit_review"]),
    );
    for (const forbidden of ["bash", "powershell", "edit", "create"])
      expect(tools).not.toContain(forbidden);
    expect(JSON.stringify(requests[1]!.body.messages)).toContain(
      "NATIVE_FILE_EVIDENCE",
    );
    expect(await readFile(join(workspace, "a.ts"), "utf8")).toBe(
      "NATIVE_FILE_EVIDENCE",
    );
    expect(
      await readdir(join(root, "application", "runtime", "copilot-native")),
    ).toEqual([]);
  } finally {
    await adapter.forceCleanup?.();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 30000);

it("lets the Copilot runtime drive submission and preserves all structured findings", async () => {
  let sends = 0;
  let options: CopilotClientOptions | undefined;
  const result = {
    schema_version: "4",
    verdict: "pass",
    review_markdown: "Full native report",
    summary: "Clear",
    actionable_findings: [],
    informational_notes: [],
    native_scope_attestation: {
      complete: true,
      reviewed_paths: ["a.ts"],
      limitations: [],
    },
  };
  const adapter = createNativeCopilotAdapter(
    { type: "copilot", base_url_env: "URL", api_key_env: "KEY" },
    {
      environment: { URL: "http://127.0.0.1:1/v1", KEY: "test-only" },
      applicationDataDirectory: await temporary(),
      runtime: () => ({
        executablePath: "fixture",
        pathEntries: [],
        sdkVersion: "fixture",
        runtimeVersion: "fixture",
        mode: "managed_process",
      }),
      createClient: (opts) => {
        options = opts;
        return {
          async start() {},
          async stop() {
            return [];
          },
          async forceStop() {},
          async createSession(config: SessionConfig) {
            expect(config.availableTools).toContain("custom:submit_review");
            expect(config.availableTools).toContain("builtin:view");
            expect(config.provider).toMatchObject({
              baseUrl: "http://127.0.0.1:1/v1",
              apiKey: "test-only",
            });
            const submit = config.tools!.find(
              (t) => t.name === "submit_review",
            )!;
            expect(submit.isTerminal).toBe(true);
            return {
              async sendAndWait() {
                sends++;
                await submit.handler!(result, {} as never);
                return undefined;
              },
              on() {
                return () => {};
              },
              async abort() {},
              async disconnect() {},
            };
          },
        } as unknown as CopilotClient;
      },
    },
  );
  const events = [];
  for await (const event of adapter.run({
    runId: "run-test",
    reviewer: resolvedReviewer({
      model: "kimi-k3",
      adapter: { type: "copilot" },
    }),
    context: resolvedContext(),
    prompt: { system: "Review", user: "Input", combined: "Review Input" },
    resultJsonSchema: { type: "object" },
    isolationPolicy: "prefer_enforced",
    signal: new AbortController().signal,
  }))
    events.push(event);
  expect(sends).toBe(1);
  expect(options?.connection).toMatchObject({ kind: "stdio" });
  expect(events.at(-1)).toMatchObject({
    type: "result",
    result: { review_markdown: "Full native report" },
  });
});
