import {
  query as claudeQuery,
  startup as claudeStartup,
  type Options as ClaudeOptions,
  type PermissionResult,
  type SDKMessage,
  type SDKResultError,
  type SDKResultMessage,
  type WarmQuery,
} from "@anthropic-ai/claude-agent-sdk";
import type { AdapterRegistration } from "../config/schemas.js";
import { reviewerResultV2Schema } from "../protocol/schemas.js";
import { adapterFailure, type AdapterFailure } from "./errors.js";
import {
  buildAllowlistedEnvironment,
  type AdapterCapabilities,
  type AdapterEvent,
  type AdapterReviewInput,
  type ReviewAdapter,
} from "./types.js";

const CLAUDE_AGENT_SDK_VERSION = "0.3.251";
const READ_ONLY_TOOLS = ["Read", "Glob", "Grep"] as const;
const DISALLOWED_TOOLS = [
  "Bash",
  "Edit",
  "Write",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "Task",
] as const;
const INSPECTION_TOOLS = new Set(["Read", "Glob", "Grep"]);
const TOOL_DENIAL = "Review Mesh denied this tool for a read-only review.";
const SANDBOX_UNAVAILABLE =
  /\b(?:unavailable|unsupported|not\s+supported|missing\s+dependencies|cannot\s+start)\b/i;
const THROWN_SANDBOX_UNAVAILABLE =
  /\b(?:unavailable|unsupported|not\s+supported)\b/i;
const SANDBOX_TOKEN = /\bsandbox\b/i;
const CLAUDE_INITIALIZE_TIMEOUT_MS = 15_000;

type ClaudeRegistration = Extract<AdapterRegistration, { type: "claude" }>;

export type ClaudeQueryFacade = (input: {
  prompt: string;
  options: ClaudeOptions;
}) => AsyncIterable<SDKMessage>;

export interface ClaudeAdapterDependencies {
  environment?: NodeJS.ProcessEnv;
  query?: ClaudeQueryFacade;
  startup?: ClaudeRuntimeInitializer;
}

export interface ClaudeWarmQuery {
  query: WarmQuery["query"];
  close(): void;
  [Symbol.asyncDispose](): PromiseLike<void>;
}

export interface ClaudeRuntimeInitializeInput {
  options: ClaudeOptions;
  initializeTimeoutMs: number;
}

export type ClaudeRuntimeInitializer = (
  input: ClaudeRuntimeInitializeInput,
) => Promise<ClaudeWarmQuery>;

interface CloseableQuery extends AsyncIterable<SDKMessage> {
  close?: () => void;
}

interface ActiveQuery {
  controller: AbortController;
  query?: CloseableQuery;
}

interface ActiveProbe {
  cleanup?: Promise<void>;
  cleanupRequested: boolean;
  controller: AbortController;
  lifecycle: Promise<void>;
  resolveLifecycle(): void;
  warmQuery?: ClaudeWarmQuery;
}

type AttemptOutcome =
  | {
      type: "native_result";
      message: SDKResultMessage;
      attemptStarted: true;
    }
  | {
      type: "failure";
      failure: AdapterFailure;
      attemptStarted: boolean;
      sandboxUnavailable?: boolean;
    };

function fixedToolPermission() {
  return async (toolName: string): Promise<PermissionResult> => {
    if (INSPECTION_TOOLS.has(toolName)) {
      return { behavior: "allow" };
    }
    return {
      behavior: "deny",
      message: TOOL_DENIAL,
      interrupt: false,
    };
  };
}

function activityFor(message: SDKMessage): string | undefined {
  if (message.type === "tool_progress") {
    return "Claude is running an inspection tool.";
  }
  if (message.type !== "system") return undefined;
  if (message.subtype === "status") {
    if (message.status === "requesting") {
      return "Claude is requesting a model response.";
    }
    if (message.status === "compacting") {
      return "Claude is compacting review context.";
    }
    return undefined;
  }
  if (
    message.subtype === "task_progress" ||
    message.subtype === "task_started" ||
    message.subtype === "task_updated" ||
    message.subtype === "task_notification"
  ) {
    return "Claude is progressing a review task.";
  }
  return undefined;
}

function closeQuery(query: CloseableQuery | undefined): void {
  try {
    query?.close?.();
  } catch {
    // Cleanup failures are non-authoritative and must not replace the terminal.
  }
}

