import { dirname, join } from "node:path";
import type { AdapterRegistration } from "../config/schemas.js";
import { getAppPaths } from "../config/paths.js";
import {
  loadCopilotSdkModule,
  resolveCopilotRuntimePath,
} from "../copilot/runtime.js";
import { reviewerResultSchema } from "../protocol/schemas.js";
import { adapterFailure } from "./errors.js";
import {
  buildAllowlistedEnvironment,
  type AdapterCapabilities,
  type AdapterEvent,
  type AdapterReviewInput,
  type ReviewAdapter,
} from "./types.js";

const COPILOT_SDK_VERSION = "1.0.11";
const READ_ONLY_TOOLS = ["view", "grep", "glob"];
const SHELL_TOOLS = ["powershell", "bash"];
const EXCLUDED_WRITE_TOOLS = [
  "edit",
  "create",
  "str_replace_editor",
  "apply_patch",
];
const PERMISSION_DENIAL =
  "Review Mesh denied this permission for a read-only review.";
const ENFORCED_ISOLATION_FAILURE =
  "Copilot does not establish the required independently enforced read-only filesystem boundary.";

type CopilotRegistration = Extract<AdapterRegistration, { type: "copilot" }>;

export interface CopilotClientOptions {
  mode: "empty";
  baseDirectory: string;
  logLevel: "error";
  env: Record<string, string | undefined>;
  useLoggedInUser: boolean;
}

export interface CopilotStatus {
  version: string;
  protocolVersion: number;
}

export interface CopilotAuthStatus {
  isAuthenticated: boolean;
  authType?: "user" | "env" | "gh-cli" | "hmac" | "api-key" | "token";
  host?: string;
  login?: string;
  statusMessage?: string;
}

export interface CopilotModelInfo {
  id: string;
  name: string;
  capabilities: {
    supports?: { reasoningEffort?: boolean; [key: string]: unknown };
    [key: string]: unknown;
  };
  policy?: { state: "enabled" | "disabled" | "unconfigured" };
  supportedReasoningEfforts?: string[];
  defaultReasoningEffort?: string;
}

export type CopilotPermissionRequest = {
  kind:
    | "read"
    | "write"
    | "shell"
    | "memory"
    | "hook"
    | "mcp"
    | "custom-tool"
    | "url"
    | "extension-management"
    | "factory"
    | "extension-permission-access";
  managedApprovalRequired?: boolean;
};

export type CopilotPermissionResult =
  | { kind: "approve-once"; approvedInteractively?: boolean }
  | { kind: "reject"; feedback?: string };

export type CopilotPermissionHandler = (
  request: CopilotPermissionRequest,
  invocation: { sessionId: string; managedSettingsEnabled?: boolean },
) => CopilotPermissionResult | Promise<CopilotPermissionResult>;

