import {
  query,
  startup,
  type Options,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
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
        const controller = new AbortController(),
          abort = () => controller.abort(signal.reason);
        const processes = createClaudeProcessOwner();
        const state = { controller, processes };
        active.add(state);
        let home: string | undefined;
        signal.addEventListener("abort", abort, { once: true });
        try {
          home = await mkdtemp(join(tmpdir(), "review-mesh-claude-probe-"));
          const options = nativeOptions(controller, runtimeEnvironment!);
          options.spawnClaudeCodeProcess = processes.spawn;
          options.env = { ...options.env, CLAUDE_CONFIG_DIR: home };
          options.cwd = home;
          const warm = await startup({ options, initializeTimeoutMs: 15000 });
          warm.close();
          await warm[Symbol.asyncDispose]();
          await processes.close();
          available = true;
        } catch {
          message = "Claude SDK runtime initialization failed.";
        } finally {
          signal.removeEventListener("abort", abort);
          controller.abort();
          await processes.close();
          active.delete(state);
          if (home)
            await rm(home, {
              recursive: true,
              force: true,
              maxRetries: 5,
              retryDelay: 100,
            });
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
        for await (const message of stream) {
          if (controller.signal.aborted) {
            yield { type: "failure", failure: adapterFailure.cancelled() };
            return;
          }
          if (message.type !== "result") {
            yield {
              type: "activity",
              message:
                message.type === "system"
                  ? "Claude runtime activity."
                  : "Claude review activity.",
            };
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
        if (home)
          await rm(home, {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 100,
          });
      }
    },
    async forceCleanup() {
      await Promise.all(
        [...active].map(async (state) => {
          state.close?.();
          state.controller.abort();
          await state.processes.close();
        }),
      );
    },
  };
}