function resultFailure(message: SDKResultError): AdapterFailure {
  switch (message.subtype) {
    case "error_max_turns":
      return adapterFailure.timeout(
        "Claude exceeded the configured turn limit.",
      );
    case "error_max_structured_output_retries":
      return adapterFailure.invalidResult(
        "Claude could not produce a valid structured reviewer result.",
      );
    case "error_during_execution":
      return adapterFailure.unknown("Claude reported an execution failure.");
    case "error_max_budget_usd":
      return adapterFailure.unknown("Claude exceeded its execution budget.");
    default:
      return adapterFailure.protocolViolation(
        "Claude returned an unsupported terminal result subtype.",
      );
  }
}

function isKnownResultSubtype(
  message: SDKResultMessage,
): message is SDKResultMessage {
  return (
    message.subtype === "success" ||
    message.subtype === "error_during_execution" ||
    message.subtype === "error_max_turns" ||
    message.subtype === "error_max_budget_usd" ||
    message.subtype === "error_max_structured_output_retries"
  );
}

export function isClaudeSandboxUnavailable(message: SDKMessage): boolean {
  if (
    message.type !== "result" ||
    message.subtype !== "error_during_execution"
  ) {
    return false;
  }
  return message.errors.some(
    (error) => SANDBOX_TOKEN.test(error) && SANDBOX_UNAVAILABLE.test(error),
  );
}

function isThrownClaudeSandboxUnavailable(error: unknown): boolean {
  return (
    error instanceof Error &&
    SANDBOX_TOKEN.test(error.message) &&
    THROWN_SANDBOX_UNAVAILABLE.test(error.message)
  );
}

class ClaudeAdapter implements ReviewAdapter {
  readonly id = "claude";
  private readonly environment: NodeJS.ProcessEnv;
  private readonly queryFacade: ClaudeQueryFacade;
  private readonly startup: ClaudeRuntimeInitializer;
  private readonly activeProbes = new Set<ActiveProbe>();
  private readonly activeQueries = new Set<ActiveQuery>();

  constructor(
    private readonly registration: ClaudeRegistration,
    dependencies: ClaudeAdapterDependencies,
  ) {
    this.environment = dependencies.environment ?? process.env;
    this.queryFacade =
      dependencies.query ??
      ((input) =>
        claudeQuery({ prompt: input.prompt, options: input.options }));
    this.startup =
      dependencies.startup ??
      ((input) =>
        claudeStartup({
          options: input.options,
          initializeTimeoutMs: input.initializeTimeoutMs,
        }));
  }

  private probeOptions(abortController: AbortController): ClaudeOptions {
    return {
      abortController,
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {},
      plugins: [],
      skills: [],
      tools: [...READ_ONLY_TOOLS],
      disallowedTools: [...DISALLOWED_TOOLS],
      permissionMode: "dontAsk",
      canUseTool: fixedToolPermission(),
      persistSession: false,
      env: buildAllowlistedEnvironment(
        this.registration.env_allowlist,
        this.environment,
      ),
      ...(this.registration.executable === undefined
        ? {}
        : { pathToClaudeCodeExecutable: this.registration.executable }),
    };
  }

  private async closeWarmQuery(warmQuery: ClaudeWarmQuery): Promise<void> {
    try {
      warmQuery.close();
    } catch {
      // Continue into async disposal so the owned process can still be joined.
    }
    try {
      await warmQuery[Symbol.asyncDispose]();
    } catch {
      // Probe cleanup failures never expose provider or process diagnostics.
    }
  }

  private cleanupProbe(active: ActiveProbe): Promise<void> | undefined {
    if (active.cleanup !== undefined) return active.cleanup;
    if (active.warmQuery === undefined) return undefined;
    const warmQuery = active.warmQuery;
    const cleanup = Promise.resolve().then(() =>
      this.closeWarmQuery(warmQuery),
    );
    active.cleanup = cleanup;
    return cleanup;
  }

  async probe(
    _reviewer: AdapterReviewInput["reviewer"],
    signal: AbortSignal,
  ): Promise<AdapterCapabilities> {
    const capabilities = (
      available: boolean,
      message?: string,
    ): AdapterCapabilities => ({
      available,
      authenticated: "unknown",
      model_available: "unknown",
      streaming: true,
      cancellation: true,
      maximumIsolation: "unknown",
      runtime_version: CLAUDE_AGENT_SDK_VERSION,
      ...(message === undefined ? {} : { message }),
    });
    if (signal.aborted) {
      return capabilities(false, "Claude probing was cancelled.");
    }
    let resolveLifecycle!: () => void;
    const lifecycle = new Promise<void>((resolve) => {
      resolveLifecycle = resolve;
    });
    const active: ActiveProbe = {
      cleanupRequested: false,
      controller: new AbortController(),
      lifecycle,
      resolveLifecycle,
    };
    const abort = () => active.controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    this.activeProbes.add(active);
    let initialized = false;
    try {
      const warmQuery = await this.startup({
        options: this.probeOptions(active.controller),
        initializeTimeoutMs: CLAUDE_INITIALIZE_TIMEOUT_MS,
      });
      active.warmQuery = warmQuery;
      initialized = !active.controller.signal.aborted;
      await this.cleanupProbe(active);
    } catch {
      initialized = false;
    } finally {
      active.controller.abort();
      await this.cleanupProbe(active);
      signal.removeEventListener("abort", abort);
      this.activeProbes.delete(active);
      active.resolveLifecycle();
    }
    if (signal.aborted) {
      return capabilities(false, "Claude probing was cancelled.");
    }
    if (active.cleanupRequested) {
      return capabilities(false, "Claude runtime initialization failed.");
    }
    return initialized
      ? capabilities(true)
      : capabilities(false, "Claude runtime initialization failed.");
  }