export interface CopilotSessionEvent {
  type: string;
  data?: { content?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface CopilotAssistantMessage extends CopilotSessionEvent {
  type: "assistant.message";
  data: { content: string; [key: string]: unknown };
}

export interface CopilotSessionConfig {
  model: string;
  reasoningEffort?: string;
  workingDirectory: string;
  streaming: true;
  systemMessage: { mode: "append"; content: string };
  enableConfigDiscovery: false;
  enableOnDemandInstructionDiscovery: false;
  enableFileHooks: false;
  enableSkills: false;
  enableSessionStore: false;
  enableHostGitOperations: false;
  availableTools: string[];
  excludedTools: string[];
  mcpServers: Record<string, never>;
  pluginDirectories: string[];
  instructionDirectories: string[];
  remoteSession: "off";
  onPermissionRequest: CopilotPermissionHandler;
  onEvent: (event: CopilotSessionEvent) => void;
}

export interface CopilotSessionFacade {
  on(handler: (event: CopilotSessionEvent) => void): () => void;
  sendAndWait(
    options: { prompt: string; agentMode: "interactive" },
    timeout?: number,
  ): Promise<CopilotAssistantMessage | undefined>;
  abort(): Promise<void>;
  close(): Promise<void>;
}

export interface CopilotClientFacade {
  start(): Promise<void>;
  getStatus(): Promise<CopilotStatus>;
  getAuthStatus(): Promise<CopilotAuthStatus>;
  listModels(): Promise<CopilotModelInfo[]>;
  createSession(config: CopilotSessionConfig): Promise<CopilotSessionFacade>;
  stop(): Promise<void>;
  forceStop(): Promise<void>;
}

export type CopilotClientFactory = (
  options: CopilotClientOptions,
) => CopilotClientFacade;

export interface CopilotAdapterDependencies {
  applicationDataDirectory?: string;
  environment?: NodeJS.ProcessEnv;
  createClient?: CopilotClientFactory;
}

interface ActiveClient {
  client: CopilotClientFacade;
  session?: CopilotSessionFacade;
  cleanup?: Promise<void>;
  forceCleanup?: Promise<void>;
  forceCleanupRequested: boolean;
  lifecycle: Promise<void>;
  resolveLifecycle(): void;
}

class EventQueue<T> {
  private readonly values: T[] = [];
  private waiter?: (value: T | undefined) => void;
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiter;
    if (waiter === undefined) {
      this.values.push(value);
      return;
    }
    delete this.waiter;
    waiter(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const waiter = this.waiter;
    if (waiter !== undefined) {
      delete this.waiter;
      waiter(undefined);
    }
  }

  async next(): Promise<T | undefined> {
    const value = this.values.shift();
    if (value !== undefined) return value;
    if (this.closed) return undefined;
    return new Promise<T | undefined>((resolve) => {
      this.waiter = resolve;
    });
  }
}

interface NativeCopilotSession {
  on(handler: (event: CopilotSessionEvent) => void): () => void;
  sendAndWait(
    options: { prompt: string; agentMode: "interactive" },
    timeout?: number,
  ): Promise<CopilotAssistantMessage | undefined>;
  abort(): Promise<void>;
  disconnect(): Promise<void>;
}

interface NativeCopilotClient {
  start(): Promise<void>;
  getStatus(): Promise<CopilotStatus>;
  getAuthStatus(): Promise<CopilotAuthStatus>;
  listModels(): Promise<CopilotModelInfo[]>;
  createSession(config: CopilotSessionConfig): Promise<NativeCopilotSession>;
  stop(): Promise<Error[]>;
  forceStop(): Promise<void>;
}

interface CopilotSdkModule {
  CopilotClient: new (options: CopilotClientOptions) => NativeCopilotClient;
}

class CopilotClientSdkFacade implements CopilotClientFacade {
  constructor(private readonly client: NativeCopilotClient) {}

  start(): Promise<void> {
    return this.client.start();
  }

  getStatus(): Promise<CopilotStatus> {
    return this.client.getStatus();
  }

  getAuthStatus(): Promise<CopilotAuthStatus> {
    return this.client.getAuthStatus();
  }

  listModels(): Promise<CopilotModelInfo[]> {
    return this.client.listModels();
  }

  async createSession(
    config: CopilotSessionConfig,
  ): Promise<CopilotSessionFacade> {
    const session = await this.client.createSession(config);
    return {
      on: (handler) => session.on(handler),
      sendAndWait: (options, timeout) => session.sendAndWait(options, timeout),
      abort: () => session.abort(),
      close: () => session.disconnect(),
    };
  }

  async stop(): Promise<void> {
    const errors = await this.client.stop();
    if (errors.length > 0) {
      throw new Error("The Copilot SDK reported incomplete cleanup.");
    }
  }

  forceStop(): Promise<void> {
    return this.client.forceStop();
  }
}

export function createCopilotClientFacade(
  options: CopilotClientOptions,
): CopilotClientFacade {
  const runtimePath = resolveCopilotRuntimePath(options.env);
  const configuredOptions =
    runtimePath === undefined
      ? options
      : {
          ...options,
          env: { ...options.env, COPILOT_CLI_PATH: runtimePath },
        };
  const module = loadCopilotSdkModule() as CopilotSdkModule;
  return new CopilotClientSdkFacade(
    new module.CopilotClient(configuredOptions),
  );
}

function definedEnvironment(
  environment: NodeJS.ProcessEnv,
): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

function safeErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  return error.message.trim().length === 0 ? fallback : error.message;
}

function allowsShellPromptOnly(input: AdapterReviewInput): boolean {
  return input.reviewer.runtime.allow_shell_prompt_only === true;
}

function permissionHandler(allowShell: boolean): CopilotPermissionHandler {
  return (request): CopilotPermissionResult => {
    if (request.managedApprovalRequired === true) {
      return { kind: "reject", feedback: PERMISSION_DENIAL };
    }
    if (request.kind === "read" || (allowShell && request.kind === "shell")) {
      return { kind: "approve-once" };
    }
    return { kind: "reject", feedback: PERMISSION_DENIAL };
  };
}

function eventSummary(event: CopilotSessionEvent): AdapterEvent | undefined {
  switch (event.type) {
    case "assistant.turn_start":
      return {
        type: "progress",
        phase: "reviewing",
        message: "Copilot started the review turn.",
      };
    case "tool.execution_start":
      return {
        type: "activity",
        message: "Copilot started an inspection tool.",
      };
    case "tool.execution_complete":
      return {
        type: "activity",
        message: "Copilot completed an inspection tool.",
      };
    case "assistant.message":
      return {
        type: "activity",
        message: "Copilot produced a response message.",
      };
    case "session.idle":
    case "assistant.turn_end":
      return {
        type: "progress",
        phase: "validating",
        message: "Copilot completed the review turn.",
      };
    default:
      return undefined;
  }
}

function failureCapabilities(message: string): AdapterCapabilities {
  return {
    available: false,
    authenticated: "unknown",
    model_available: "unknown",
    streaming: true,
    cancellation: true,
    maximumIsolation: "prompt_only",
    runtime_version: COPILOT_SDK_VERSION,
    message,
  };
}

function selectableModel(model: CopilotModelInfo): boolean {
  return model.policy === undefined || model.policy.state === "enabled";
}

function modelReadiness(
  models: readonly CopilotModelInfo[],
  modelId: string,
  effort: string | undefined,
): { available: boolean; message?: string } {
  const model = models.find((candidate) => candidate.id === modelId);
  if (model === undefined || !selectableModel(model)) {
    return {
      available: false,
      message: `The configured Copilot model ${modelId} is unavailable.`,
    };
  }
  if (effort === undefined) return { available: true };
  if (model.capabilities.supports?.reasoningEffort !== true) {
    return {
      available: false,
      message: `The configured Copilot model ${modelId} does not support reasoning effort.`,
    };
  }
  if (
    model.supportedReasoningEfforts !== undefined &&
    !model.supportedReasoningEfforts.includes(effort)
  ) {
    return {
      available: false,
      message: `The configured Copilot model ${modelId} does not support effort ${effort}.`,
    };
  }
  return { available: true };
}

class CopilotAdapter implements ReviewAdapter {
  readonly id = "copilot";
  private readonly applicationDataDirectory: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly createClient: CopilotClientFactory;
  private readonly activeClients = new Set<ActiveClient>();

