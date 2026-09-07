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
import {
  resolvedReviewer,
  resolvedContext,
  failResult,
} from "../helpers/fixtures.js";
import type {
  CopilotClient,
  SessionConfig,
  CopilotClientOptions,
  SessionEvent,
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
import { providerReviewerResultV4Schema } from "../../src/protocol/v9.js";
import { sanitizeRunMetadata } from "../../src/results/sanitize.js";

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
  let contextFile: string | undefined;
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
            const file = (await readdir(config.configDirectory!)).find((name) =>
              /^native-context-[a-f0-9]{64}\.json$/.test(name),
            );
            expect(file).toBeDefined();
            contextFile = join(config.configDirectory!, file!);
            expect(config.systemMessage).toMatchObject({
              content: expect.stringContaining("After compaction"),
            });
            expect(
              JSON.parse(await readFile(contextFile, "utf8")).context.workspace,
            ).toBe("F:/fixture");
            const listeners = new Set<(event: SessionEvent) => void>();
            return {
              on(handler: (event: SessionEvent) => void) {
                listeners.add(handler);
                return () => listeners.delete(handler);
              },
              async send() {
                for (const listener of listeners)
                  listener({ type: "session.idle", data: {} } as SessionEvent);
                return "message";
              },
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
  expect(contextFile).toBeDefined();
  await expect(readFile(contextFile!)).rejects.toMatchObject({
    code: "ENOENT",
  });
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
              async send() {
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
            async send() {
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

it.each(["session.error", "sendAndWait", "createSession"] as const)(
  "preserves redacted Copilot %s diagnostics without storing arbitrary SDK data",
  async (operation) => {
    const secret = "fixture-private-provider-credential";
    const providerMessage =
      `Invalid schema for submit_review: array items must be an object. ${secret} ` +
      "https://provider.invalid/v1?api_key=private-query Bearer hidden-bearer " +
      'upstream {"password":"quoted-private-password","api_key":"quoted-private-key"}';
    const listeners = new Set<(event: SessionEvent) => void>();
    const recorded: unknown[] = [];
    const adapter = createNativeCopilotAdapter(registration, {
      runtime: fakeRuntime,
      environment: { URL: "https://provider.invalid/v1", KEY: secret },
      applicationDataDirectory: await temporary(),
      createClient: () =>
        ({
          async start() {},
          async stop() {
            return [];
          },
          async forceStop() {},
          async createSession() {
            if (operation === "createSession")
              throw new TypeError(providerMessage);
            return {
              on(handler: (event: SessionEvent) => void) {
                listeners.add(handler);
                return () => listeners.delete(handler);
              },
              async abort() {},
              async disconnect() {},
              async send() {
                if (operation === "session.error")
                  for (const listener of listeners)
                    listener({
                      type: "session.error",
                      data: {
                        errorType: "query",
                        errorCode: "invalid_function_parameters",
                        message: providerMessage,
                        statusCode: 400,
                        providerCallId: "public-request-123",
                        stack: "do not persist full private stack",
                        url: "https://private.invalid/secret",
                      },
                    } as SessionEvent);
                throw new TypeError(providerMessage);
              },
            };
          },
        }) as unknown as CopilotClient,
    });
    const input = reviewInput();
    input.recordDiagnostic = async (diagnostic) => {
      recorded.push(diagnostic);
    };
    const events = await collect(adapter.run(input));
    expect(events.at(-1)).toMatchObject({
      type: "failure",
      failure: {
        reason: "process_crashed",
        message: expect.stringContaining("Invalid schema for submit_review"),
        diagnostics: {
          failure_stage: "native_copilot",
          last_operation: operation,
          ...(operation === "session.error"
            ? {
                provider_error_code: "invalid_function_parameters",
                http_status: 400,
                provider_request_id: "public-request-123",
              }
            : { exception_name: "TypeError" }),
        },
      },
    });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      kind: "adapter_exception",
      diagnostics: { last_operation: operation },
    });
    const serialized = JSON.stringify({ events, recorded });
    for (const privateText of [
      secret,
      "private-query",
      "hidden-bearer",
      "private stack",
      "private.invalid",
      "provider.invalid",
      "quoted-private-password",
      "quoted-private-key",
    ])
      expect(serialized).not.toContain(privateText);
  },
);

it("returns repairable typed failures with schema paths without raw arguments", async () => {
  let sessions = 0;
  const prompts: string[] = [];
  const results: unknown[] = [];
  const adapter = createNativeCopilotAdapter(registration, {
    runtime: fakeRuntime,
    environment: {
      URL: "https://provider.invalid/v1",
      KEY: "private-credential",
    },
    applicationDataDirectory: await temporary(),
    createClient: () =>
      ({
        async start() {},
        async stop() {
          return [];
        },
        async forceStop() {},
        async createSession(config: SessionConfig) {
          sessions++;
          const submit = config.tools!.find(
            (tool) => tool.name === "submit_review",
          )!;
          const listeners = new Set<(event: SessionEvent) => void>();
          return {
            on(handler: (event: SessionEvent) => void) {
              listeners.add(handler);
              return () => listeners.delete(handler);
            },
            async abort() {},
            async disconnect() {},
            async send(message: { prompt: string }) {
              prompts.push(message.prompt);
              results.push(
                await submit.handler!(
                  {
                    schema_version: "4",
                    verdict: "pass",
                    review_markdown: "Report",
                    summary: "Clear",
                    actionable_findings: [],
                    informational_notes: [],
                    native_scope_attestation: {
                      complete: "private-invalid-field-value",
                      reviewed_paths: ["a.ts"],
                      limitations: [],
                    },
                  },
                  {} as never,
                ),
              );
              for (const listener of listeners)
                listener({ type: "session.idle", data: {} } as SessionEvent);
              return "message";
            },
          };
        },
      }) as unknown as CopilotClient,
  });
  const events = await collect(adapter.run(reviewInput()));
  expect(sessions).toBe(1);
  expect(prompts).toHaveLength(1);
  expect(results[0]).toMatchObject({
    resultType: "failure",
    textResultForLlm: expect.stringContaining(
      "native_scope_attestation.complete",
    ),
  });
  expect(JSON.stringify(results[0])).toContain("invalid_type");
  expect(JSON.stringify(results[0])).toContain("boolean");
  expect(events.at(-1)).toMatchObject({
    type: "failure",
    failure: {
      reason: "invalid_result",
      message: expect.stringContaining("native_scope_attestation.complete"),
    },
  });
  expect(JSON.stringify({ events, prompts, results })).not.toContain(
    "private-invalid-field-value",
  );
});

it.each(["small", "large", "many"] as const)(
  "retains %s rejected findings and never turns an incomplete finding report into a clean repair",
  async (size) => {
    const drafts: unknown[] = [];
    let sends = 0;
    const original = {
      ...failResult("retained-finding"),
      review_markdown:
        "Retained narrative contains private-credential and encoded%2Fcredential." +
        (size === "large" ? "Unicode preservation: é漢🙂\n".repeat(16000) : ""),
      actionable_findings: (size === "many"
        ? Array.from(
            { length: 257 },
            (_, index) =>
              failResult(`retained-${index}`).actionable_findings[0]!,
          )
        : failResult("retained-finding").actionable_findings
      ).map((finding) => ({
        ...finding,
        claim: {
          trigger: "Trigger",
          affected_behavior: "Wrong behavior",
          outcome: "Failure",
        },
      })),
      schema_version: "4",
      native_scope_attestation: {
        complete: true,
        reviewed_paths: ["a.ts"],
        limitations: [],
      },
    };
    expect(providerReviewerResultV4Schema.safeParse(original)).toMatchObject({
      success: true,
    });
    const adapter = createNativeCopilotAdapter(
      { ...registration, env_allowlist: ["AUX"] },
      {
        runtime: fakeRuntime,
        environment: {
          URL: "http://127.0.0.1:1",
          KEY: "private-credential",
          AUX: "encoded/credential",
        },
        applicationDataDirectory: await temporary(),
        createClient: () =>
          ({
            async start() {},
            async stop() {
              return [];
            },
            async forceStop() {},
            async createSession(config: SessionConfig) {
              const submit = config.tools!.find(
                (tool) => tool.name === "submit_review",
              )!;
              const listeners = new Set<(event: SessionEvent) => void>();
              return {
                on(handler: (event: SessionEvent) => void) {
                  listeners.add(handler);
                  return () => listeners.delete(handler);
                },
                async abort() {},
                async disconnect() {},
                async send() {
                  sends++;
                  await submit.handler!(original, {} as never);
                  await submit.handler!(
                    {
                      ...original,
                      verdict: "pass",
                      actionable_findings: [],
                      native_scope_attestation: {
                        complete: true,
                        reviewed_paths: ["a.ts", "b.ts"],
                        limitations: [],
                      },
                    },
                    {} as never,
                  );
                  for (const listener of listeners)
                    listener({
                      type: "session.idle",
                      data: {},
                    } as SessionEvent);
                  return "message";
                },
              };
            },
          }) as unknown as CopilotClient,
      },
    );
    const input = reviewInput();
    input.context.review_scope = { mode: "changes", source: "request" };
    input.context.git = {
      is_repository: true,
      root: input.context.workspace,
      branch: "fixture",
      head: "head",
      merge_base: "base",
      status_entries: [],
      changed_files: ["a.ts", "b.ts"],
      diff_stat: "",
      diff: "",
      truncated: {
        status_entries: false,
        changed_files: false,
        diff_stat: false,
        diff: false,
      },
    };
    input.recordDiagnostic = async (draft) => {
      drafts.push(draft);
    };
    const events = await collect(adapter.run(input));
    expect(events.at(-1)).toMatchObject({
      type: "failure",
      failure: { reason: "invalid_result" },
    });
    expect(events.some((event) => event.type === "result")).toBe(false);
    expect(sends).toBe(1);
    if (size === "small")
      expect(drafts).toContainEqual(
        expect.objectContaining({
          kind: "unverified_result_draft",
          candidate_ids: ["retained-finding"],
          candidate: expect.objectContaining({
            actionable_findings: original.actionable_findings,
          }),
        }),
      );
    if (size !== "small") {
      const fragments = (
        drafts as Array<{ candidate?: Record<string, any> }>
      ).filter(
        (draft) =>
          draft.candidate?.kind === "native_rejected_submission_fragment" &&
          draft.candidate.report_id === "native-copilot-submission-1",
      );
      expect(fragments.length).toBeGreaterThan(0);
      const raw = fragments
        .map(
          (draft) =>
            (sanitizeRunMetadata(draft) as typeof draft).candidate!
              .report_fragment,
        )
        .join("");
      const restored = JSON.parse(raw);
      expect(restored).toEqual({
        ...original,
        review_markdown: original.review_markdown
          .replaceAll("private-credential", "[redacted]")
          .replaceAll("encoded%2Fcredential", "[redacted]"),
      });
      for (const fragment of fragments)
        expect(
          Buffer.byteLength(JSON.stringify(fragment), "utf8"),
        ).toBeLessThan(256 * 1024);
    }
    expect(JSON.stringify(drafts)).not.toContain("private-credential");
    expect(JSON.stringify(drafts)).not.toContain("encoded%2Fcredential");
    for (const draft of drafts as Array<{ candidate_ids: string[] }>)
      expect(draft.candidate_ids.length).toBeLessThanOrEqual(256);
  },
);

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

it("prevents proof repair from silently rejecting a claim but accepts an explicit unresolved adjustment", async () => {
  const workspace = await temporary();
  await writeFile(join(workspace, "a.ts"), "return oldValue;");
  const source = {
    ...failResult("candidate").actionable_findings[0]!,
    evidence: [{ path: "a.ts", start_line: 1, end_line: 1, detail: "Return" }],
    claim: {
      trigger: "Change",
      affected_behavior: "Old return",
      outcome: "Stale value",
    },
  };
  const reply = {
    schema_version: "2",
    kind: "review-mesh.adjudication-result",
    verdict: "fail",
    review_markdown: "Original claim",
    summary: "Claim",
    actionable_findings: [],
    informational_notes: [],
    decisions: [
      {
        source_finding_id: "candidate",
        decision: "confirmed",
        rationale: "Checked source",
        cited_evidence: [
          {
            path: "a.ts",
            start_line: 99,
            end_line: 99,
            detail: "Invalid line",
          },
        ],
        unverified_assumptions: [],
      },
    ],
  };
  const outcomes: unknown[] = [];
  const adapter = createNativeCopilotAdapter(registration, {
    runtime: fakeRuntime,
    environment: { URL: "http://127.0.0.1:1", KEY: "fixture" },
    applicationDataDirectory: await temporary(),
    createClient: () =>
      ({
        async start() {},
        async stop() {
          return [];
        },
        async forceStop() {},
        async createSession(config: SessionConfig) {
          const listeners = new Set<(event: SessionEvent) => void>();
          const submit = config.tools![0]!;
          return {
            on(handler: (event: SessionEvent) => void) {
              listeners.add(handler);
              return () => listeners.delete(handler);
            },
            async abort() {},
            async disconnect() {},
            async send() {
              outcomes.push(await submit.handler!(reply, {} as never));
              outcomes.push(
                await submit.handler!(
                  {
                    ...reply,
                    verdict: "pass",
                    decisions: [
                      {
                        ...reply.decisions[0],
                        decision: "rejected",
                        cited_evidence: [],
                      },
                    ],
                  },
                  {} as never,
                ),
              );
              const { id: _id, ...adjusted } = source;
              outcomes.push(
                await submit.handler!(
                  {
                    ...reply,
                    decisions: [
                      {
                        ...reply.decisions[0],
                        decision: "adjusted",
                        adjusted_finding: {
                          ...adjusted,
                          classification: "needs_verification",
                          external_assumptions: ["Proof cannot be established"],
                        },
                        unverified_assumptions: ["Proof cannot be established"],
                      },
                    ],
                  },
                  {} as never,
                ),
              );
              for (const listener of listeners)
                listener({ type: "session.idle", data: {} } as SessionEvent);
              return "message";
            },
          };
        },
      }) as unknown as CopilotClient,
  });
  const input = reviewInput(workspace);
  input.reviewer.policy = {
    mode: "adjudication",
    candidateFindings: [source] as never,
    passQuorum: 1,
    minimumProviderGroups: 1,
    adjudication: "required",
    gateMinimumSeverity: "medium",
    gateMinimumConfidence: "medium",
  };
  const events = await collect(adapter.run(input));
  expect(outcomes[0]).toMatchObject({ resultType: "failure" });
  expect(outcomes[1]).toMatchObject({
    resultType: "failure",
    textResultForLlm: expect.stringContaining("claim"),
  });
  expect(outcomes[2]).toMatchObject({ resultType: "success" });
  expect(events.at(-1)).toMatchObject({
    type: "result",
    result: {
      decisions: [
        {
          decision: "adjusted",
          adjusted_finding: { classification: "needs_verification" },
        },
      ],
    },
  });
});

it.each([
  "review",
  "adjudication",
  "scope-correction",
  "proof-correction",
] as const)(
  "runs packaged Copilot %s file inspection and terminal submission against a loopback provider",
  async (mode) => {
    const root = await temporary(),
      workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "a.ts"), "NATIVE_FILE_EVIDENCE");
    if (mode === "scope-correction")
      await writeFile(join(workspace, "b.ts"), "SECOND_FILE_EVIDENCE");
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
        const submitSchema = body.tools?.find(
          (tool: any) => tool.function?.name === "submit_review",
        )?.function.parameters;
        if (
          Array.isArray(submitSchema?.properties?.actionable_findings?.items)
        ) {
          response.writeHead(400, { "Content-Type": "application/json" });
          response.end(
            JSON.stringify({
              error: {
                code: "invalid_function_parameters",
                message: "array items must be an object",
              },
            }),
          );
          return;
        }
        const scopeCorrection = mode === "scope-correction";
        const name =
          requests.length === 1 || (scopeCorrection && requests.length === 3)
            ? "view"
            : "submit_review";
        const args =
          name === "view"
            ? { path: join(workspace, requests.length === 3 ? "b.ts" : "a.ts") }
            : mode === "adjudication" || mode === "proof-correction"
              ? {
                  schema_version: "2",
                  kind: "review-mesh.adjudication-result",
                  verdict: mode === "proof-correction" ? "fail" : "pass",
                  review_markdown: "Full loopback native report",
                  summary: "Both supplied candidates were checked",
                  actionable_findings: [],
                  decisions: ["CANDIDATE-001", "CANDIDATE-002"].map((id) => ({
                    source_finding_id: id,
                    decision:
                      mode === "proof-correction" ? "confirmed" : "rejected",
                    rationale:
                      "The candidate's alleged behavior is absent from the inspected file.",
                    cited_evidence: [
                      {
                        path: "a.ts",
                        start_line:
                          mode === "proof-correction" && requests.length === 2
                            ? 99
                            : 1,
                        end_line:
                          mode === "proof-correction" && requests.length === 2
                            ? 99
                            : 1,
                        detail: "NATIVE_FILE_EVIDENCE",
                      },
                    ],
                    unverified_assumptions: [],
                  })),
                  informational_notes: [],
                }
              : {
                  schema_version: "4",
                  verdict: "pass",
                  review_markdown: "Full loopback native report",
                  summary: "Clear",
                  actionable_findings: [],
                  informational_notes: [],
                  native_scope_attestation: {
                    complete: true,
                    reviewed_paths:
                      scopeCorrection && requests.length >= 4
                        ? ["a.ts", "b.ts"]
                        : ["a.ts"],
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
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
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
    if (mode === "scope-correction") {
      input.context.review_scope = { mode: "changes", source: "request" };
      input.context.git = {
        is_repository: true,
        root: workspace,
        branch: "fixture",
        head: "fixture-head",
        merge_base: "fixture-base",
        status_entries: [],
        changed_files: ["a.ts", "b.ts"],
        diff_stat: "2 files changed",
        diff: "",
        truncated: {
          status_entries: false,
          changed_files: false,
          diff_stat: false,
          diff: false,
        },
      };
    }
    if (mode === "adjudication" || mode === "proof-correction") {
      input.reviewer = resolvedReviewer({
        ...input.reviewer,
        policy: {
          mode: "adjudication",
          candidateFindings: ["CANDIDATE-001", "CANDIDATE-002"].map((id) => ({
            ...failResult(id).actionable_findings[0],
            id,
            evidence: [
              {
                path: "a.ts",
                start_line: 1,
                end_line: 1,
                detail: "NATIVE_FILE_EVIDENCE",
              },
            ],
            claim: {
              trigger: "Trigger",
              affected_behavior: "Behavior",
              outcome: "Outcome",
            },
          })) as never,
          passQuorum: 1,
          minimumProviderGroups: 1,
          adjudication: "required",
          gateMinimumSeverity: "medium",
          gateMinimumConfidence: "medium",
        },
      });
      input.resultJsonSchema = nativeResultJsonSchema(input.reviewer);
    }
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
      if (mode === "adjudication" || mode === "proof-correction") {
        expect(events.at(-1)).toMatchObject({
          type: "result",
          result: {
            decisions: [
              { source_finding_id: "CANDIDATE-001" },
              { source_finding_id: "CANDIDATE-002" },
            ],
          },
        });
        const schema = requests[0]!.body.tools.find(
          (tool: any) => tool.function.name === "submit_review",
        ).function.parameters;
        expect(schema.properties.actionable_findings).toMatchObject({
          type: "array",
          items: { type: "object" },
        });
        const requestedSchema = input.resultJsonSchema.properties as Record<
          string,
          any
        >;
        expect(requestedSchema.actionable_findings).toMatchObject({
          maxItems: 0,
        });
        expect(requestedSchema.decisions).toMatchObject({
          minItems: 2,
          maxItems: 2,
        });
        expect(
          schema.properties.decisions.items.properties.source_finding_id.enum,
        ).toEqual(["CANDIDATE-001", "CANDIDATE-002"]);
      }
      expect(requests).toHaveLength(
        mode === "scope-correction" ? 4 : mode === "proof-correction" ? 3 : 2,
      );
      if (mode === "proof-correction")
        expect(JSON.stringify(requests[2]!.body.messages)).toContain(
          "line_out_of_range",
        );
      if (mode === "scope-correction") {
        expect(JSON.stringify(requests[2]!.body.messages)).toContain("b.ts");
        expect(JSON.stringify(requests[3]!.body.messages)).toContain(
          "SECOND_FILE_EVIDENCE",
        );
        expect(events.at(-1)).toMatchObject({
          type: "result",
          result: {
            native_scope_attestation: { reviewed_paths: ["a.ts", "b.ts"] },
          },
        });
        expect(await readFile(join(workspace, "b.ts"), "utf8")).toBe(
          "SECOND_FILE_EVIDENCE",
        );
      }
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
  },
  30000,
);

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
            const listeners = new Set<(event: SessionEvent) => void>();
            return {
              async send() {
                sends++;
                await submit.handler!(result, {} as never);
                for (const listener of listeners)
                  listener({ type: "session.idle", data: {} } as SessionEvent);
                return "message";
              },
              on(handler: (event: SessionEvent) => void) {
                listeners.add(handler);
                return () => listeners.delete(handler);
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
