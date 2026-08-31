import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Options as ClaudeOptions,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createClaudeAdapter,
  isClaudeSandboxUnavailable,
  type ClaudeQueryFacade,
  type ClaudeRuntimeInitializer,
  type ClaudeWarmQuery,
} from "../../src/adapters/claude.js";
import { AdapterRegistry } from "../../src/adapters/registry.js";
import type {
  AdapterEvent,
  AdapterReviewInput,
  ReviewAdapter,
} from "../../src/adapters/types.js";
import type { AdapterRegistration } from "../../src/config/schemas.js";
import { reviewerResultJsonSchema } from "../../src/protocol/json-schema.js";
import { buildReviewerPrompt } from "../../src/protocol/prompt.js";
import type { ReviewerResult } from "../../src/protocol/schemas.js";
import {
  passResult,
  resolvedContext,
  resolvedReviewer,
} from "../helpers/fixtures.js";

const sandboxErrorTokens = [
  "unavailable",
  "unsupported",
  "not supported",
  "missing dependencies",
  "cannot start",
] as const;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "review-mesh-claude-"));
  temporaryDirectories.push(directory);
  return directory;
}

function sdkMessage(value: object): SDKMessage {
  return value as SDKMessage;
}

function successResult(structuredOutput?: unknown): SDKMessage {
  return sdkMessage({
    type: "result",
    subtype: "success",
    duration_ms: 20,
    duration_api_ms: 10,
    is_error: false,
    num_turns: 1,
    result: "structured result attached",
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: null,
      service_tier: "standard",
    },
    modelUsage: {},
    permission_denials: [],
    ...(structuredOutput === undefined
      ? {}
      : { structured_output: structuredOutput }),
    uuid: "00000000-0000-4000-8000-000000000001",
    session_id: "00000000-0000-4000-8000-000000000002",
  });
}

function errorResult(
  subtype:
    | "error_during_execution"
    | "error_max_turns"
    | "error_max_budget_usd"
    | "error_max_structured_output_retries",
  errors: string[] = ["provider failure"],
): SDKMessage {
  return sdkMessage({
    type: "result",
    subtype,
    duration_ms: 20,
    duration_api_ms: 10,
    is_error: true,
    num_turns: 1,
    stop_reason: null,
    total_cost_usd: 0,
    usage: {
      input_tokens: 10,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: null,
      service_tier: "standard",
    },
    modelUsage: {},
    permission_denials: [],
    errors,
    uuid: "00000000-0000-4000-8000-000000000003",
    session_id: "00000000-0000-4000-8000-000000000004",
  });
}

interface ControlledStream extends AsyncIterable<SDKMessage> {
  close: ReturnType<typeof vi.fn>;
}

function messages(...values: SDKMessage[]): ControlledStream {
  return {
    close: vi.fn(),
    async *[Symbol.asyncIterator]() {
      for (const value of values) yield value;
    },
  };
}

function throwingStream(error: Error): ControlledStream {
  return {
    close: vi.fn(),
    async *[Symbol.asyncIterator]() {
      throw error;
    },
  };
}