  constructor(
    private readonly registration: CopilotRegistration,
    dependencies: CopilotAdapterDependencies,
  ) {
    this.applicationDataDirectory =
      dependencies.applicationDataDirectory ??
      dirname(getAppPaths().runsDirectory);
    this.environment = dependencies.environment ?? process.env;
    this.createClient = dependencies.createClient ?? createCopilotClientFacade;
  }

  private createRuntimeClient(): ActiveClient {
    const env = definedEnvironment(
      buildAllowlistedEnvironment(
        this.registration.env_allowlist,
        this.environment,
      ),
    );
    const client = this.createClient({
      mode: "empty",
      baseDirectory: join(this.applicationDataDirectory, "runtime", "copilot"),
      logLevel: "error",
      env,
      useLoggedInUser: this.registration.use_logged_in_user ?? true,
    });
    let resolveLifecycle!: () => void;
    const lifecycle = new Promise<void>((resolve) => {
      resolveLifecycle = resolve;
    });
    const active: ActiveClient = {
      client,
      forceCleanupRequested: false,
      lifecycle,
      resolveLifecycle,
    };
    this.activeClients.add(active);
    return active;
  }

  private cleanup(active: ActiveClient): Promise<void> {
    if (active.cleanup !== undefined) return active.cleanup;
    if (active.forceCleanupRequested) return Promise.resolve();
    const cleanup = (async () => {
      let cleaned = true;
      try {
        await active.session?.close();
      } catch {
        // Best-effort session cleanup must not replace the review terminal.
        cleaned = false;
      }
      try {
        await active.client.stop();
      } catch {
        // The orchestrator can escalate through forceCleanup after its grace.
        cleaned = false;
      }
      if (cleaned && !active.forceCleanupRequested) {
        this.activeClients.delete(active);
      }
    })();
    active.cleanup = cleanup;
    return cleanup;
  }