  private optionsFor(
    input: AdapterReviewInput,
    abortController: AbortController,
    sandboxed: boolean,
  ): ClaudeOptions {
    const options: ClaudeOptions = {
      cwd: input.context.workspace,
      model: input.reviewer.model,
      ...(input.reviewer.effort === undefined
        ? {}
        : {
            effort: input.reviewer.effort as NonNullable<
              ClaudeOptions["effort"]
            >,
          }),
      abortController,
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: {},
      plugins: [],
      skills: [],
      tools: [...READ_ONLY_TOOLS],
      disallowedTools: [...DISALLOWED_TOOLS],
      permissionMode: "dontAsk",
      canUseTool: fixedToolPermission(),
      systemPrompt: input.prompt.system,
      outputFormat: {
        type: "json_schema",
        schema: input.resultJsonSchema,
      },
      persistSession: false,
      env: buildAllowlistedEnvironment(
        this.registration.env_allowlist,
        this.environment,
      ),
      sandbox: sandboxed
        ? {
            enabled: true,
            failIfUnavailable: true,
            autoAllowBashIfSandboxed: false,
            allowUnsandboxedCommands: false,
            filesystem: { denyWrite: [input.context.workspace] },
            network: { allowedDomains: [], strictAllowlist: true },
          }
        : { enabled: false },
      ...(this.registration.executable === undefined
        ? {}
        : { pathToClaudeCodeExecutable: this.registration.executable }),
    };
    if (!sandboxed) options.canUseTool = fixedToolPermission();
    return options;
  }

