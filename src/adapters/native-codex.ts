import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { delimiter, dirname, isAbsolute } from "node:path";
import {
  Codex,
  type CodexOptions,
  type ThreadEvent,
  type ThreadOptions,
} from "@openai/codex-sdk";
import type { AdapterRegistration } from "../config/schemas.js";
import { getAppPaths } from "../config/paths.js";
import {
  adjudicationResultV2Schema,
  providerReviewerResultV4Schema,
} from "../protocol/v9.js";
import {
  createCodexIsolationHome,
  type CodexIsolationHome,
} from "../runtime/codex-isolation.js";
import { resolveSdkRuntime, type SdkRuntime } from "../runtime/sdk-runtime.js";
import { adapterFailure } from "./errors.js";
import { codexOutputBoundary } from "./codex-output.js";
import {
  buildAllowlistedEnvironment,
  type AdapterCapabilities,
  type AdapterEvent,
  type AdapterReviewInput,
  type ReviewAdapter,
} from "./types.js";

type Registration = Extract<AdapterRegistration, { type: "codex" }>;
type CodexClient = Pick<Codex, "startThread">;
export interface NativeCodexDependencies {
  applicationDataDirectory?: string;
  environment?: NodeJS.ProcessEnv;
  createClient?: (options: CodexOptions) => CodexClient;
  createIsolation?: typeof createCodexIsolationHome;
}

