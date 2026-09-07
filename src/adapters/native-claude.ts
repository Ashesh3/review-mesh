import {
  query,
  startup,
  type Options,
  type SDKMessage,
  type WarmQuery,
} from "@anthropic-ai/claude-agent-sdk";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterRegistration } from "../config/schemas.js";
import { resolveSdkRuntime, type SdkRuntime } from "../runtime/sdk-runtime.js";
import { createClaudeProcessOwner } from "../runtime/claude-process.js";
import {
  providerReviewerResultV4Schema,
  adjudicationResultV2Schema,
} from "../protocol/v9.js";
import { adapterFailure, sanitizePublicText } from "./errors.js";
import {
  buildAllowlistedEnvironment,
  type ReviewAdapter,
  type AdapterEvent,
  type AdapterReviewInput,
} from "./types.js";

interface Dependencies {
  environment?: NodeJS.ProcessEnv;
  runtime?: () => SdkRuntime;
  query?: (input: {
    prompt: string;
    options: Options;
  }) => AsyncIterable<SDKMessage>;
}

async function removeClaudeHome(home: string): Promise<void> {
  // Bun's Windows fs.rm currently ignores Node's maxRetries/retryDelay.
  // Retain the existing five-retry linear budget after owned processes stop.
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(home, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!["EBUSY", "EPERM"].includes(code ?? "") || attempt >= 5) throw error;
      await new Promise<void>((resolve) =>
        setTimeout(resolve, 100 * (attempt + 1)),
      );
    }
  }
}

function cleanupErrorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && /^E[A-Z0-9_]{1,30}$/.test(code)
    ? code
    : "cleanup_error";
}

function claudeActivityTracker() {
  type Activity = Extract<AdapterEvent, { type: "activity" }>;
  const hash = (value: unknown) =>
    createHash("sha256")
      .update(
        JSON.stringify(value, (_key, nested: unknown) =>
          nested && typeof nested === "object" && !Array.isArray(nested)
            ? Object.fromEntries(
                Object.entries(nested).sort(([a], [b]) => a.localeCompare(b)),
              )
            : nested,
        ),
      )
      .digest("hex");
  const tools = new Map<string, string>();
  const streams = new Map<
    string,
    { identity: string; bytes: number; frames: Set<string> }
  >();
  let compacting: string | undefined;
  let boundary = "initial";
  return (message: SDKMessage): Activity[] => {
    const progress: Activity[] = [];
    const report = (identity: string, text: string, byteCount?: number) => {
      progress.push({
        type: "activity",
        identity,
        message: text,
        ...(byteCount === undefined ? {} : { byteCount }),
      });
    };
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type !== "tool_use") continue;
        const identity = hash({ tool: block.name, input: block.input });
        if (tools.size < 4096 || tools.has(block.id))
          tools.set(block.id, identity);
        report(`claude:tool:${identity}`, "Claude native tool started.");
      }
    } else if (
      message.type === "user" &&
      Array.isArray(message.message.content)
    ) {
      for (const block of message.message.content) {
        if (block.type !== "tool_result" || block.is_error) continue;
        const identity = tools.get(block.tool_use_id);
        if (identity)
          report(
            `claude:tool-result:${identity}`,
            "Claude native tool completed.",
          );
      }
    } else if (message.type === "stream_event") {
      const lane = message.parent_tool_use_id ?? "main";
      const event = message.event;
      if (event.type === "message_start") {
        const identity = `claude:output:${hash(event.message.id)}`;
        if (
          streams.get(lane)?.identity !== identity &&
          (streams.has(lane) || streams.size < 64)
        )
          streams.set(lane, { identity, bytes: 0, frames: new Set() });
      } else if (event.type === "content_block_delta") {
        const stream = streams.get(lane);
        const text =
          event.delta.type === "text_delta"
            ? event.delta.text
            : event.delta.type === "thinking_delta"
              ? event.delta.thinking
              : undefined;
        if (stream && text) {
          // Count content locally; never publish source text or model reasoning.
          if (!stream.frames.has(message.uuid)) {
            if (stream.frames.size >= 4096)
              stream.frames.delete(stream.frames.values().next().value!);
            stream.frames.add(message.uuid);
            stream.bytes = Math.min(
              Number.MAX_SAFE_INTEGER,
              stream.bytes + Buffer.byteLength(text, "utf8"),
            );
          }
          report(stream.identity, "Claude output streaming.", stream.bytes);
        }
      } else if (event.type === "message_stop") streams.delete(lane);
    } else if (
      message.type === "system" &&
      message.subtype === "status" &&
      message.status === "compacting"
    ) {
      compacting ??= hash(boundary);
      report(
        `claude:compaction-start:${compacting}`,
        "Claude context compaction started.",
      );
    } else if (
      message.type === "system" &&
      message.subtype === "compact_boundary"
    ) {
      boundary = hash(message.uuid);
      compacting = undefined;
      report(
        `claude:compaction-complete:${boundary}`,
        "Claude context compaction completed.",
      );
    }
    return progress.length > 0
      ? progress
      : [
          {
            type: "activity",
            message:
              message.type === "system"
                ? "Claude runtime activity."
                : "Claude review activity.",
          },
        ];
  };
}

