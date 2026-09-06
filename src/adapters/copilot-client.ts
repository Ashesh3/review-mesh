import type { AdapterRegistration } from "../config/schemas.js";
import { loadCopilotSdkModule } from "../copilot/runtime.js";
import { resolveSdkRuntime } from "../runtime/sdk-runtime.js";
import type { AdapterReviewInput } from "./types.js";

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
  id?: string;
  data?: {
    content?: string;
    deltaContent?: string;
    toolCallId?: string;
    result?: { content?: string };
    [key: string]: unknown;
  };
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
  tools?: Array<{
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    handler?: (
      args: unknown,
      invocation?: { toolCallId?: string },
    ) => Promise<unknown> | unknown;
    overridesBuiltInTool?: boolean;
    skipPermission?: boolean;
    defer?: "auto" | "never";
  }>;
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
  RuntimeConnection: { forStdio(options: { path: string }): unknown };
}

function nativeCopilotEvent(event: unknown): CopilotSessionEvent {
  if (typeof event !== "object" || event === null || !("type" in event)) {
    return { type: "unknown" };
  }
  const value = event as {
    type: string;
    id?: unknown;
    data?: unknown;
  };
  const data =
    typeof value.data === "object" && value.data !== null
      ? (value.data as Exclude<CopilotSessionEvent["data"], undefined>)
      : undefined;
  return {
    type: value.type,
    ...(typeof value.id === "string" ? { id: value.id } : {}),
    ...(data === undefined ? {} : { data }),
  };
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
      on: (handler) =>
        session.on((event) => handler(nativeCopilotEvent(event))),
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
  const runtimePath = resolveSdkRuntime("copilot").executablePath;
  const module = loadCopilotSdkModule() as CopilotSdkModule;
  const configuredOptions = {
    ...options,
    connection: module.RuntimeConnection.forStdio({ path: runtimePath }),
    env: { ...options.env, COPILOT_CLI_PATH: runtimePath },
  };
  return new CopilotClientSdkFacade(
    new module.CopilotClient(configuredOptions),
  );
}