function credentials(
  registration: Registration,
  source: NodeJS.ProcessEnv,
): { apiKey?: string; baseUrl?: string; environment: Record<string, string> } {
  const allowed = new Set(registration.env_allowlist ?? []);
  if (registration.api_key_env) allowed.add(registration.api_key_env);
  if (registration.base_url_env) allowed.add(registration.base_url_env);
  const selected = buildAllowlistedEnvironment([...allowed], source);
  const apiName =
    registration.api_key_env ??
    ["CODEX_API_KEY", "OPENAI_API_KEY"].find(
      (name) => allowed.has(name) && selected[name]?.trim(),
    );
  const baseName =
    registration.base_url_env ??
    (allowed.has("OPENAI_BASE_URL") ? "OPENAI_BASE_URL" : undefined);
  const apiKey = apiName ? selected[apiName] : undefined;
  const baseUrl = baseName ? selected[baseName] : undefined;
  if (registration.api_key_env && !apiKey?.trim())
    throw new Error("Configured Codex credential is unavailable.");
  if (registration.base_url_env && !baseUrl?.trim())
    throw new Error("Configured Codex base URL is unavailable.");
  if (baseUrl) {
    const url = new URL(baseUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error("Configured Codex base URL is invalid.");
  }
  // Credentials are supplied through SDK fields, never copied into the tool environment.
  const environment = Object.fromEntries(
    Object.entries(selected).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  if (apiName) delete environment[apiName];
  if (baseName) delete environment[baseName];
  return {
    ...(apiKey?.trim() ? { apiKey } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    environment,
  };
}

function activity(event: ThreadEvent): string | undefined {
  if (event.type === "error")
    return "Codex is handling a runtime or transport interruption.";
  if (event.type === "turn.started") return "Codex started its native review.";
  if (event.type !== "item.started" && event.type !== "item.completed") return;
  const phase = event.type === "item.started" ? "started" : "completed";
  if (event.item.type === "command_execution")
    return `Codex ${phase} a workspace inspection command.`;
  if (event.item.type === "mcp_tool_call")
    return `Codex ${phase} an inspection tool.`;
  if (event.item.type === "todo_list")
    return "Codex updated its review checklist.";
  if (event.item.type === "error") return "Codex reported a runtime notice.";
}

class NativeCodexAdapter implements ReviewAdapter {
  readonly id = "codex";
  private readonly active = new Map<CodexIsolationHome, AbortController>();
  constructor(
    private readonly registration: Registration,
    private readonly dependencies: NativeCodexDependencies,
  ) {}

  private runtime(): SdkRuntime {
    const runtime = resolveSdkRuntime("codex");
    if (
      this.registration.executable !== undefined &&
      this.registration.executable !== runtime.executablePath
    )
      throw new Error("Native Codex reviews require the packaged runtime.");
    return runtime;
  }

  async probe(
    reviewer: AdapterReviewInput["reviewer"],
    signal: AbortSignal,
  ): Promise<AdapterCapabilities> {
    const base: AdapterCapabilities = {
      available: false,
      authenticated: "unknown",
      model_available: "unknown",
      streaming: true,
      cancellation: true,
      maximumIsolation: "runtime_read_only",
      observed_file_access: false,
      progress_observable: true,
    };
    if (reviewer.isolationPolicy === "require_enforced")
      return {
        ...base,
        message:
          "Codex does not provide the required independently enforced read-only boundary.",
      };
    if (signal.aborted)
      return { ...base, message: "Codex probing was cancelled." };
    try {
      const auth = credentials(
        this.registration,
        this.dependencies.environment ?? process.env,
      );
      if (!auth.apiKey)
        return {
          ...base,
          message:
            "Codex requires an explicitly selected API-key environment variable.",
        };
      const runtime = this.runtime();
      await access(
        runtime.executablePath,
        process.platform === "win32" ? constants.F_OK : constants.X_OK,
      );
      return {
        ...base,
        available: true,
        authenticated: true,
        runtime_version: runtime.runtimeVersion,
        sdk_version: runtime.sdkVersion,
      };
    } catch {
      return {
        ...base,
        message:
          "The packaged Codex runtime or its configured credentials are unavailable.",
      };
    }
  }

  async *run(input: AdapterReviewInput): AsyncIterable<AdapterEvent> {
    if (input.signal.aborted) {
      yield { type: "failure", failure: adapterFailure.cancelled() };
      return;
    }
    const readiness = await this.probe(
      { ...input.reviewer, isolationPolicy: input.isolationPolicy },
      input.signal,
    );
    if (!readiness.available) {
      yield {
        type: "failure",
        failure: adapterFailure.unavailable(readiness.message),
      };
      return;
    }
    const controller = new AbortController();
    const cancel = () => controller.abort(input.signal.reason);
    input.signal.addEventListener("abort", cancel, { once: true });
    let isolated: CodexIsolationHome | undefined;
    let terminal: AdapterEvent | undefined;
    let completionFailure: Error | undefined;
    try {
      const auth = credentials(
        this.registration,
        this.dependencies.environment ?? process.env,
      );
      const runtime = this.runtime();
      const workspace = await realpath(input.context.workspace);
      if (!isAbsolute(workspace))
        throw new Error("Workspace path is not absolute.");
      isolated = await (
        this.dependencies.createIsolation ?? createCodexIsolationHome
      )(
        this.dependencies.applicationDataDirectory ??
          dirname(getAppPaths().runsDirectory),
        input.prompt.system,
      );
      this.active.set(isolated, controller);
      if (input.signal.aborted) cancel();
      const environment = auth.environment;
      const pathKey =
        process.platform === "win32"
          ? (Object.keys(environment).find(
              (key) => key.toLowerCase() === "path",
            ) ?? "Path")
          : "PATH";
      const previousPath = environment[pathKey];
      if (process.platform === "win32")
        for (const key of Object.keys(environment))
          if (key.toLowerCase() === "path" && key !== pathKey)
            delete environment[key];
      environment[pathKey] = [
        ...runtime.pathEntries,
        ...(previousPath ? [previousPath] : []),
      ].join(delimiter);
      environment.CODEX_HOME = isolated.home;
      const client = (
        this.dependencies.createClient ?? ((options) => new Codex(options))
      )({
        codexPathOverride: runtime.executablePath,
        apiKey: auth.apiKey!,
        ...(auth.baseUrl ? { baseUrl: auth.baseUrl } : {}),
        env: environment,
      });
      const thread = client.startThread({
        model: input.reviewer.model,
        ...(input.reviewer.effort
          ? {
              modelReasoningEffort: input.reviewer.effort as NonNullable<
                ThreadOptions["modelReasoningEffort"]
              >,
            }
          : {}),
        workingDirectory: isolated.workingDirectory,
        sandboxMode: "read-only",
        approvalPolicy: "never",
        networkAccessEnabled: false,
        webSearchMode: "disabled",
        skipGitRepoCheck: true,
      });
      const outputBoundary = codexOutputBoundary(input.resultJsonSchema);
      const stream = await thread.runStreamed(
        `Review workspace: ${JSON.stringify(workspace)}\nUse this absolute path when inspecting files; the launch directory is an empty runtime directory.\n\n${input.prompt.user}`,
        { outputSchema: outputBoundary.schema, signal: controller.signal },
      );
      let lastMessage: string | undefined;
      for await (const event of stream.events) {
        if (controller.signal.aborted) break;
        if (
          (event.type === "item.started" ||
            event.type === "item.updated" ||
            event.type === "item.completed") &&
          event.item.type === "file_change"
        ) {
          terminal = {
            type: "failure",
            failure: adapterFailure.protocolViolation(
              "Codex attempted a file change during a read-only review.",
            ),
            isolation: "runtime_read_only",
          };
          break;
        }
        if (
          event.type === "item.completed" &&
          event.item.type === "agent_message"
        ) {
          lastMessage = event.item.text;
          continue;
        }
        if (event.type === "turn.failed") {
          terminal = {
            type: "failure",
            failure: adapterFailure.processCrashed(
              "The native Codex turn failed.",
            ),
            isolation: "runtime_read_only",
          };
          break;
        }
        if (event.type === "turn.completed") {
          let raw: unknown;
          try {
            raw = JSON.parse(lastMessage ?? "");
          } catch {
            raw = undefined;
          }
          const parsed = (
            input.reviewer.policy?.mode === "adjudication"
              ? adjudicationResultV2Schema
              : providerReviewerResultV4Schema
          ).safeParse(outputBoundary.normalize(raw));
          terminal = parsed.success
            ? {
                type: "result",
                result: parsed.data,
                isolation: "runtime_read_only",
              }
            : {
                type: "failure",
                failure: adapterFailure.invalidResult(
                  "Codex completed without a valid native review result.",
                ),
                isolation: "runtime_read_only",
              };
          continue;
        }
        const message = activity(event);
        if (message) yield { type: "activity", message };
      }
      if (controller.signal.aborted) {
        if (terminal?.type === "result")
          completionFailure = new Error(
            "Codex runtime was cancelled after producing a valid result.",
          );
        else
          terminal = {
            type: "failure",
            failure: adapterFailure.cancelled(),
            isolation: "runtime_read_only",
          };
      }
      terminal ??= {
        type: "failure",
        failure: controller.signal.aborted
          ? adapterFailure.cancelled()
          : adapterFailure.protocolViolation(
              "The Codex stream ended before native turn completion.",
            ),
        isolation: "runtime_read_only",
      };
    } catch {
      if (terminal?.type === "result")
        completionFailure = new Error(
          "Codex runtime failed after producing a valid result.",
        );
      else
        terminal = {
          type: "failure",
          failure:
            controller.signal.aborted || input.signal.aborted
              ? adapterFailure.cancelled()
              : adapterFailure.processCrashed(
                  "The native Codex runtime could not complete the review.",
                ),
          isolation: "runtime_read_only",
        };
    } finally {
      controller.abort();
      input.signal.removeEventListener("abort", cancel);
      if (isolated) {
        try {
          await isolated.cleanup();
          this.active.delete(isolated);
        } catch {
          if (terminal?.type === "result")
            completionFailure ??= new Error(
              "Codex runtime cleanup failed after producing a valid result.",
            );
          else
            terminal = {
              type: "failure",
              failure: adapterFailure.processCrashed(
                "The Codex runtime directory could not be cleaned up.",
              ),
              isolation: "runtime_read_only",
            };
        }
      }
    }
    yield terminal!;
    if (completionFailure) throw completionFailure;
  }

  async forceCleanup(): Promise<void> {
    for (const controller of this.active.values()) controller.abort();
    await Promise.all(
      [...this.active.keys()].map(async (home) => {
        await home.cleanup();
        this.active.delete(home);
      }),
    );
  }
}

export function createNativeCodexAdapter(
  registration: Registration,
  dependencies: NativeCodexDependencies = {},
): ReviewAdapter {
  return new NativeCodexAdapter(registration, dependencies);
}
