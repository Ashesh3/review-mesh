import { describe, expect, it, vi } from "vitest";
import {
  createCopilotAdapter,
  type CopilotClientFacade,
  type CopilotClientFactory,
  type CopilotClientOptions,
  type CopilotPermissionRequest,
  type CopilotPermissionResult,
  type CopilotSessionFacade,
  type CopilotSessionConfig,
  type CopilotSessionEvent,
} from "../../src/adapters/copilot.js";
import { AdapterRegistry } from "../../src/adapters/registry.js";
import type {
  AdapterEvent,
  AdapterReviewInput,
} from "../../src/adapters/types.js";
import { reviewerResultJsonSchema } from "../../src/protocol/json-schema.js";
import { buildReviewerPrompt } from "../../src/protocol/prompt.js";
import {
  passResult,
  resolvedContext,
  resolvedReviewer,
} from "../helpers/fixtures.js";
import type { ReasoningEffort } from "../../src/config/schemas.js";

const model = {
  id: "gpt-5.6-copilot",
  name: "GPT 5.6 Copilot",
  capabilities: {
    supports: { vision: false, reasoningEffort: true },
    limits: { max_context_window_tokens: 128_000 },
  },
  supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
};

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function finalMessage(content: string) {
  return {
    type: "assistant.message",
    id: "message-1",
    parentId: null,
    timestamp: "2026-08-30T00:00:00.000Z",
    data: { content },
  } as const;
}

function sdkEvent(value: object): CopilotSessionEvent {
  return value as CopilotSessionEvent;
}