  async probe(
    reviewer: AdapterReviewInput["reviewer"],
    signal: AbortSignal,
  ): Promise<AdapterCapabilities> {
    if (reviewer.isolationPolicy === "require_enforced") {
      return failureCapabilities(ENFORCED_ISOLATION_FAILURE);
    }
    if (signal.aborted) {
      return failureCapabilities("Copilot probing was cancelled.");
    }

    const active = this.createRuntimeClient();
    try {
      await active.client.start();
      if (active.forceCleanupRequested) {
        return failureCapabilities("Copilot probing was cancelled.");
      }
      const [status, auth, models] = await Promise.all([
        active.client.getStatus(),
        active.client.getAuthStatus(),
        active.client.listModels(),
      ]);
      const readiness = modelReadiness(models, reviewer.model, reviewer.effort);
      const available = auth.isAuthenticated && readiness.available;
      return {
        available,
        authenticated: auth.isAuthenticated,
        model_available: readiness.available,
        streaming: true,
        cancellation: true,
        maximumIsolation: "prompt_only",
        runtime_version: status.version,
        ...(!auth.isAuthenticated
          ? { message: "Copilot authentication is unavailable." }
          : !readiness.available
            ? { message: readiness.message }
            : {}),
      };
    } catch (error) {
      return failureCapabilities(
        adapterFailure.unavailable(
          safeErrorMessage(error, "The Copilot SDK probe failed."),
        ).message,
      );
    } finally {
      await this.cleanup(active);
      active.resolveLifecycle();
    }
  }