/** Vendor strict draft-07 validation rejects our host-only UTF-8 annotations. */
function claudeOutputSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(schema, (key, value) =>
      key === "x-review-mesh-min-utf8-bytes" ||
      key === "x-review-mesh-max-utf8-bytes"
        ? undefined
        : value,
    ),
  ) as Record<string, unknown>;
}

export function createNativeClaudeAdapter(
  registration: AdapterRegistration,
  dependencies: Dependencies = {},
): ReviewAdapter {
  if (registration.type !== "claude")
    throw new Error("Expected Claude SDK registration");
  const settings = registration;
  const environment = dependencies.environment ?? process.env;
  const active = new Set<{
    controller: AbortController;
    close?: () => void;
    processes: ReturnType<typeof createClaudeProcessOwner>;
    stop?: () => Promise<void>;
  }>();
  const runtime = dependencies.runtime ?? (() => resolveSdkRuntime("claude"));
  const nativeQuery = dependencies.query ?? query;
  const credentialError =
    "Claude SDK credentials or provider URL are missing or invalid.";
  function selected(
    name: string,
    source: NodeJS.ProcessEnv,
  ): string | undefined {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      throw new Error(credentialError);
    const value = Object.hasOwn(source, name) ? source[name] : undefined;
    return typeof value === "string" && value.trim().length > 0
      ? value
      : undefined;
  }
  function env() {
    const value = buildAllowlistedEnvironment(
      settings.env_allowlist,
      environment,
    );
    const keyName = settings.api_key_env ?? "ANTHROPIC_API_KEY";
    const key = selected(keyName, settings.api_key_env ? environment : value);
    if (settings.api_key_env && !key) throw new Error(credentialError);
    if (key) value.ANTHROPIC_API_KEY = key;
    const baseName = settings.base_url_env ?? "ANTHROPIC_BASE_URL";
    const base = selected(
      baseName,
      settings.base_url_env ? environment : value,
    );
    if (settings.base_url_env && !base) throw new Error(credentialError);
    if (base) {
      let url: URL;
      try {
        url = new URL(base);
      } catch {
        throw new Error(credentialError);
      }
      if (
        !["http:", "https:"].includes(url.protocol) ||
        !url.hostname ||
        url.username ||
        url.password
      )
        throw new Error(credentialError);
      // Configuration accepts the gateway API base shared with Codex/Copilot.
      // Anthropic appends /v1/messages itself; preserve any deployment prefix.
      value.ANTHROPIC_BASE_URL = base.replace(/\/v1\/?$/, "");
    }
    const providerSelected = [
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CODE_USE_FOUNDRY",
    ].some((name) => value[name] === "1" || value[name] === "true");
    if (!key && !providerSelected) throw new Error(credentialError);
    return value;
  }
  const nativeOptions = (
    controller: AbortController,
    environment: NodeJS.ProcessEnv,
  ): Options => ({
    abortController: controller,
    pathToClaudeCodeExecutable: settings.executable ?? runtime().executablePath,
    env: environment,
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: {},
    plugins: [],
    skills: [],
    tools: ["Read", "Glob", "Grep"],
    disallowedTools: [
      "Bash",
      "Edit",
      "Write",
      "NotebookEdit",
      "WebFetch",
      "WebSearch",
      "Task",
    ],
    permissionMode: "dontAsk",
    canUseTool: async (name) =>
      ["Read", "Glob", "Grep"].includes(name)
        ? { behavior: "allow" }
        : { behavior: "deny", message: "Read-only review", interrupt: false },
    persistSession: false,
    sandbox: { enabled: false },
  });
  return {
    id: "claude",
    async probe(reviewer, signal) {
      let available = false,
        message: string | undefined,
        runtimeVersion: string | undefined,
        sdkVersion: string | undefined;
      let runtimeEnvironment: NodeJS.ProcessEnv | undefined;
      try {
        runtimeEnvironment = env();
        const selectedRuntime = runtime();
        runtimeVersion = selectedRuntime.runtimeVersion;
        sdkVersion = selectedRuntime.sdkVersion;
      } catch {
        message =
          "Claude SDK runtime, credentials, or configured provider URL are unavailable.";
      }
      const authenticated = runtimeEnvironment !== undefined;
      if (message) {
        /* Missing runtime remains an honest unavailable outcome. */
      } else if (reviewer.isolationPolicy === "require_enforced")
        message =
          "Claude native tools provide runtime read-only restrictions, not an independently enforced filesystem boundary.";
      else if (!authenticated)
        message =
          "Claude SDK requires an explicitly allowed ANTHROPIC_API_KEY or supported provider credentials.";
      else if (signal.aborted) message = "Claude probe cancelled.";
      else {
        const controller = new AbortController();
        const processes = createClaudeProcessOwner();
        let stopping: Promise<void> | undefined;
        let cancelled = false;
        const stop = () =>
          (stopping ??= (async () => {
            try {
              // Claude's Windows IDE discovery can leave tasklist/findstr
              // grandchildren holding cwd after EOF closes the runtime root.
              // A probe has no review output to drain: stop its tree first.
              await processes.close({ terminateTree: true });
            } finally {
              controller.abort(signal.reason);
            }
          })());
        const cancel = () => {
          cancelled = true;
          return stop();
        };
        const abort = () => {
          // The same promise is awaited below, including cleanup failures.
          void cancel().catch(() => undefined);
        };
        const state = { controller, processes, stop: cancel };
        active.add(state);
        let home: string | undefined;
        let warm: WarmQuery | undefined;
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        try {
          home = await mkdtemp(join(tmpdir(), "review-mesh-claude-probe-"));
          const options = nativeOptions(controller, runtimeEnvironment!);
          options.spawnClaudeCodeProcess = processes.spawn;
          options.env = { ...options.env, CLAUDE_CONFIG_DIR: home };
          options.cwd = home;
          warm = await startup({ options, initializeTimeoutMs: 15000 });
          available = !cancelled;
        } catch {
          message = cancelled
            ? "Claude probe cancelled."
            : "Claude SDK runtime initialization failed.";
        } finally {
          const cleanupFailures: string[] = [];
          let stopped = false;
          try {
            await stop();
            stopped = true;
          } catch (error) {
            cleanupFailures.push(
              `Claude probe process cleanup failed (${cleanupErrorCode(error)}).`,
            );
          }
          try {
            warm?.close();
            await warm?.[Symbol.asyncDispose]();
          } catch (error) {
            cleanupFailures.push(
              `Claude probe SDK cleanup failed (${cleanupErrorCode(error)}).`,
            );
          }
          if (stopped) active.delete(state);
          if (home && stopped) {
            try {
              await removeClaudeHome(home);
            } catch (error) {
              cleanupFailures.push(
                `Claude probe directory cleanup failed (${cleanupErrorCode(error)}).`,
              );
            }
          }
          signal.removeEventListener("abort", abort);
          if (cancelled) {
            available = false;
            message = "Claude probe cancelled.";
          }
          if (cleanupFailures.length > 0) {
            available = false;
            message = [message, ...cleanupFailures].filter(Boolean).join(" ");
          }
        }
      }
      return {
        available,
        authenticated,
        model_available: "unknown",
        streaming: true,
        cancellation: true,
        maximumIsolation: "runtime_read_only",
        observed_file_access: false,
        progress_observable: true,
        ...(runtimeVersion ? { runtime_version: runtimeVersion } : {}),
        ...(sdkVersion ? { sdk_version: sdkVersion } : {}),
        ...(message ? { message } : {}),
      };
    },
    async *run(input: AdapterReviewInput): AsyncIterable<AdapterEvent> {
      if (input.signal.aborted) {
        yield { type: "failure", failure: adapterFailure.cancelled() };
        return;
      }
      if (input.isolationPolicy === "require_enforced") {
        yield {
          type: "failure",
          failure: adapterFailure.unavailable(
            "Claude cannot provide the required external read-only boundary.",
          ),
        };
        return;
      }
      let runtimeEnvironment: NodeJS.ProcessEnv;
      try {
        runtimeEnvironment = env();
      } catch {
        yield {
          type: "failure",
          failure: adapterFailure.unavailable(credentialError),
        };
        return;
      }
      const controller = new AbortController(),
        abort = () => controller.abort(input.signal.reason);
      input.signal.addEventListener("abort", abort, { once: true });
      if (input.signal.aborted) abort();
      const state: {
        controller: AbortController;
        close?: () => void;
        processes: ReturnType<typeof createClaudeProcessOwner>;
      } = { controller, processes: createClaudeProcessOwner() };
      active.add(state);
      let home: string | undefined;
      let stderr = "";
      const redactions = Object.values(runtimeEnvironment).filter(
        (value): value is string =>
          typeof value === "string" && value.length > 0,
      );
      const safe = (value: string) =>
        sanitizePublicText(
          redactions
            .reduce(
              (text, secret) => text.split(secret).join("[redacted]"),
              value,
            )
            .replace(/https?:\/\/[^\s"'<>]+/g, "[redacted-url]"),
          1000,
        ) ?? "";
      const recordFailure = async (error: unknown) => {
        const exception = safe(
          error instanceof Error ? error.message : String(error),
        );
        const provider = safe(stderr);
        const diagnostics = {
          failure_stage: "native_claude",
          exception_name: error instanceof Error ? error.name : "Error",
          exception_message: exception,
          ...(provider ? { provider_error_message: provider } : {}),
        };
        await input.recordDiagnostic?.({
          kind: "adapter_exception",
          diagnostics,
        });
        return diagnostics;
      };
      try {
        home = await mkdtemp(join(tmpdir(), "review-mesh-claude-"));
        const options = nativeOptions(controller, runtimeEnvironment);
        options.stderr = (text) => {
          stderr = `${stderr}${text}`.slice(-8000);
        };
        options.spawnClaudeCodeProcess = (spawnOptions) => {
          const child = state.processes.spawn(spawnOptions);
          // Custom spawn bypasses the SDK's local stderr hook.
          if (
            "stderr" in child &&
            child.stderr &&
            typeof child.stderr === "object" &&
            "on" in child.stderr
          ) {
            (child.stderr as NodeJS.ReadableStream).on(
              "data",
              (chunk: Buffer | string) => options.stderr?.(chunk.toString()),
            );
          }
          return child;
        };
        options.env = { ...options.env, CLAUDE_CONFIG_DIR: home };
        options.cwd = input.context.workspace;
        options.model = input.reviewer.model;
        options.systemPrompt = input.prompt.system;
        options.outputFormat = {
          type: "json_schema",
          schema: claudeOutputSchema(input.resultJsonSchema),
        };
        options.includePartialMessages = true;
        if (input.reviewer.effort)
          options.effort = input.reviewer.effort as NonNullable<
            Options["effort"]
          >;
        const stream = nativeQuery({ prompt: input.prompt.user, options });
        if ("close" in stream && typeof stream.close === "function")
          state.close = () => {
            (stream.close as () => void)();
          };
        let result = false;
        const activity = claudeActivityTracker();
        for await (const message of stream) {
          if (controller.signal.aborted) {
            yield { type: "failure", failure: adapterFailure.cancelled() };
            return;
          }
          if (message.type !== "result") {
            yield* activity(message);
            continue;
          }
          result = true;
          if (message.subtype !== "success" || message.is_error) {
            const detail =
              "errors" in message
                ? message.errors.join("; ")
                : "result" in message
                  ? message.result
                  : "Claude SDK returned a terminal failure.";
            const diagnostics = await recordFailure(new Error(detail));
            yield {
              type: "failure",
              failure: adapterFailure.processCrashed(
                `Claude SDK could not complete the review: ${safe(detail)}`,
                false,
                { diagnostics },
              ),
            };
            return;
          }
          const parsed = (
            input.reviewer.policy?.mode === "adjudication"
              ? adjudicationResultV2Schema
              : providerReviewerResultV4Schema
          ).safeParse(message.structured_output);
          if (!parsed.success) {
            yield {
              type: "failure",
              failure: adapterFailure.invalidResult(
                "Claude completed without a valid structured review.",
              ),
            };
            return;
          }
          yield {
            type: "result",
            result: parsed.data,
            isolation: "runtime_read_only",
          };
          return;
        }
        if (!result)
          yield {
            type: "failure",
            failure: adapterFailure.protocolViolation(
              "Claude SDK ended without completion.",
            ),
          };
      } catch (error) {
        const diagnostics = controller.signal.aborted
          ? undefined
          : await recordFailure(error);
        yield {
          type: "failure",
          failure: controller.signal.aborted
            ? adapterFailure.cancelled()
            : adapterFailure.processCrashed(
                `Claude SDK review failed: ${safe(stderr || (error instanceof Error ? error.message : String(error)))}`,
                false,
                { ...(diagnostics ? { diagnostics } : {}) },
              ),
        };
      } finally {
        input.signal.removeEventListener("abort", abort);
        state.close?.();
        controller.abort();
        await state.processes.close();
        active.delete(state);
        if (home) await removeClaudeHome(home);
      }
    },
    async forceCleanup() {
      await Promise.all(
        [...active].map(async (state) => {
          if (state.stop) {
            await state.stop();
            return;
          }
          state.close?.();
          state.controller.abort();
          await state.processes.close();
        }),
      );
    },
  };
}