async function collect(iterable: AsyncIterable<AdapterEvent>) {
  const collected: AdapterEvent[] = [];
  for await (const event of iterable) collected.push(event);
  return collected;
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

interface QueryCall {
  prompt: string;
  options: ClaudeOptions;
}

function permissionContext() {
  return {
    signal: new AbortController().signal,
    toolUseID: "tool-use-test",
    requestId: "request-test",
  };
}

function warmQuery() {
  return {
    query: vi.fn<ClaudeWarmQuery["query"]>(() => {
      throw new Error("probe must not send a prompt");
    }),
    close: vi.fn(),
    [Symbol.asyncDispose]: vi.fn(async () => undefined),
  } satisfies ClaudeWarmQuery;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function facadeFor(streams: ControlledStream[]) {
  const calls: QueryCall[] = [];
  const facade: ClaudeQueryFacade = (input) => {
    calls.push(input);
    const stream = streams[calls.length - 1];
    if (stream === undefined) throw new Error("unexpected Claude query");
    return stream;
  };
  return { calls, facade };
}

function setup(
  streams: ControlledStream[] = [
    messages(successResult(passResult("Claude found no actionable defects."))),
  ],
  options: {
    isolationPolicy?: "prefer_enforced" | "require_enforced";
    environment?: NodeJS.ProcessEnv;
    executable?: string;
    query?: ClaudeQueryFacade;
    startup?: ClaudeRuntimeInitializer;
  } = {},
) {
  const reviewer = resolvedReviewer({
    id: "claude-security",
    adapterId: "claude-main",
    adapter: {
      type: "claude",
      env_allowlist: ["ANTHROPIC_API_KEY"],
      ...(options.executable === undefined
        ? {}
        : { executable: options.executable }),
    },
    model: "claude-sonnet-test",
    isolationPolicy: options.isolationPolicy ?? "prefer_enforced",
  });
  const context = resolvedContext({
    workspace: "F:\\controlled-workspace",
    instructions: "Review the controlled workspace.",
    caller_context: { ticket: "RM-12" },
  });
  const prompt = buildReviewerPrompt({
    reviewer,
    context,
    resultJsonSchema: reviewerResultJsonSchema,
  });
  const controller = new AbortController();
  const input: AdapterReviewInput = {
    runId: "run-claude-12",
    reviewer,
    context,
    prompt,
    resultJsonSchema: reviewerResultJsonSchema,
    isolationPolicy: reviewer.isolationPolicy,
    signal: controller.signal,
  };
  const query = facadeFor(streams);
  const environment = options.environment ?? {
    ANTHROPIC_API_KEY: "test-anthropic-key",
    REVIEW_MESH_UNTRUSTED_SECRET: "must-not-cross",
    ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
    ...(process.env.SystemRoot === undefined
      ? {}
      : { SystemRoot: process.env.SystemRoot }),
  };
  const adapter = createClaudeAdapter(reviewer.adapter, {
    environment,
    query: options.query ?? query.facade,
    ...(options.startup === undefined ? {} : { startup: options.startup }),
  });
  return {
    adapter,
    context,
    controller,
    input,
    prompt,
    query,
    reviewer,
  };
}

describe("Claude Agent SDK adapter", () => {
  it("probes runtime initialization with isolated options and never sends a prompt", async () => {
    const warm = warmQuery();
    const startup = vi.fn<ClaudeRuntimeInitializer>(async () => warm);
    const prepared = setup(undefined, { startup });

    const capabilities = await prepared.adapter.probe(
      prepared.reviewer,
      prepared.controller.signal,
    );

    expect(capabilities).toEqual({
      available: true,
      authenticated: "unknown",
      model_available: "unknown",
      streaming: true,
      cancellation: true,
      maximumIsolation: "unknown",
      runtime_version: "0.3.251",
    });
    expect(startup).toHaveBeenCalledOnce();
    const initialization = startup.mock.calls[0]![0];
    expect(initialization.initializeTimeoutMs).toBe(3_000);
    expect(initialization.options).toMatchObject({
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {},
      plugins: [],
      skills: [],
      persistSession: false,
      env: { ANTHROPIC_API_KEY: "test-anthropic-key" },
    });
    expect(initialization.options.pathToClaudeCodeExecutable).toBeUndefined();
    expect(initialization.options.abortController).toBeInstanceOf(
      AbortController,
    );
    expect(warm.query).not.toHaveBeenCalled();
    expect(warm.close).toHaveBeenCalledOnce();
    expect(warm[Symbol.asyncDispose]).toHaveBeenCalledOnce();
    expect(prepared.query.calls).toHaveLength(0);
  });

  it("passes the configured executable to startup and reports a failed handshake unavailable without raw errors", async () => {
    const startup = vi.fn<ClaudeRuntimeInitializer>(async () => {
      throw new Error("api_key=private raw startup failure");
    });
    const prepared = setup(undefined, {
      executable: "F:\\missing\\claude.exe",
      startup,
    });

    const capabilities = await prepared.adapter.probe(
      prepared.reviewer,
      prepared.controller.signal,
    );

    expect(capabilities).toMatchObject({
      available: false,
      maximumIsolation: "unknown",
      message: "Claude runtime initialization failed.",
    });
    expect(startup.mock.calls[0]![0].options.pathToClaudeCodeExecutable).toBe(
      "F:\\missing\\claude.exe",
    );
    expect(JSON.stringify(capabilities)).not.toContain("private");
    expect(prepared.query.calls).toHaveLength(0);
  });

  it("uses the SDK bundled-runtime selection when no executable override is configured", async () => {
    const warm = warmQuery();
    const startup = vi.fn<ClaudeRuntimeInitializer>(async () => warm);
    const prepared = setup(undefined, { startup });

    const capabilities = await prepared.adapter.probe(
      prepared.reviewer,
      prepared.controller.signal,
    );

    expect(capabilities).toMatchObject({
      available: true,
      maximumIsolation: "unknown",
      runtime_version: "0.3.251",
    });
    expect(startup.mock.calls[0]![0].options).not.toHaveProperty(
      "pathToClaudeCodeExecutable",
    );
    expect(warm.query).not.toHaveBeenCalled();
    expect(prepared.query.calls).toHaveLength(0);
  });

  it("closes and asynchronously disposes a warm query even when close fails", async () => {
    const warm = warmQuery();
    warm.close.mockImplementation(() => {
      throw new Error("close failed");
    });
    const prepared = setup(undefined, {
      startup: async () => warm,
    });

    const capabilities = await prepared.adapter.probe(
      prepared.reviewer,
      prepared.controller.signal,
    );

    expect(capabilities).toMatchObject({
      available: true,
      maximumIsolation: "unknown",
    });
    expect(warm.query).not.toHaveBeenCalled();
    expect(warm.close).toHaveBeenCalledOnce();
    expect(warm[Symbol.asyncDispose]).toHaveBeenCalledOnce();
  });

  it("reports an aborted probe unavailable without invoking startup", async () => {
    const startup = vi.fn<ClaudeRuntimeInitializer>(async () => warmQuery());
    const prepared = setup(undefined, { startup });
    prepared.controller.abort(new Error("probe cancelled"));

    const capabilities = await prepared.adapter.probe(
      prepared.reviewer,
      prepared.controller.signal,
    );

    expect(capabilities).toMatchObject({
      available: false,
      maximumIsolation: "unknown",
      message: "Claude probing was cancelled.",
    });
    expect(startup).not.toHaveBeenCalled();
  });

  it("links in-flight probe cancellation to the startup controller without leaking raw errors", async () => {
    let startupController: AbortController | undefined;
    const startup = vi.fn<ClaudeRuntimeInitializer>(
      ({ options }) =>
        new Promise((_resolve, reject) => {
          startupController = options.abortController;
          startupController!.signal.addEventListener(
            "abort",
            () => reject(new Error("api_key=private cancelled startup")),
            { once: true },
          );
        }),
    );
    const prepared = setup(undefined, { startup });
    const probing = prepared.adapter.probe(
      prepared.reviewer,
      prepared.controller.signal,
    );
    await vi.waitFor(() =>
      expect(startupController).toBeInstanceOf(AbortController),
    );

    prepared.controller.abort(new Error("caller cancelled probe"));
    const capabilities = await probing;

    expect(startupController!.signal.aborted).toBe(true);
    expect(capabilities).toMatchObject({
      available: false,
      maximumIsolation: "unknown",
      message: "Claude probing was cancelled.",
    });
    expect(JSON.stringify(capabilities)).not.toContain("private");
  });

  it("reports cancellation that arrives during warm-query disposal", async () => {
    const warm = warmQuery();
    const prepared = setup(undefined, {
      startup: async () => warm,
    });
    warm[Symbol.asyncDispose].mockImplementation(async () => {
      prepared.controller.abort(new Error("cancel during disposal"));
    });

    const capabilities = await prepared.adapter.probe(
      prepared.reviewer,
      prepared.controller.signal,
    );

    expect(capabilities).toMatchObject({
      available: false,
      maximumIsolation: "unknown",
      message: "Claude probing was cancelled.",
    });
    expect(warm.query).not.toHaveBeenCalled();
  });

  it("force cleanup waits for an aborted startup to settle and complete probe cleanup", async () => {
    let startupController: AbortController | undefined;
    const startupSettled = deferred<ClaudeWarmQuery>();
    const disposal = deferred<undefined>();
    const warm = warmQuery();
    warm[Symbol.asyncDispose].mockImplementation(() => disposal.promise);
    const startup = vi.fn<ClaudeRuntimeInitializer>(({ options }) => {
      startupController = options.abortController;
      return startupSettled.promise;
    });
    const prepared = setup(undefined, { startup });
    const probing = prepared.adapter.probe(
      prepared.reviewer,
      prepared.controller.signal,
    );
    await vi.waitFor(() =>
      expect(startupController).toBeInstanceOf(AbortController),
    );

    let cleanupSettled = false;
    const cleanup = prepared.adapter.forceCleanup?.().then(() => {
      cleanupSettled = true;
    });
    await Promise.resolve();
    expect(startupController!.signal.aborted).toBe(true);
    expect(cleanupSettled).toBe(false);
    startupSettled.resolve(warm);
    await vi.waitFor(() => {
      expect(warm.close).toHaveBeenCalledOnce();
      expect(warm[Symbol.asyncDispose]).toHaveBeenCalledOnce();
    });
    expect(cleanupSettled).toBe(false);
    disposal.resolve(undefined);
    await cleanup;
    const capabilities = await probing;

    expect(cleanupSettled).toBe(true);
    expect(capabilities).toMatchObject({
      available: false,
      message: "Claude runtime initialization failed.",
    });
    expect(JSON.stringify(capabilities)).not.toContain("private");
    expect(warm.query).not.toHaveBeenCalled();
    expect(warm.close).toHaveBeenCalledOnce();
    expect(warm[Symbol.asyncDispose]).toHaveBeenCalledOnce();
  });

  it("shares one warm-query cleanup between normal probe finalization and force cleanup", async () => {
    const warm = warmQuery();
    const disposal = deferred<undefined>();
    warm[Symbol.asyncDispose].mockImplementation(() => disposal.promise);
    const prepared = setup(undefined, { startup: async () => warm });
    let probeSettled = false;
    const probing = prepared.adapter
      .probe(prepared.reviewer, prepared.controller.signal)
      .then((capabilities) => {
        probeSettled = true;
        return capabilities;
      });
    await vi.waitFor(() => {
      expect(warm.close).toHaveBeenCalledOnce();
      expect(warm[Symbol.asyncDispose]).toHaveBeenCalledOnce();
    });

    let cleanupSettled = false;
    const cleanup = prepared.adapter.forceCleanup?.().then(() => {
      cleanupSettled = true;
    });
    await Promise.resolve();
    expect(probeSettled).toBe(false);
    expect(cleanupSettled).toBe(false);
    expect(warm.close).toHaveBeenCalledOnce();
    expect(warm[Symbol.asyncDispose]).toHaveBeenCalledOnce();
    disposal.resolve(undefined);
    const [capabilities] = await Promise.all([probing, cleanup]);

    expect(capabilities).toMatchObject({
      available: false,
      message: "Claude runtime initialization failed.",
    });
    expect(warm.close).toHaveBeenCalledOnce();
    expect(warm[Symbol.asyncDispose]).toHaveBeenCalledOnce();
  });

  it("owns rejecting warm-query cleanup without duplicate calls or raw rejection", async () => {
    const warm = warmQuery();
    const disposal = deferred<undefined>();
    warm.close.mockImplementation(() => {
      throw new Error("api_key=private close failure");
    });
    warm[Symbol.asyncDispose].mockImplementation(() => disposal.promise);
    const prepared = setup(undefined, { startup: async () => warm });
    const probing = prepared.adapter.probe(
      prepared.reviewer,
      prepared.controller.signal,
    );
    await vi.waitFor(() =>
      expect(warm[Symbol.asyncDispose]).toHaveBeenCalledOnce(),
    );
    const cleanup = prepared.adapter.forceCleanup?.();

    disposal.reject(new Error("secret=private dispose failure"));
    const [capabilities] = await Promise.all([probing, cleanup]);

    expect(capabilities).toMatchObject({
      available: false,
      message: "Claude runtime initialization failed.",
    });
    expect(JSON.stringify(capabilities)).not.toContain("private");
    expect(warm.close).toHaveBeenCalledOnce();
    expect(warm[Symbol.asyncDispose]).toHaveBeenCalledOnce();
  });

  it("the production startup probe rejects a regular fake executable that cannot initialize", async () => {
    const root = await temporaryDirectory();
    const executable = join(
      root,
      process.platform === "win32" ? "claude.exe" : "claude",
    );
    await writeFile(executable, "fixture", "utf8");
    if (process.platform !== "win32") await chmod(executable, 0o755);
    const prepared = setup(undefined, { executable });

    const capabilities = await prepared.adapter.probe(
      prepared.reviewer,
      prepared.controller.signal,
    );

    expect(capabilities).toMatchObject({
      available: false,
      maximumIsolation: "unknown",
      runtime_version: "0.3.251",
      message: "Claude runtime initialization failed.",
    });
    expect(prepared.query.calls).toHaveLength(0);
  });

  it("uses the exact isolated sandbox options and separates trusted system and user prompts", async () => {
    const prepared = setup(undefined, {
      executable: "C:\\trusted\\claude.exe",
    });

    const output = await collect(prepared.adapter.run(prepared.input));
    const call = prepared.query.calls[0]!;

    expect(terminalResult(output)).toMatchObject({
      isolation: "enforced_read_only",
    });
    expect(call.prompt).toBe(prepared.prompt.user);
    expect(call.prompt).not.toContain(prepared.prompt.system);
    expect(call.options).toMatchObject({
      cwd: prepared.context.workspace,
      model: prepared.reviewer.model,
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {},
      plugins: [],
      skills: [],
      tools: ["Read", "Glob", "Grep", "Bash"],
      disallowedTools: [
        "Edit",
        "Write",
        "NotebookEdit",
        "WebFetch",
        "WebSearch",
        "Task",
      ],
      permissionMode: "dontAsk",
      systemPrompt: prepared.prompt.system,
      outputFormat: {
        type: "json_schema",
        schema: reviewerResultJsonSchema,
      },
      persistSession: false,
      pathToClaudeCodeExecutable: "C:\\trusted\\claude.exe",
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
        filesystem: { denyWrite: [prepared.context.workspace] },
        network: { allowedDomains: [], strictAllowlist: true },
      },
    });
    expect(call.options.abortController).toBeInstanceOf(AbortController);
    expect(call.options.env).toMatchObject({
      ANTHROPIC_API_KEY: "test-anthropic-key",
    });
    expect(call.options.env).not.toHaveProperty("REVIEW_MESH_UNTRUSTED_SECRET");
    expect(call.options.env).not.toBe(process.env);
  });

  it("fails closed for tool permissions in the sandboxed attempt", async () => {
    const prepared = setup();
    await collect(prepared.adapter.run(prepared.input));
    const canUseTool = prepared.query.calls[0]!.options.canUseTool!;

    for (const tool of ["Read", "Glob", "Grep", "Bash"]) {
      await expect(canUseTool(tool, {}, permissionContext())).resolves.toEqual({
        behavior: "allow",
      });
    }
    for (const tool of [
      "Edit",
      "Write",
      "NotebookEdit",
      "WebFetch",
      "WebSearch",
      "Task",
      "UnknownTool",
    ]) {
      await expect(canUseTool(tool, {}, permissionContext())).resolves.toEqual({
        behavior: "deny",
        message: "Review Mesh denied this tool for a read-only review.",
        interrupt: false,
      });
    }
  });

  it("validates structured_output instead of trusting result prose", async () => {
    const expected = passResult("Validated structured output.");
    const prepared = setup([
      messages(
        sdkMessage({
          type: "assistant",
          message: {
            id: "msg-secret",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-test",
            content: [{ type: "text", text: "PRIVATE_ASSISTANT_REASONING" }],
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
          parent_tool_use_id: null,
          uuid: "00000000-0000-4000-8000-000000000005",
          session_id: "00000000-0000-4000-8000-000000000006",
        }),
        successResult(expected),
      ),
    ]);

    const output = await collect(prepared.adapter.run(prepared.input));

    expect(terminalResult(output)).toEqual({
      type: "result",
      result: expected,
      isolation: "enforced_read_only",
    });
    expect(JSON.stringify(output)).not.toContain("PRIVATE_ASSISTANT_REASONING");
  });

  it.each([
    [successResult(), "invalid_result"],
    [successResult({ schema_version: "1", verdict: "pass" }), "invalid_result"],
  ] as const)(
    "rejects missing or malformed structured output",
    async (message, reason) => {
      const prepared = setup([messages(message)]);

      const output = await collect(prepared.adapter.run(prepared.input));
      const terminal = terminalFailure(output);

      expect(terminal.failure.reason).toBe(reason);
      expect(terminal).not.toHaveProperty("isolation");
    },
  );

  it.each([
    ["error_max_turns", "timeout", true],
    ["error_during_execution", "unknown", false],
    ["error_max_budget_usd", "unknown", false],
    ["error_max_structured_output_retries", "invalid_result", false],
  ] as const)(
    "maps SDK result subtype %s without publishing provider errors",
    async (subtype, reason, retryable) => {
      const prepared = setup([
        messages(errorResult(subtype, ["api_key=secret provider detail"])),
      ]);

      const output = await collect(prepared.adapter.run(prepared.input));
      const terminal = terminalFailure(output);

      expect(terminal.failure).toMatchObject({ reason, retryable });
      expect(terminal).not.toHaveProperty("isolation");
      expect(terminal.failure.message).not.toContain("secret");
      expect(terminal.failure.message).not.toContain("provider detail");
    },
  );

  it("maps only fixed activity summaries and never forwards tool, task, file, hook, or stderr content", async () => {
    const prepared = setup([
      messages(
        sdkMessage({
          type: "system",
          subtype: "status",
          status: "requesting",
          uuid: "00000000-0000-4000-8000-000000000007",
          session_id: "00000000-0000-4000-8000-000000000008",
        }),
        sdkMessage({
          type: "tool_progress",
          tool_use_id: "tool-secret",
          tool_name: "Read_PRIVATE_FILE",
          parent_tool_use_id: null,
          elapsed_time_seconds: 1,
          uuid: "00000000-0000-4000-8000-000000000009",
          session_id: "00000000-0000-4000-8000-000000000010",
        }),
        sdkMessage({
          type: "system",
          subtype: "task_progress",
          task_id: "task-secret",
          description: "PRIVATE_TASK_DESCRIPTION",
          summary: "PRIVATE_TASK_SUMMARY",
          usage: { total_tokens: 1, tool_uses: 1, duration_ms: 1 },
          last_tool_name: "PRIVATE_TOOL",
          uuid: "00000000-0000-4000-8000-000000000011",
          session_id: "00000000-0000-4000-8000-000000000012",
        }),
        sdkMessage({
          type: "system",
          subtype: "hook_response",
          hook_id: "hook-secret",
          hook_name: "PRIVATE_HOOK",
          hook_event: "PostToolUse",
          output: "PRIVATE_FILE_CONTENT",
          stdout: "PRIVATE_STDOUT",
          stderr: "PRIVATE_STDERR",
          outcome: "error",
          uuid: "00000000-0000-4000-8000-000000000013",
          session_id: "00000000-0000-4000-8000-000000000014",
        }),
        successResult(passResult()),
      ),
    ]);

    const output = await collect(prepared.adapter.run(prepared.input));

    expect(output.slice(0, -1)).toEqual([
      { type: "activity", message: "Claude is requesting a model response." },
      { type: "activity", message: "Claude is running an inspection tool." },
      { type: "activity", message: "Claude is progressing a review task." },
    ]);
    expect(JSON.stringify(output)).not.toMatch(
      /PRIVATE_|Read_PRIVATE_FILE|tool-secret|task-secret|hook-secret/,
    );
  });

  it("requires exactly one SDK result and closes every completed query", async () => {
    const missing = messages(
      sdkMessage({
        type: "system",
        subtype: "status",
        status: null,
        uuid: "00000000-0000-4000-8000-000000000015",
        session_id: "00000000-0000-4000-8000-000000000016",
      }),
    );
    const duplicate = messages(
      successResult(passResult("first")),
      successResult(passResult("second")),
    );
    const missingPrepared = setup([missing]);
    const duplicatePrepared = setup([duplicate]);

    const missingOutput = await collect(
      missingPrepared.adapter.run(missingPrepared.input),
    );
    const duplicateOutput = await collect(
      duplicatePrepared.adapter.run(duplicatePrepared.input),
    );

    expect(terminalFailure(missingOutput).failure.reason).toBe(
      "protocol_violation",
    );
    expect(terminalFailure(missingOutput)).not.toHaveProperty("isolation");
    expect(terminalFailure(duplicateOutput)).toMatchObject({
      failure: { reason: "protocol_violation" },
    });
    expect(terminalFailure(duplicateOutput)).not.toHaveProperty("isolation");
    expect(missing.close).toHaveBeenCalledOnce();
    expect(duplicate.close).toHaveBeenCalledOnce();
  });

  it("rejects a malformed SDK terminal subtype without claiming isolation", async () => {
    const prepared = setup([
      messages(
        sdkMessage({
          type: "result",
          subtype: "unexpected_terminal",
          is_error: true,
        }),
      ),
    ]);

    const output = await collect(prepared.adapter.run(prepared.input));

    expect(terminalFailure(output)).toMatchObject({
      failure: { reason: "protocol_violation" },
    });
    expect(terminalFailure(output)).not.toHaveProperty("isolation");
  });

  it("discloses prompt-only isolation for a malformed terminal after fallback starts", async () => {
    const prepared = setup([
      messages(
        errorResult("error_during_execution", ["Sandbox is unavailable."]),
      ),
      messages(
        sdkMessage({
          type: "result",
          subtype: "unexpected_terminal",
          is_error: true,
        }),
      ),
    ]);

    const output = await collect(prepared.adapter.run(prepared.input));

    expect(prepared.query.calls).toHaveLength(2);
    expect(terminalFailure(output)).toMatchObject({
      failure: { reason: "protocol_violation" },
      isolation: "prompt_only",
    });
  });

  it("aborts the SDK controller and closes the query when the review is cancelled", async () => {
    let capturedController: AbortController | undefined;
    const stream: ControlledStream = {
      close: vi.fn(),
      async *[Symbol.asyncIterator]() {
        while (capturedController?.signal.aborted !== true) {
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
      },
    };
    const prepared = setup([stream]);
    const running = collect(prepared.adapter.run(prepared.input));
    await vi.waitFor(() => {
      capturedController = prepared.query.calls[0]?.options.abortController;
      expect(capturedController).toBeInstanceOf(AbortController);
    });

    prepared.controller.abort(new Error("deadline with private detail"));
    const output = await running;

    expect(capturedController!.signal.aborted).toBe(true);
    expect(stream.close).toHaveBeenCalledOnce();
    expect(terminalFailure(output)).toMatchObject({
      failure: { reason: "cancelled" },
    });
    expect(terminalFailure(output)).not.toHaveProperty("isolation");
    expect(JSON.stringify(output)).not.toContain("private detail");
  });

  it("does not start a Claude query when the review is already cancelled", async () => {
    const prepared = setup();
    prepared.controller.abort(new Error("already cancelled"));

    const output = await collect(prepared.adapter.run(prepared.input));

    expect(prepared.query.calls).toHaveLength(0);
    expect(terminalFailure(output)).toMatchObject({
      failure: { reason: "cancelled" },
    });
    expect(terminalFailure(output)).not.toHaveProperty("isolation");
  });

  it("force cleanup aborts the owned controller and closes the active query", async () => {
    let capturedController: AbortController | undefined;
    const stream: ControlledStream = {
      close: vi.fn(),
      async *[Symbol.asyncIterator]() {
        while (capturedController?.signal.aborted !== true) {
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
      },
    };
    const prepared = setup([stream]);
    const running = collect(prepared.adapter.run(prepared.input));
    await vi.waitFor(() => {
      capturedController = prepared.query.calls[0]?.options.abortController;
      expect(capturedController).toBeInstanceOf(AbortController);
    });

    await prepared.adapter.forceCleanup?.();
    const output = await running;

    expect(capturedController!.signal.aborted).toBe(true);
    expect(stream.close).toHaveBeenCalled();
    expect(terminalFailure(output)).toMatchObject({
      failure: { reason: "cancelled" },
    });
    expect(terminalFailure(output)).not.toHaveProperty("isolation");
  });

  it.each(sandboxErrorTokens)(
    "classifies the precise sandbox unavailable token: %s",
    (token) => {
      expect(
        isClaudeSandboxUnavailable(
          errorResult("error_during_execution", [
            `Claude SANDBOX runtime is ${token}.`,
          ]),
        ),
      ).toBe(true);
    },
  );

  it("does not combine sandbox setup tokens across SDK errors array entries", () => {
    expect(
      isClaudeSandboxUnavailable(
        errorResult("error_during_execution", [
          "Sandbox initialization failed.",
          "The runtime is unavailable.",
        ]),
      ),
    ).toBe(false);
  });

  it.each([
    errorResult("error_during_execution", ["authentication unavailable"]),
    errorResult("error_during_execution", ["sandbox authentication failed"]),
    errorResult("error_during_execution", ["model unsupported"]),
    errorResult("error_during_execution", ["API cannot start"]),
    errorResult("error_during_execution", [
      "Sandbox policy enabled",
      "API unavailable",
    ]),
    errorResult("error_during_execution", [
      "sandbox initialized",
      "model unsupported",
    ]),
    errorResult("error_during_execution", [
      "sandbox telemetry",
      "authentication cannot start",
    ]),
    errorResult("error_max_turns", ["sandbox unavailable"]),
    successResult({ errors: ["sandbox unavailable"] }),
    sdkMessage({
      type: "system",
      subtype: "informational",
      content: "sandbox unavailable",
    }),
  ])("rejects near-miss sandbox failure classifications", (message) => {
    expect(isClaudeSandboxUnavailable(message)).toBe(false);
  });

  it("retries prefer_enforced exactly once with the same job prompts and prompt-only disclosure", async () => {
    const sandboxed = messages(
      errorResult("error_during_execution", [
        "Sandbox cannot start because the runtime is unavailable.",
      ]),
    );
    const promptOnly = messages(
      successResult(passResult("Prompt-only Claude review completed.")),
    );
    const prepared = setup([sandboxed, promptOnly]);

    const output = await collect(prepared.adapter.run(prepared.input));

    expect(prepared.query.calls).toHaveLength(2);
    expect(prepared.query.calls.map((call) => call.prompt)).toEqual([
      prepared.prompt.user,
      prepared.prompt.user,
    ]);
    expect(
      prepared.query.calls.map((call) => call.options.systemPrompt),
    ).toEqual([prepared.prompt.system, prepared.prompt.system]);
    expect(prepared.query.calls[1]!.options).toMatchObject({
      cwd: prepared.context.workspace,
      model: prepared.reviewer.model,
      tools: ["Read", "Glob", "Grep", "Bash"],
      sandbox: { enabled: false },
    });
    expect(prepared.query.calls[1]!.options.sandbox).toEqual({
      enabled: false,
    });
    expect(sandboxed.close).toHaveBeenCalledBefore(promptOnly.close);
    const fallbackPermission = prepared.query.calls[1]!.options.canUseTool!;
    await expect(
      fallbackPermission("Bash", {}, permissionContext()),
    ).resolves.toEqual({ behavior: "allow" });
    await expect(
      fallbackPermission("Write", {}, permissionContext()),
    ).resolves.toMatchObject({ behavior: "deny" });
    expect(terminalResult(output)).toMatchObject({ isolation: "prompt_only" });
  });

  it("does not retry require_enforced when sandbox setup is unavailable", async () => {
    const sandboxed = messages(
      errorResult("error_during_execution", ["Sandbox is unsupported."]),
    );
    const prepared = setup([sandboxed], {
      isolationPolicy: "require_enforced",
    });

    const output = await collect(prepared.adapter.run(prepared.input));

    expect(prepared.query.calls).toHaveLength(1);
    expect(sandboxed.close).toHaveBeenCalledOnce();
    expect(terminalFailure(output)).toMatchObject({
      failure: { reason: "adapter_unavailable", retryable: false },
    });
    expect(terminalFailure(output)).not.toHaveProperty("isolation");
  });

  it("omits prompt-only isolation when the fallback query throws before it starts", async () => {
    const calls: QueryCall[] = [];
    const sandboxed = messages(
      errorResult("error_during_execution", ["Sandbox is unavailable."]),
    );
    const query: ClaudeQueryFacade = (input) => {
      calls.push(input);
      if (calls.length === 1) return sandboxed;
      throw new Error("fallback did not start");
    };
    const prepared = setup([], { query });

    const output = await collect(prepared.adapter.run(prepared.input));

    expect(calls).toHaveLength(2);
    expect(terminalFailure(output)).toMatchObject({
      failure: { reason: "process_crashed" },
    });
    expect(terminalFailure(output)).not.toHaveProperty("isolation");
  });

  it("reports prompt-only isolation after the fallback query starts and then crashes", async () => {
    const sandboxed = messages(
      errorResult("error_during_execution", ["Sandbox is unavailable."]),
    );
    const fallback = throwingStream(new Error("fallback stream crashed"));
    const prepared = setup([sandboxed, fallback]);

    const output = await collect(prepared.adapter.run(prepared.input));

    expect(prepared.query.calls).toHaveLength(2);
    expect(terminalFailure(output)).toMatchObject({
      failure: { reason: "process_crashed" },
      isolation: "prompt_only",
    });
  });

  it("omits prompt-only isolation when the fallback iterator cannot be constructed", async () => {
    const calls: QueryCall[] = [];
    const sandboxed = messages(
      errorResult("error_during_execution", ["Sandbox is unavailable."]),
    );
    const unstartable: AsyncIterable<SDKMessage> = {
      [Symbol.asyncIterator]() {
        throw new Error("iterator construction failed");
      },
    };
    const query: ClaudeQueryFacade = (input) => {
      calls.push(input);
      return calls.length === 1 ? sandboxed : unstartable;
    };
    const prepared = setup([], { query });

    const output = await collect(prepared.adapter.run(prepared.input));

    expect(calls).toHaveLength(2);
    expect(terminalFailure(output)).toMatchObject({
      failure: { reason: "process_crashed" },
    });
    expect(terminalFailure(output)).not.toHaveProperty("isolation");
  });

  it("omits isolation when cancellation lands while closing the sandboxed attempt before fallback starts", async () => {
    const controller = new AbortController();
    const sandboxed = messages(
      errorResult("error_during_execution", ["Sandbox is unavailable."]),
    );
    sandboxed.close.mockImplementation(() =>
      controller.abort(new Error("cancel between attempts")),
    );
    const prepared = setup([sandboxed, messages(successResult(passResult()))]);
    prepared.input = { ...prepared.input, signal: controller.signal };

    const output = await collect(prepared.adapter.run(prepared.input));

    expect(prepared.query.calls).toHaveLength(1);
    expect(terminalFailure(output)).toMatchObject({
      failure: { reason: "cancelled" },
    });
    expect(terminalFailure(output)).not.toHaveProperty("isolation");
  });

  it("never falls back for thrown, API, auth, or model failures that merely mention sandbox", async () => {
    const thrown = setup([
      throwingStream(new Error("sandbox unavailable api_key=private")),
    ]);
    const nearMiss = setup([
      messages(
        errorResult("error_during_execution", [
          "sandbox authentication failed for model access",
        ]),
      ),
    ]);

    const thrownOutput = await collect(thrown.adapter.run(thrown.input));
    const nearMissOutput = await collect(nearMiss.adapter.run(nearMiss.input));

    expect(thrown.query.calls).toHaveLength(1);
    expect(nearMiss.query.calls).toHaveLength(1);
    expect(terminalFailure(thrownOutput)).toMatchObject({
      failure: { reason: "process_crashed" },
    });
    expect(terminalFailure(thrownOutput)).not.toHaveProperty("isolation");
    expect(terminalFailure(nearMissOutput)).toMatchObject({
      failure: { reason: "unknown" },
    });
    expect(terminalFailure(nearMissOutput)).not.toHaveProperty("isolation");
    expect(JSON.stringify(thrownOutput)).not.toContain("private");
  });
});

describe("Claude registry integration", () => {
  it("adds Claude without replacing Codex or an explicitly registered command factory", async () => {
    const registration: AdapterRegistration = {
      type: "command",
      command: "reviewer",
      protocol: "review-mesh-command-v1",
    };
    const commandAdapter: ReviewAdapter = {
      id: "command",
      async probe() {
        return {
          available: true,
          authenticated: true,
          model_available: true,
          streaming: true,
          cancellation: true,
          maximumIsolation: "enforced_read_only",
        };
      },
      async *run() {
        yield {
          type: "result",
          result: passResult(),
          isolation: "enforced_read_only",
        };
      },
    };
    const registry = new AdapterRegistry();
    registry.register("command", () => commandAdapter);

    expect(registry.create("command-main", registration)).toBe(commandAdapter);
    expect(
      registry.create("claude-main", {
        type: "claude",
        env_allowlist: ["ANTHROPIC_API_KEY"],
      }).id,
    ).toBe("claude");
    expect(
      registry.create("codex-main", {
        type: "codex",
        env_allowlist: ["CODEX_API_KEY"],
      }).id,
    ).toBe("codex");
  });
});