  private async *runAttempt(
    input: AdapterReviewInput,
    active: ActiveQuery,
    sandboxed: boolean,
  ): AsyncGenerator<AdapterEvent, AttemptOutcome> {
    if (active.controller.signal.aborted || input.signal.aborted) {
      return {
        type: "failure",
        failure: adapterFailure.cancelled(),
        attemptStarted: false,
      };
    }

    let terminal: SDKResultMessage | undefined;
    let attemptStarted = false;
    try {
      const nativeQuery = this.queryFacade({
        prompt: input.prompt.user,
        options: this.optionsFor(input, active.controller, sandboxed),
      }) as CloseableQuery;
      active.query = nativeQuery;
      const iterator = nativeQuery[Symbol.asyncIterator]();
      attemptStarted = true;
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        const message = next.value;
        if (active.controller.signal.aborted || input.signal.aborted) {
          return {
            type: "failure",
            failure: adapterFailure.cancelled(),
            attemptStarted,
          };
        }
        if (message.type === "result") {
          if (terminal !== undefined) {
            return {
              type: "failure",
              failure: adapterFailure.protocolViolation(
                "Claude emitted more than one terminal SDK result.",
              ),
              attemptStarted,
            };
          }
          terminal = message;
          continue;
        }
        if (terminal !== undefined) continue;
        const activity = activityFor(message);
        if (activity !== undefined) {
          yield { type: "activity", message: activity };
        }
      }

      if (active.controller.signal.aborted || input.signal.aborted) {
        return {
          type: "failure",
          failure: adapterFailure.cancelled(),
          attemptStarted,
        };
      }
      if (terminal === undefined) {
        return {
          type: "failure",
          failure: adapterFailure.protocolViolation(
            "The Claude SDK stream ended without a terminal result.",
          ),
          attemptStarted,
        };
      }
      return { type: "native_result", message: terminal, attemptStarted: true };
    } catch (error) {
      const cancelled =
        active.controller.signal.aborted || input.signal.aborted;
      return {
        type: "failure",
        failure: cancelled
          ? adapterFailure.cancelled()
          : adapterFailure.processCrashed("The Claude SDK stream failed."),
        attemptStarted,
        ...(!cancelled && sandboxed && isThrownClaudeSandboxUnavailable(error)
          ? { sandboxUnavailable: true }
          : {}),
      };
    } finally {
      closeQuery(active.query);
      delete active.query;
    }
  }

  private async *consumeAttempt(
    input: AdapterReviewInput,
    active: ActiveQuery,
    sandboxed: boolean,
  ): AsyncGenerator<AdapterEvent, AttemptOutcome> {
    const iterator = this.runAttempt(input, active, sandboxed);
    for (;;) {
      const next = await iterator.next();
      if (next.done) return next.value;
      yield next.value;
    }
  }

  async *run(input: AdapterReviewInput): AsyncIterable<AdapterEvent> {
    if (input.signal.aborted) {
      yield { type: "failure", failure: adapterFailure.cancelled() };
      return;
    }

    const active: ActiveQuery = { controller: new AbortController() };
    const abort = () => active.controller.abort(input.signal.reason);
    input.signal.addEventListener("abort", abort, { once: true });
    this.activeQueries.add(active);
    try {
      let sandboxed = true;
      for (;;) {
        const attempt = this.consumeAttempt(input, active, sandboxed);
        let outcome: AttemptOutcome;
        for (;;) {
          const next = await attempt.next();
          if (next.done) {
            outcome = next.value;
            break;
          }
          yield next.value;
        }

        if (outcome.type === "failure") {
          if (outcome.sandboxUnavailable === true) {
            if (input.isolationPolicy === "require_enforced") {
              yield {
                type: "failure",
                failure: adapterFailure.unavailable(
                  "The Claude sandbox is unavailable for an enforced review.",
                ),
              };
              return;
            }
            sandboxed = false;
            continue;
          }
          yield {
            type: "failure",
            failure: outcome.failure,
            ...(!sandboxed && outcome.attemptStarted
              ? { isolation: "prompt_only" as const }
              : {}),
          };
          return;
        }

        const message = outcome.message;
        if (!isKnownResultSubtype(message)) {
          yield {
            type: "failure",
            failure: adapterFailure.protocolViolation(
              "Claude returned an unsupported terminal result subtype.",
            ),
            ...(!sandboxed ? { isolation: "prompt_only" as const } : {}),
          };
          return;
        }
        if (isClaudeSandboxUnavailable(message)) {
          if (input.isolationPolicy === "require_enforced") {
            yield {
              type: "failure",
              failure: adapterFailure.unavailable(
                "The Claude sandbox is unavailable for an enforced review.",
              ),
            };
            return;
          }
          if (sandboxed) {
            sandboxed = false;
            continue;
          }
        }

        if (message.subtype !== "success" || message.is_error) {
          yield {
            type: "failure",
            failure:
              message.subtype === "success"
                ? adapterFailure.unknown(
                    "Claude returned an unsuccessful result.",
                  )
                : resultFailure(message),
            ...(!sandboxed ? { isolation: "prompt_only" as const } : {}),
          };
          return;
        }

        if (message.structured_output === undefined) {
          yield {
            type: "failure",
            failure: adapterFailure.invalidResult(
              "Claude completed without structured reviewer output.",
            ),
            ...(!sandboxed ? { isolation: "prompt_only" as const } : {}),
          };
          return;
        }
        const parsed = reviewerResultV2Schema.safeParse(
          message.structured_output,
        );
        if (!parsed.success) {
          yield {
            type: "failure",
            failure: adapterFailure.invalidResult(
              "Claude returned an invalid structured reviewer result.",
            ),
            ...(!sandboxed ? { isolation: "prompt_only" as const } : {}),
          };
          return;
        }
        yield {
          type: "result",
          result: parsed.data,
          isolation: sandboxed ? "enforced_read_only" : "prompt_only",
        };
        return;
      }
    } finally {
      input.signal.removeEventListener("abort", abort);
      closeQuery(active.query);
      active.controller.abort();
      this.activeQueries.delete(active);
    }
  }

  async forceCleanup(): Promise<void> {
    await Promise.all(
      [...this.activeProbes].map(async (active) => {
        active.cleanupRequested = true;
        active.controller.abort();
        await this.cleanupProbe(active);
        await active.lifecycle;
      }),
    );
    for (const active of this.activeQueries) {
      active.controller.abort();
      closeQuery(active.query);
    }
  }
}

export function createClaudeAdapter(
  registration: AdapterRegistration,
  dependencies: ClaudeAdapterDependencies = {},
): ReviewAdapter {
  if (registration.type !== "claude") {
    throw new Error("createClaudeAdapter requires a Claude registration");
  }
  return new ClaudeAdapter(registration, dependencies);
}