  async *run(input: AdapterReviewInput): AsyncIterable<AdapterEvent> {
    if (input.isolationPolicy === "require_enforced") {
      yield {
        type: "failure",
        failure: adapterFailure.unavailable(ENFORCED_ISOLATION_FAILURE),
      };
      return;
    }
    if (input.signal.aborted) {
      yield { type: "failure", failure: adapterFailure.cancelled() };
      return;
    }

    const allowShell = allowsShellPromptOnly(input);
    const isolation = allowShell ? "prompt_only" : "runtime_read_only";
    const active = this.createRuntimeClient();
    const nativeEvents = new EventQueue<AdapterEvent>();
    let sessionFailure = false;
    let deniedPermission = false;
    let abortPromise: Promise<void> | undefined;
    const onPermissionRequest = permissionHandler(allowShell);
    const guardedPermissionHandler: CopilotPermissionHandler = async (
      request,
      invocation,
    ) => {
      const decision = await onPermissionRequest(request, invocation);
      if (decision.kind === "reject") deniedPermission = true;
      return decision;
    };
    const onEvent = (event: CopilotSessionEvent): void => {
      if (event.type === "session.error") sessionFailure = true;
      const summary = eventSummary(event);
      if (summary !== undefined) nativeEvents.push(summary);
    };
    const abort = (): void => {
      abortPromise ??= active.session?.abort().catch(() => undefined);
    };
    input.signal.addEventListener("abort", abort, { once: true });

    try {
      await active.client.start();
      if (input.signal.aborted || active.forceCleanupRequested) {
        yield {
          type: "failure",
          failure: input.signal.aborted
            ? adapterFailure.cancelled()
            : adapterFailure.processCrashed(
                "The Copilot SDK session was forcefully stopped.",
              ),
          isolation,
        };
        return;
      }
      active.session = await active.client.createSession({
        model: input.reviewer.model,
        ...(input.reviewer.effort === undefined
          ? {}
          : { reasoningEffort: input.reviewer.effort }),
        workingDirectory: input.context.workspace,
        streaming: true,
        systemMessage: { mode: "append", content: input.prompt.system },
        enableConfigDiscovery: false,
        enableOnDemandInstructionDiscovery: false,
        enableFileHooks: false,
        enableSkills: false,
        enableSessionStore: false,
        enableHostGitOperations: false,
        availableTools: allowShell
          ? [...READ_ONLY_TOOLS, ...SHELL_TOOLS]
          : [...READ_ONLY_TOOLS],
        excludedTools: [...EXCLUDED_WRITE_TOOLS],
        mcpServers: {},
        pluginDirectories: [],
        instructionDirectories: [],
        remoteSession: "off",
        onPermissionRequest: guardedPermissionHandler,
        onEvent,
      });
      if (input.signal.aborted || active.forceCleanupRequested) {
        abort();
        yield {
          type: "failure",
          failure: input.signal.aborted
            ? adapterFailure.cancelled()
            : adapterFailure.processCrashed(
                "The Copilot SDK session was forcefully stopped.",
              ),
          isolation,
        };
        return;
      }
      const terminal = active.session
        .sendAndWait(
          { prompt: input.prompt.user, agentMode: "interactive" },
          input.reviewer.timeoutMs,
        )
        .then(
          (message) => ({ ok: true as const, message }),
          (error: unknown) => ({ ok: false as const, error }),
        )
        .finally(() => nativeEvents.close());
      for (;;) {
        const event = await nativeEvents.next();
        if (event === undefined) break;
        yield event;
      }
      const outcome = await terminal;
      if (!outcome.ok) throw outcome.error;
      const finalMessage = outcome.message;

      if (input.signal.aborted) {
        yield {
          type: "failure",
          failure: adapterFailure.cancelled(),
          isolation,
        };
        return;
      }
      if (sessionFailure) {
        yield {
          type: "failure",
          failure: adapterFailure.processCrashed(
            "The Copilot session reported an error.",
          ),
          isolation,
        };
        return;
      }
      if (finalMessage === undefined) {
        yield {
          type: "failure",
          failure: deniedPermission
            ? adapterFailure.protocolViolation(
                "Copilot could not complete because a denied permission was required.",
              )
            : adapterFailure.invalidResult(
                "Copilot completed without a final assistant result message.",
              ),
          isolation,
        };
        return;
      }

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(finalMessage.data.content);
      } catch {
        yield {
          type: "failure",
          failure: adapterFailure.invalidResult(
            "Copilot returned malformed JSON for the reviewer result.",
          ),
          isolation,
        };
        return;
      }
      const parsedResult = reviewerResultSchema.safeParse(parsedJson);
      if (!parsedResult.success) {
        yield {
          type: "failure",
          failure: adapterFailure.invalidResult(
            "Copilot returned an invalid reviewer result.",
          ),
          isolation,
        };
        return;
      }
      yield { type: "result", result: parsedResult.data, isolation };
    } catch (error) {
      yield {
        type: "failure",
        failure: input.signal.aborted
          ? adapterFailure.cancelled()
          : deniedPermission
            ? adapterFailure.protocolViolation(
                "Copilot could not complete because a denied permission was required.",
              )
            : adapterFailure.processCrashed(
                safeErrorMessage(error, "The Copilot SDK session failed."),
              ),
        isolation,
      };
    } finally {
      input.signal.removeEventListener("abort", abort);
      await abortPromise;
      await this.cleanup(active);
      active.resolveLifecycle();
    }
  }

  async forceCleanup(): Promise<void> {
    await Promise.all(
      [...this.activeClients].map((active) => {
        if (active.forceCleanup !== undefined) return active.forceCleanup;
        active.forceCleanupRequested = true;
        const forceCleanup = (async () => {
          try {
            await active.client.forceStop();
          } catch {
            // Forced cleanup diagnostics must not escape into public failures.
          }
          await active.lifecycle;
          this.activeClients.delete(active);
        })();
        active.forceCleanup = forceCleanup;
        return forceCleanup;
      }),
    );
  }
}

export function createCopilotAdapter(
  registration: AdapterRegistration,
  dependencies: CopilotAdapterDependencies = {},
): ReviewAdapter {
  if (registration.type !== "copilot") {
    throw new Error("createCopilotAdapter requires a Copilot registration");
  }
  return new CopilotAdapter(registration, dependencies);
}