async function collect(iterable: AsyncIterable<AdapterEvent>) {
  const values: AdapterEvent[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

function terminalFailure(values: readonly AdapterEvent[]) {
  const terminal = values.at(-1);
  expect(terminal?.type).toBe("failure");
  if (terminal?.type !== "failure") throw new Error("expected failure");
  return terminal;
}

function terminalResult(values: readonly AdapterEvent[]) {
  const terminal = values.at(-1);
  expect(terminal?.type).toBe("result");
  if (terminal?.type !== "result") throw new Error("expected result");
  return terminal;
}

interface FakeCapture {
  clientOptions: CopilotClientOptions[];
  sessionConfigs: CopilotSessionConfig[];
  sendCalls: Array<{ options: unknown; timeout: number | undefined }>;
  lifecycle: string[];
}

function expectPending(promise: Promise<unknown>) {
  return expect(
    Promise.race([
      promise.then(
        () => "settled",
        () => "settled",
      ),
      new Promise<"pending">((resolve) =>
        setTimeout(() => resolve("pending"), 10),
      ),
    ]),
  ).resolves.toBe("pending");
}

function fakeFactory(options?: {
  auth?: boolean;
  models?: (typeof model)[];
  onCreateSession?: () => void;
  onSend?: () => void;
  response?: ReturnType<typeof finalMessage> | undefined;
  sendError?: Error;
  statusError?: Error;
}) {
  const capture: FakeCapture = {
    clientOptions: [],
    sessionConfigs: [],
    sendCalls: [],
    lifecycle: [],
  };
  const sessions: CopilotSessionFacade[] = [];
  const clients: CopilotClientFacade[] = [];
  let eventHandler: ((event: CopilotSessionEvent) => void) | undefined;
  const createClient: CopilotClientFactory = (clientOptions) => {
    capture.clientOptions.push(clientOptions);
    const session: CopilotSessionFacade = {
      on: vi.fn((handler: (event: CopilotSessionEvent) => void) => {
        eventHandler = handler;
        return () => undefined;
      }),
      sendAndWait: vi.fn(async (messageOptions, timeout) => {
        capture.sendCalls.push({ options: messageOptions, timeout });
        options?.onSend?.();
        if (options?.sendError !== undefined) throw options.sendError;
        return options !== undefined && "response" in options
          ? options.response
          : finalMessage(
              JSON.stringify(passResult("Copilot found no defects.")),
            );
      }),
      abort: vi.fn(async () => {
        capture.lifecycle.push("abort");
      }),
      close: vi.fn(async () => {
        capture.lifecycle.push("close");
      }),
    };
    sessions.push(session);
    const client: CopilotClientFacade = {
      start: vi.fn(async () => {
        capture.lifecycle.push("start");
      }),
      getStatus: vi.fn(async () => {
        if (options?.statusError !== undefined) throw options.statusError;
        return { version: "1.0.11", protocolVersion: 1 };
      }),
      getAuthStatus: vi.fn(async () => ({
        isAuthenticated: options?.auth ?? true,
      })),
      listModels: vi.fn(async () => options?.models ?? [model]),
      createSession: vi.fn(async (config) => {
        capture.sessionConfigs.push(config);
        eventHandler = config.onEvent;
        options?.onCreateSession?.();
        return session;
      }),
      stop: vi.fn(async () => {
        capture.lifecycle.push("stop");
      }),
      forceStop: vi.fn(async () => {
        capture.lifecycle.push("forceStop");
      }),
    };
    clients.push(client);
    return client;
  };
  return {
    capture,
    clients,
    createClient,
    emit(event: CopilotSessionEvent) {
      eventHandler?.(event);
    },
    sessions,
  };
}

function setup(options?: {
  allowShellPromptOnly?: boolean;
  createClient?: CopilotClientFactory;
  isolationPolicy?: "prefer_enforced" | "require_enforced";
  useLoggedInUser?: boolean;
  effort?: ReasoningEffort;
}) {
  const reviewer = resolvedReviewer({
    id: "copilot-security",
    adapterId: "copilot-main",
    adapter: {
      type: "copilot",
      env_allowlist: ["GH_TOKEN"],
      ...(options?.useLoggedInUser === undefined
        ? {}
        : { use_logged_in_user: options.useLoggedInUser }),
    },
    model: model.id,
    ...(options?.effort === undefined ? {} : { effort: options.effort }),
    isolationPolicy: options?.isolationPolicy ?? "prefer_enforced",
    timeoutMs: 12_345,
    runtime:
      options?.allowShellPromptOnly === undefined
        ? {}
        : { allow_shell_prompt_only: options.allowShellPromptOnly },
  });
  const context = resolvedContext({ workspace: "F:\\Projects\\controlled" });
  const prompt = buildReviewerPrompt({
    reviewer,
    context,
    resultJsonSchema: reviewerResultJsonSchema,
  });
  const controller = new AbortController();
  const input: AdapterReviewInput = {
    runId: "run-copilot-13",
    reviewer,
    context,
    prompt,
    resultJsonSchema: reviewerResultJsonSchema,
    isolationPolicy: reviewer.isolationPolicy,
    signal: controller.signal,
  };
  const adapter = createCopilotAdapter(reviewer.adapter, {
    applicationDataDirectory: "F:\\ReviewMeshData",
    environment: { PATH: "safe-path", GH_TOKEN: "safe-token", SECRET: "no" },
    createClient: options?.createClient ?? fakeFactory().createClient,
  });
  return { adapter, controller, input, prompt, reviewer };
}

function permission(
  kind: CopilotPermissionRequest["kind"],
): CopilotPermissionRequest {
  return { kind } as CopilotPermissionRequest;
}

describe("Copilot adapter", () => {
  it("probes a fresh client and checks status, auth, and model membership concurrently", async () => {
    const status = deferred<{ version: string; protocolVersion: number }>();
    const auth = deferred<{ isAuthenticated: boolean }>();
    const models = deferred<(typeof model)[]>();
    const calls: string[] = [];
    const fake = fakeFactory();
    const createClient: CopilotClientFactory = (clientOptions) => {
      const client = fake.createClient(clientOptions);
      return {
        ...client,
        getStatus: vi.fn(() => {
          calls.push("status");
          return status.promise;
        }),
        getAuthStatus: vi.fn(() => {
          calls.push("auth");
          return auth.promise;
        }),
        listModels: vi.fn(() => {
          calls.push("models");
          return models.promise;
        }),
      };
    };
    const prepared = setup({ createClient, useLoggedInUser: true });

    const probePromise = prepared.adapter.probe(
      prepared.reviewer,
      prepared.controller.signal,
    );
    await vi.waitFor(() => expect(calls).toEqual(["status", "auth", "models"]));
    status.resolve({ version: "1.0.11", protocolVersion: 1 });
    auth.resolve({ isAuthenticated: true });
    models.resolve([model]);

    await expect(probePromise).resolves.toEqual({
      available: true,
      authenticated: true,
      model_available: true,
      streaming: true,
      cancellation: true,
      maximumIsolation: "prompt_only",
      runtime_version: "1.0.11",
    });
    expect(fake.capture.lifecycle).toEqual(["start", "stop"]);
    expect(fake.capture.clientOptions).toEqual([
      {
        mode: "empty",
        baseDirectory: "F:\\ReviewMeshData\\runtime\\copilot",
        logLevel: "error",
        env: { PATH: "safe-path", GH_TOKEN: "safe-token" },
        useLoggedInUser: true,
      },
    ]);
  });

  it("uses the logged-in GitHub identity by default", async () => {
    const fake = fakeFactory();
    const prepared = setup({ createClient: fake.createClient });

    await prepared.adapter.probe(prepared.reviewer, prepared.controller.signal);

    expect(fake.capture.clientOptions[0]?.useLoggedInUser).toBe(true);
  });

  it("preserves an explicit token-only Copilot adapter setting", async () => {
    const fake = fakeFactory();
    const prepared = setup({
      createClient: fake.createClient,
      useLoggedInUser: false,
    });

    await prepared.adapter.probe(prepared.reviewer, prepared.controller.signal);

    expect(fake.capture.clientOptions[0]?.useLoggedInUser).toBe(false);
  });

  it("validates and forwards the configured Copilot reasoning effort", async () => {
    const fake = fakeFactory();
    const prepared = setup({ createClient: fake.createClient, effort: "high" });

    await expect(
      prepared.adapter.probe(prepared.reviewer, prepared.controller.signal),
    ).resolves.toMatchObject({ available: true, model_available: true });
    await collect(prepared.adapter.run(prepared.input));

    expect(fake.capture.sessionConfigs[0]).toMatchObject({
      model: model.id,
      reasoningEffort: "high",
    });
  });

  it("rejects unavailable Copilot effort levels during the probe", async () => {
    const fake = fakeFactory();
    const prepared = setup({
      createClient: fake.createClient,
      effort: "ultra",
    });

    await expect(
      prepared.adapter.probe(prepared.reviewer, prepared.controller.signal),
    ).resolves.toMatchObject({
      available: false,
      model_available: false,
      message: expect.stringContaining("does not support effort ultra"),
    });
  });

  it("reports unauthenticated, absent models, and sanitized probe failures", async () => {
    const unauthenticated = fakeFactory({ auth: false });
    const missing = fakeFactory({ models: [] });
    const crashed = fakeFactory({
      statusError: new Error("Authorization: Bearer top-secret"),
    });

    const authPrepared = setup({ createClient: unauthenticated.createClient });
    const missingPrepared = setup({ createClient: missing.createClient });
    const crashedPrepared = setup({ createClient: crashed.createClient });
    const authResult = await authPrepared.adapter.probe(
      authPrepared.reviewer,
      authPrepared.controller.signal,
    );
    const missingResult = await missingPrepared.adapter.probe(
      missingPrepared.reviewer,
      missingPrepared.controller.signal,
    );
    const crashedResult = await crashedPrepared.adapter.probe(
      crashedPrepared.reviewer,
      crashedPrepared.controller.signal,
    );

    expect(authResult).toMatchObject({
      available: false,
      authenticated: false,
      model_available: true,
    });
    expect(missingResult).toMatchObject({
      available: false,
      authenticated: true,
      model_available: false,
    });
    expect(crashedResult).toMatchObject({
      available: false,
      authenticated: "unknown",
      model_available: "unknown",
    });
    expect(JSON.stringify(crashedResult)).not.toContain("top-secret");
  });

  it("uses the exact default read-only session configuration and validates final JSON", async () => {
    const fake = fakeFactory();
    const prepared = setup({ createClient: fake.createClient });

    const output = await collect(prepared.adapter.run(prepared.input));

    expect(fake.capture.sessionConfigs).toHaveLength(1);
    expect(fake.capture.sessionConfigs[0]).toMatchObject({
      model: model.id,
      workingDirectory: "F:\\Projects\\controlled",
      streaming: true,
      systemMessage: { mode: "append", content: prepared.prompt.system },
      enableConfigDiscovery: false,
      enableOnDemandInstructionDiscovery: false,
      enableFileHooks: false,
      enableSkills: false,
      enableSessionStore: false,
      enableHostGitOperations: false,
      availableTools: ["view", "grep", "glob"],
      excludedTools: ["edit", "create", "str_replace_editor", "apply_patch"],
      mcpServers: {},
      pluginDirectories: [],
      instructionDirectories: [],
      remoteSession: "off",
    });
    expect(fake.capture.sendCalls).toEqual([
      {
        options: { prompt: prepared.prompt.user, agentMode: "interactive" },
        timeout: 12_345,
      },
    ]);
    expect(terminalResult(output)).toMatchObject({
      isolation: "runtime_read_only",
      result: { verdict: "pass" },
    });
    expect(fake.capture.lifecycle).toEqual(["start", "close", "stop"]);
  });

  it("denies every non-read permission in the default profile", async () => {
    const fake = fakeFactory();
    const prepared = setup({ createClient: fake.createClient });
    await collect(prepared.adapter.run(prepared.input));
    const handler = fake.capture.sessionConfigs[0]?.onPermissionRequest;
    expect(handler).toBeTypeOf("function");

    const decisions: CopilotPermissionResult[] = [];
    for (const kind of [
      "read",
      "write",
      "shell",
      "memory",
      "hook",
      "mcp",
      "custom-tool",
      "url",
    ] as const) {
      decisions.push(
        (await handler?.(permission(kind), {
          sessionId: "session-1",
        })) as CopilotPermissionResult,
      );
    }
    expect(decisions.map((decision) => decision.kind)).toEqual([
      "approve-once",
      "reject",
      "reject",
      "reject",
      "reject",
      "reject",
      "reject",
      "reject",
    ]);
  });

  it("adds only shell tools and shell permission for the trusted prompt-only option", async () => {
    const fake = fakeFactory();
    const prepared = setup({
      allowShellPromptOnly: true,
      createClient: fake.createClient,
    });
    const output = await collect(prepared.adapter.run(prepared.input));
    const config = fake.capture.sessionConfigs[0];
    const handler = config?.onPermissionRequest;

    expect(config?.availableTools).toEqual([
      "view",
      "grep",
      "glob",
      "powershell",
      "bash",
    ]);
    await expect(
      handler?.(permission("shell"), { sessionId: "session-1" }),
    ).resolves.toMatchObject({ kind: "approve-once" });
    await expect(
      handler?.(permission("write"), { sessionId: "session-1" }),
    ).resolves.toMatchObject({ kind: "reject" });
    expect(terminalResult(output).isolation).toBe("prompt_only");
  });

  it("never auto-approves a permission that managed policy requires a user to decide", async () => {
    const fake = fakeFactory();
    const prepared = setup({
      allowShellPromptOnly: true,
      createClient: fake.createClient,
    });
    await collect(prepared.adapter.run(prepared.input));
    const handler = fake.capture.sessionConfigs[0]?.onPermissionRequest;

    await expect(
      handler?.(
        { kind: "read", managedApprovalRequired: true },
        { sessionId: "session-1", managedSettingsEnabled: true },
      ),
    ).resolves.toMatchObject({ kind: "reject" });
    await expect(
      handler?.(
        { kind: "shell", managedApprovalRequired: true },
        { sessionId: "session-1", managedSettingsEnabled: true },
      ),
    ).resolves.toMatchObject({ kind: "reject" });
  });

  it("turns native events into fixed summaries without publishing raw content", async () => {
    let fake!: ReturnType<typeof fakeFactory>;
    fake = fakeFactory({
      onSend: () => {
        fake.emit(
          sdkEvent({
            type: "assistant.turn_start",
            data: { turnId: "turn-1", raw: "private prompt" },
          }),
        );
        fake.emit(
          sdkEvent({
            type: "tool.execution_start",
            data: {
              toolCallId: "tool-1",
              toolName: "grep",
              arguments: { secret: "private" },
            },
          }),
        );
        fake.emit(
          sdkEvent({
            type: "tool.execution_complete",
            data: {
              toolCallId: "tool-1",
              success: true,
              content: "private output",
            },
          }),
        );
        fake.emit(
          sdkEvent({
            type: "assistant.message",
            data: { content: "private model text" },
          }),
        );
        fake.emit(sdkEvent({ type: "session.idle", data: {} }));
      },
    });
    const prepared = setup({ createClient: fake.createClient });

    const output = await collect(prepared.adapter.run(prepared.input));

    expect(output.slice(0, -1)).toEqual([
      {
        type: "progress",
        phase: "reviewing",
        message: "Copilot started the review turn.",
      },
      { type: "activity", message: "Copilot started an inspection tool." },
      { type: "activity", message: "Copilot completed an inspection tool." },
      { type: "activity", message: "Copilot produced a response message." },
      {
        type: "progress",
        phase: "validating",
        message: "Copilot completed the review turn.",
      },
    ]);
    expect(JSON.stringify(output)).not.toContain("private");
  });

  it("streams fixed event summaries before the final response settles", async () => {
    const final = deferred<ReturnType<typeof finalMessage> | undefined>();
    const sending = deferred<void>();
    const fake = fakeFactory();
    const createClient: CopilotClientFactory = (options) => {
      const client = fake.createClient(options);
      const session = fake.sessions.at(-1);
      if (session === undefined) throw new Error("missing session");
      session.sendAndWait = vi.fn(async () => {
        sending.resolve();
        return final.promise;
      });
      return client;
    };
    const prepared = setup({ createClient });
    const iterator = prepared.adapter
      .run(prepared.input)
      [Symbol.asyncIterator]();
    const first = iterator.next();
    await sending.promise;

    fake.emit(
      sdkEvent({
        type: "tool.execution_start",
        data: { toolCallId: "tool-1", toolName: "grep" },
      }),
    );
    const firstOutcome = await Promise.race([
      first,
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 25),
      ),
    ]);

    expect(firstOutcome).toEqual({
      done: false,
      value: {
        type: "activity",
        message: "Copilot started an inspection tool.",
      },
    });
    final.resolve(finalMessage(JSON.stringify(passResult())));
    const rest: AdapterEvent[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      rest.push(next.value);
    }
    expect(terminalResult(rest).result.verdict).toBe("pass");
  });

  it.each([
    [undefined, undefined, "invalid_result"],
    [finalMessage("not json"), undefined, "invalid_result"],
    [
      finalMessage(JSON.stringify({ schema_version: "1" })),
      undefined,
      "invalid_result",
    ],
    [
      undefined,
      new Error("session failed with password=hunter2"),
      "process_crashed",
    ],
  ] as const)(
    "maps missing, malformed, invalid, and crashed terminals to typed failures",
    async (response, sendError, reason) => {
      const fake = fakeFactory({
        response,
        ...(sendError === undefined ? {} : { sendError }),
      });
      const prepared = setup({ createClient: fake.createClient });

      const output = await collect(prepared.adapter.run(prepared.input));

      expect(terminalFailure(output)).toMatchObject({
        failure: { reason },
        isolation: "runtime_read_only",
      });
      expect(JSON.stringify(output)).not.toContain("hunter2");
    },
  );

  it("maps a session error and a permission denial that prevents completion to typed failures", async () => {
    let errorFake!: ReturnType<typeof fakeFactory>;
    errorFake = fakeFactory({
      onSend: () =>
        errorFake.emit(
          sdkEvent({
            type: "session.error",
            data: { errorType: "query", message: "api_key=secret" },
          }),
        ),
    });
    let denialFake!: ReturnType<typeof fakeFactory>;
    denialFake = fakeFactory({
      onSend: () => {
        void denialFake.capture.sessionConfigs[0]?.onPermissionRequest?.(
          permission("write"),
          { sessionId: "session-1" },
        );
        throw new Error("permission denied");
      },
    });
    const errorPrepared = setup({ createClient: errorFake.createClient });
    const denialPrepared = setup({ createClient: denialFake.createClient });

    const errorOutput = await collect(
      errorPrepared.adapter.run(errorPrepared.input),
    );
    const denialOutput = await collect(
      denialPrepared.adapter.run(denialPrepared.input),
    );

    expect(terminalFailure(errorOutput).failure.reason).toBe("process_crashed");
    expect(terminalFailure(denialOutput).failure.reason).toBe(
      "protocol_violation",
    );
    expect(JSON.stringify(errorOutput)).not.toContain("secret");
  });

  it("fails require_enforced before starting a client or creating a session", async () => {
    const fake = fakeFactory();
    const prepared = setup({
      createClient: fake.createClient,
      isolationPolicy: "require_enforced",
    });

    const capabilities = await prepared.adapter.probe(
      prepared.reviewer,
      prepared.controller.signal,
    );
    const output = await collect(prepared.adapter.run(prepared.input));

    expect(capabilities).toMatchObject({
      available: false,
      maximumIsolation: "prompt_only",
    });
    expect(terminalFailure(output).failure.reason).toBe("adapter_unavailable");
    expect(fake.clients).toHaveLength(0);
    expect(fake.capture.sessionConfigs).toHaveLength(0);
  });

  it("cancels in abort-close-stop order and force cleanup force-stops once", async () => {
    const send = deferred<ReturnType<typeof finalMessage> | undefined>();
    const created = deferred<void>();
    const fake = fakeFactory();
    const createClient: CopilotClientFactory = (options) => {
      const client = fake.createClient(options);
      const session = fake.sessions.at(-1);
      if (session === undefined) throw new Error("missing session");
      session.sendAndWait = vi.fn(async () => {
        created.resolve();
        return send.promise;
      });
      session.abort = vi.fn(async () => {
        fake.capture.lifecycle.push("abort");
        send.reject(new Error("aborted"));
      });
      return client;
    };
    const prepared = setup({ createClient });
    const completion = collect(prepared.adapter.run(prepared.input));
    await created.promise;

    prepared.controller.abort();
    const output = await completion;
    expect(terminalFailure(output).failure.reason).toBe("cancelled");
    expect(fake.capture.lifecycle).toEqual(["start", "abort", "close", "stop"]);

    const hanging = deferred<ReturnType<typeof finalMessage> | undefined>();
    const started = deferred<void>();
    const forceFake = fakeFactory();
    const forceFactory: CopilotClientFactory = (options) => {
      const client = forceFake.createClient(options);
      const session = forceFake.sessions.at(-1);
      if (session === undefined) throw new Error("missing session");
      session.sendAndWait = vi.fn(async () => {
        started.resolve();
        return hanging.promise;
      });
      return client;
    };
    const forcePrepared = setup({ createClient: forceFactory });
    const forceCompletion = collect(
      forcePrepared.adapter.run(forcePrepared.input),
    );
    await started.promise;
    const forceCleanup = Promise.all([
      forcePrepared.adapter.forceCleanup?.(),
      forcePrepared.adapter.forceCleanup?.(),
    ]);
    hanging.reject(new Error("forced"));
    await Promise.all([forceCompletion, forceCleanup]);
    expect(forceFake.capture.lifecycle).toEqual(["start", "forceStop"]);
  });

  it("awaits abort completion before closing the session", async () => {
    const abortGate = deferred<void>();
    const sending = deferred<void>();
    const fake = fakeFactory();
    let rejectSend!: (reason?: unknown) => void;
    const createClient: CopilotClientFactory = (options) => {
      const client = fake.createClient(options);
      const session = fake.sessions.at(-1);
      if (session === undefined) throw new Error("missing session");
      session.sendAndWait = vi.fn(
        () =>
          new Promise<ReturnType<typeof finalMessage> | undefined>(
            (_, reject) => {
              rejectSend = reject;
              sending.resolve();
            },
          ),
      );
      session.abort = vi.fn(async () => {
        fake.capture.lifecycle.push("abort");
        rejectSend(new Error("aborted"));
        await abortGate.promise;
        fake.capture.lifecycle.push("abort-complete");
      });
      return client;
    };
    const prepared = setup({ createClient });
    const completion = collect(prepared.adapter.run(prepared.input));
    await sending.promise;

    prepared.controller.abort();
    await vi.waitFor(() => expect(fake.capture.lifecycle).toContain("abort"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.capture.lifecycle).not.toContain("close");

    abortGate.resolve();
    await completion;
    expect(fake.capture.lifecycle).toEqual([
      "start",
      "abort",
      "abort-complete",
      "close",
      "stop",
    ]);
  });

  it("aborts a session created after cancellation and before sendAndWait", async () => {
    const sessionCreated = deferred<void>();
    const releaseSession = deferred<void>();
    const fake = fakeFactory();
    const createClient: CopilotClientFactory = (options) => {
      const client = fake.createClient(options);
      const session = fake.sessions.at(-1);
      if (session === undefined) throw new Error("missing session");
      client.createSession = vi.fn(async (config) => {
        fake.capture.sessionConfigs.push(config);
        sessionCreated.resolve();
        await releaseSession.promise;
        return session;
      });
      return client;
    };
    const prepared = setup({ createClient });
    const completion = collect(prepared.adapter.run(prepared.input));
    await sessionCreated.promise;

    prepared.controller.abort();
    releaseSession.resolve();
    const output = await completion;

    expect(terminalFailure(output).failure.reason).toBe("cancelled");
    expect(fake.sessions[0]?.sendAndWait).not.toHaveBeenCalled();
    expect(fake.capture.lifecycle).toEqual(["start", "abort", "close", "stop"]);
  });

  it("force cleanup waits for startup unwind before it settles", async () => {
    const startGate = deferred<void>();
    const startEntered = deferred<void>();
    const allowLifecycleToFinish = deferred<void>();
    const fake = fakeFactory();
    const createClient: CopilotClientFactory = (options) => {
      const client = fake.createClient(options);
      client.start = vi.fn(async () => {
        fake.capture.lifecycle.push("start");
        startEntered.resolve();
        await startGate.promise;
        await allowLifecycleToFinish.promise;
      });
      client.forceStop = vi.fn(async () => {
        fake.capture.lifecycle.push("forceStop");
        startGate.resolve();
      });
      return client;
    };
    const prepared = setup({ createClient });
    const completion = collect(prepared.adapter.run(prepared.input));
    await startEntered.promise;

    const cleanup = prepared.adapter.forceCleanup!();
    await expectPending(cleanup);
    allowLifecycleToFinish.resolve();
    const output = await completion;
    await cleanup;

    expect(terminalFailure(output).failure.reason).toBe("process_crashed");
    expect(fake.capture.lifecycle).toEqual(["start", "forceStop"]);
  });

  it("retains force-cleanup ownership when graceful client stop reports errors", async () => {
    const fake = fakeFactory();
    const createClient: CopilotClientFactory = (options) => {
      const client = fake.createClient(options);
      client.stop = vi.fn(async () => {
        fake.capture.lifecycle.push("stop");
        throw new Error("password=cleanup-secret runtime still active");
      });
      return client;
    };
    const prepared = setup({ createClient });

    const output = await collect(prepared.adapter.run(prepared.input));
    expect(terminalResult(output).result.verdict).toBe("pass");
    expect(JSON.stringify(output)).not.toContain("cleanup-secret");

    await Promise.all([
      prepared.adapter.forceCleanup!(),
      prepared.adapter.forceCleanup!(),
    ]);
    expect(fake.capture.lifecycle).toEqual([
      "start",
      "close",
      "stop",
      "forceStop",
    ]);
  });

  it("creates one client per logical run and registers Copilot additively", async () => {
    const fake = fakeFactory();
    const prepared = setup({ createClient: fake.createClient });

    await collect(prepared.adapter.run(prepared.input));
    await collect(prepared.adapter.run(prepared.input));

    expect(fake.clients).toHaveLength(2);
    const registry = new AdapterRegistry();
    expect(registry.create("copilot-main", prepared.reviewer.adapter).id).toBe(
      "copilot",
    );
    expect(
      registry.create("command-main", {
        type: "command",
        command: "reviewer",
        protocol: "review-mesh-command-v1",
      }).id,
    ).toBe("command-main");
  });
});
