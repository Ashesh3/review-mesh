import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  Codex,
  type CodexOptions,
  type ThreadEvent,
  type ThreadOptions,
} from "@openai/codex-sdk";
import type { AdapterRegistration } from "../config/schemas.js";
import { getAppPaths } from "../config/paths.js";
import { currentReviewerOutputSchema } from "../protocol/schemas.js";
import { adapterFailure } from "./errors.js";
import {
  assembleResultPages,
  createResultPageStorageBridge,
  nextPageAssignment,
  pageCollectorFor,
  pageFailure,
  isRepairablePageError,
  pageRepairMessage,
  failedPageRepair,
  MAX_PAGE_SCHEMA_REPAIRS,
} from "./sdk-pages.js";
import {
  buildAllowlistedEnvironment,
  type AdapterCapabilities,
  type AdapterEvent,
  type AdapterReviewInput,
  type ReviewAdapter,
} from "./types.js";

const CODEX_SDK_VERSION = "0.151.0";
const ISOLATION_FAILURE =
  "The pinned Codex runtime isolation contract is unavailable.";
const ENFORCED_ISOLATION_FAILURE =
  "Codex provides runtime read-only isolation, not the required independently enforced read-only boundary.";

type CodexRegistration = Extract<AdapterRegistration, { type: "codex" }>;
type CodexConfig = NonNullable<CodexOptions["config"]>;

export interface CodexSdkStartInput {
  threadOptions: ThreadOptions;
  systemPrompt: string;
  userPrompt: string;
  outputSchema: Record<string, unknown>;
  signal: AbortSignal;
}

export interface CodexSdkFacade {
  start(input: CodexSdkStartInput): Promise<AsyncIterable<ThreadEvent>>;
}

export interface CodexFacadeFactoryInput {
  codexPathOverride?: string;
  env: Record<string, string>;
  config: CodexConfig;
}

export interface CodexAdapterDependencies {
  applicationDataDirectory?: string;
  environment?: NodeJS.ProcessEnv;
  isolationVerified?: boolean;
  remove?: RuntimeRemover;
  createFacade?: (input: CodexFacadeFactoryInput) => CodexSdkFacade;
}

export type RuntimeRemover = (
  path: string,
  options: { recursive?: boolean; force?: boolean },
) => Promise<void>;

interface CodexModule {
  Codex: new (options?: CodexOptions) => {
    startThread(options?: ThreadOptions): {
      runStreamed(
        input: string,
        options?: {
          outputSchema?: unknown;
          signal?: AbortSignal;
        },
      ): Promise<{ events: AsyncIterable<ThreadEvent> }>;
    };
  };
}

interface RuntimeHome {
  home: string;
  runDirectory: string;
  cleanup?: Promise<void>;
}

function definedEnvironment(
  environment: NodeJS.ProcessEnv,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

function safeSegment(value: string): string {
  const readable = value.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 48);
  const prefix =
    readable.length === 0 || readable === "." || readable === ".."
      ? "id"
      : readable;
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 12);
  return `${prefix}-${digest}`;
}

function codexConfiguration(systemPrompt: string): CodexConfig {
  return {
    developer_instructions: systemPrompt,
    project_doc_max_bytes: 0,
    mcp_servers: {},
    features: {
      hooks: false,
      apps: false,
      multi_agent: false,
      memories: false,
      plugins: false,
      skill_search: false,
      skip_host_skill_discovery: true,
      external_agent_memory_import: false,
    },
    history: { persistence: "none" },
  };
}

function activityFor(event: ThreadEvent): string | undefined {
  if (event.type !== "item.started" && event.type !== "item.completed") {
    return undefined;
  }
  const phase = event.type === "item.started" ? "started" : "completed";
  switch (event.item.type) {
    case "command_execution":
      return `Codex ${phase} a workspace command.`;
    case "mcp_tool_call":
      return `Codex ${phase} an inspection tool.`;
    case "todo_list":
      return event.type === "item.completed"
        ? "Codex completed its review checklist."
        : undefined;
    case "web_search":
      return event.type === "item.completed"
        ? "Codex completed a search item."
        : undefined;
    case "error":
      return event.type === "item.completed"
        ? "Codex reported a non-terminal item error."
        : undefined;
    default:
      return undefined;
  }
}

export function createCodexSdkFacade(
  input: CodexFacadeFactoryInput,
  module: CodexModule = { Codex },
): CodexSdkFacade {
  const codex = new module.Codex({
    ...(input.codexPathOverride === undefined
      ? {}
      : { codexPathOverride: input.codexPathOverride }),
    env: input.env,
    config: input.config,
  });
  let thread:
    ReturnType<InstanceType<CodexModule["Codex"]>["startThread"]> | undefined;
  return {
    async start(startInput) {
      thread ??= codex.startThread(startInput.threadOptions);
      const streamed = await thread.runStreamed(startInput.userPrompt, {
        outputSchema: startInput.outputSchema,
        signal: startInput.signal,
      });
      return streamed.events;
    },
  };
}

class CodexAdapter implements ReviewAdapter {
  readonly id: string;
  private readonly applicationDataDirectory: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly isolationVerified: boolean;
  private readonly remove: RuntimeRemover;
  private readonly createFacade: (
    input: CodexFacadeFactoryInput,
  ) => CodexSdkFacade;
  private readonly activeHomes = new Set<RuntimeHome>();

  constructor(
    private readonly registration: CodexRegistration,
    dependencies: CodexAdapterDependencies,
  ) {
    this.id = "codex";
    this.applicationDataDirectory =
      dependencies.applicationDataDirectory ??
      dirname(getAppPaths().runsDirectory);
    this.environment = dependencies.environment ?? process.env;
    this.isolationVerified = dependencies.isolationVerified ?? false;
    this.remove = dependencies.remove ?? rm;
    this.createFacade = dependencies.createFacade ?? createCodexSdkFacade;
  }

  async probe(
    reviewer: AdapterReviewInput["reviewer"],
    signal: AbortSignal,
  ): Promise<AdapterCapabilities> {
    const authentication = buildAllowlistedEnvironment(
      this.registration.env_allowlist,
      this.environment,
    ).CODEX_API_KEY;
    const requiresEnforced = reviewer.isolationPolicy === "require_enforced";
    const available =
      authentication !== undefined &&
      !signal.aborted &&
      this.isolationVerified &&
      !requiresEnforced;
    return {
      available,
      authenticated: authentication === undefined ? "unknown" : true,
      model_available: "unknown",
      streaming: true,
      cancellation: true,
      maximumIsolation: "runtime_read_only",
      observed_file_access: false,
      progress_observable: true,
      runtime_version: CODEX_SDK_VERSION,
      ...(!this.isolationVerified
        ? { message: ISOLATION_FAILURE }
        : requiresEnforced
          ? { message: ENFORCED_ISOLATION_FAILURE }
          : signal.aborted
            ? { message: "Codex probing was cancelled." }
            : authentication === undefined
              ? {
                  message:
                    "Codex requires CODEX_API_KEY in the trusted adapter environment allowlist.",
                }
              : {}),
    };
  }

  private async createRuntimeHome(
    runId: string,
    reviewerId: string,
  ): Promise<RuntimeHome> {
    const codexRoot = join(this.applicationDataDirectory, "runtime", "codex");
    const runDirectory = join(codexRoot, safeSegment(runId));
    await mkdir(runDirectory, { recursive: true });
    const home = await mkdtemp(
      join(runDirectory, `${safeSegment(reviewerId)}-`),
    );
    const runtimeHome = { home, runDirectory };
    this.activeHomes.add(runtimeHome);
    return runtimeHome;
  }

  private async removeRuntimeHome(runtimeHome: RuntimeHome): Promise<void> {
    if (runtimeHome.cleanup !== undefined) return runtimeHome.cleanup;
    const cleanup = (async () => {
      await this.remove(runtimeHome.home, { recursive: true, force: true });
      await this.remove(runtimeHome.runDirectory, { recursive: false }).catch(
        () => undefined,
      );
      this.activeHomes.delete(runtimeHome);
    })();
    runtimeHome.cleanup = cleanup;
    try {
      await cleanup;
    } finally {
      if (runtimeHome.cleanup === cleanup) delete runtimeHome.cleanup;
    }
  }

  async *run(input: AdapterReviewInput): AsyncIterable<AdapterEvent> {
    if (!this.isolationVerified) {
      yield {
        type: "failure",
        failure: adapterFailure.unavailable(ISOLATION_FAILURE),
      };
      return;
    }
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

    let runtimeHome: RuntimeHome | undefined;
    let pageStorage:
      ReturnType<typeof createResultPageStorageBridge> | undefined;
    let resultStorageTransferred = false;
    try {
      runtimeHome = await this.createRuntimeHome(
        input.runId,
        input.reviewer.id,
      );
      const env = definedEnvironment(
        buildAllowlistedEnvironment(
          this.registration.env_allowlist,
          this.environment,
        ),
      );
      env.CODEX_HOME = runtimeHome.home;
      if (env.CODEX_API_KEY === undefined) {
        yield {
          type: "failure",
          failure: adapterFailure.unavailable(
            "Codex requires CODEX_API_KEY in the trusted adapter environment allowlist.",
          ),
          isolation: "runtime_read_only",
        };
        return;
      }
      const factoryInput: CodexFacadeFactoryInput = {
        ...(this.registration.executable === undefined
          ? {}
          : { codexPathOverride: this.registration.executable }),
        env,
        config: codexConfiguration(input.prompt.system),
      };
      const facade = this.createFacade(factoryInput);
      const pages = pageCollectorFor(input);
      if (pages !== undefined) {
        pageStorage = createResultPageStorageBridge(input);
        let repairPrompt: string | undefined;
        let pageRepairs = 0;
        while (!pages.collector.complete) {
          const assignment = nextPageAssignment(
            pages.collector,
            pages.resultKind,
          );
          const nativeEvents = await facade.start({
            threadOptions: {
              model: input.reviewer.model,
              ...(input.reviewer.effort === undefined
                ? {}
                : {
                    modelReasoningEffort: input.reviewer.effort as Exclude<
                      ThreadOptions["modelReasoningEffort"],
                      undefined
                    >,
                  }),
              workingDirectory: input.context.workspace,
              sandboxMode: "read-only",
              approvalPolicy: "never",
              networkAccessEnabled: false,
              webSearchMode: "disabled",
              skipGitRepoCheck: input.context.git.is_repository !== true,
            },
            systemPrompt: input.prompt.system,
            userPrompt:
              repairPrompt ??
              (assignment.request.pageIndex === 0
                ? `${input.prompt.user}\n\n${assignment.prompt}`
                : assignment.prompt),
            outputSchema: assignment.schema,
            signal: input.signal,
          });
          let completedAgentMessage: string | undefined;
          let completed = false;
          for await (const event of nativeEvents) {
            if (input.signal.aborted) {
              yield { type: "failure", failure: adapterFailure.cancelled() };
              return;
            }
            if (
              (event.type === "item.started" ||
                event.type === "item.updated" ||
                event.type === "item.completed") &&
              event.item.type === "file_change"
            ) {
              yield {
                type: "failure",
                failure: adapterFailure.protocolViolation(
                  "Codex attempted a file change during a read-only review.",
                ),
                isolation: "runtime_read_only",
              };
              return;
            }
            if (
              event.type === "item.completed" &&
              event.item.type === "agent_message"
            )
              completedAgentMessage = event.item.text;
            if (event.type === "turn.failed" || event.type === "error") {
              await pageStorage.abandon();
              yield {
                type: "failure",
                failure: adapterFailure.processCrashed(
                  "The Codex turn failed.",
                ),
                isolation: "runtime_read_only",
              };
              return;
            }
            if (event.type === "turn.completed") completed = true;
            const activity = activityFor(event);
            if (activity !== undefined)
              yield {
                type: "activity",
                message: activity,
                ...(event.type === "item.started" ||
                event.type === "item.completed"
                  ? { identity: `${event.item.id}:${event.type}` }
                  : {}),
              };
          }
          if (!completed || completedAgentMessage === undefined) {
            await pageStorage.abandon();
            yield {
              type: "failure",
              failure: adapterFailure.invalidResult(
                "Codex completed without a completed agent result message.",
              ),
              isolation: "runtime_read_only",
            };
            return;
          }
          try {
            await pageStorage.addPage(
              pages.collector,
              completedAgentMessage,
              assignment.request.pageIndex,
            );
          } catch (error) {
            if (
              isRepairablePageError(error) &&
              pageRepairs < MAX_PAGE_SCHEMA_REPAIRS
            ) {
              pageRepairs += 1;
              repairPrompt = pageRepairMessage(error, assignment.prompt);
              yield {
                type: "progress",
                phase: "schema_repair",
                identity: `${assignment.request.resultId}:page:${assignment.request.pageIndex}:repair:${pageRepairs}`,
              };
              continue;
            }
            await pageStorage.abandon();
            yield {
              type: "failure",
              failure: failedPageRepair(
                error,
                "Codex",
                pageRepairs,
                assignment.request.resultId,
              ),
              isolation: "runtime_read_only",
            };
            return;
          }
          pageRepairs = 0;
          repairPrompt = undefined;
          yield {
            type: "progress",
            phase: "result_page",
            identity: `${assignment.request.resultId}:page:${assignment.request.pageIndex}`,
            byteCount: Buffer.byteLength(completedAgentMessage, "utf8"),
          };
        }
        const assembled = await assembleResultPages(
          pages.collector,
          pageStorage,
          "Codex",
        );
        if (!assembled.ok) {
          yield {
            type: "failure",
            failure: assembled.failure,
            isolation: "runtime_read_only",
          };
          return;
        }
        yield {
          type: "result",
          result: assembled.result,
          isolation: "runtime_read_only",
          resultStorage: pageStorage.resultStorage(),
        };
        resultStorageTransferred = true;
        return;
      }
      const nativeEvents = await facade.start({
        threadOptions: {
          model: input.reviewer.model,
          ...(input.reviewer.effort === undefined
            ? {}
            : {
                modelReasoningEffort: input.reviewer.effort as Exclude<
                  ThreadOptions["modelReasoningEffort"],
                  undefined
                >,
              }),
          workingDirectory: input.context.workspace,
          sandboxMode: "read-only",
          approvalPolicy: "never",
          networkAccessEnabled: false,
          webSearchMode: "disabled",
          skipGitRepoCheck: input.context.git.is_repository !== true,
        },
        systemPrompt: input.prompt.system,
        userPrompt: input.prompt.user,
        outputSchema: input.resultJsonSchema,
        signal: input.signal,
      });

      let completedAgentMessage: string | undefined;
      for await (const event of nativeEvents) {
        if (input.signal.aborted) {
          yield { type: "failure", failure: adapterFailure.cancelled() };
          return;
        }
        if (
          (event.type === "item.started" ||
            event.type === "item.updated" ||
            event.type === "item.completed") &&
          event.item.type === "file_change"
        ) {
          yield {
            type: "failure",
            failure: adapterFailure.protocolViolation(
              "Codex attempted a file change during a read-only review.",
            ),
            isolation: "runtime_read_only",
          };
          return;
        }
        if (
          event.type === "item.completed" &&
          event.item.type === "agent_message"
        ) {
          completedAgentMessage = event.item.text;
          continue;
        }
        if (event.type === "turn.failed") {
          yield {
            type: "failure",
            failure: adapterFailure.processCrashed("The Codex turn failed."),
            isolation: "runtime_read_only",
          };
          return;
        }
        if (event.type === "error") {
          yield {
            type: "failure",
            failure: adapterFailure.processCrashed(
              "The Codex stream reported a fatal error.",
            ),
            isolation: "runtime_read_only",
          };
          return;
        }
        if (event.type === "turn.completed") {
          if (completedAgentMessage === undefined) {
            yield {
              type: "failure",
              failure: adapterFailure.invalidResult(
                "Codex completed without a completed agent result message.",
              ),
              isolation: "runtime_read_only",
            };
            return;
          }
          let parsedJson: unknown;
          try {
            parsedJson = JSON.parse(completedAgentMessage);
          } catch {
            yield {
              type: "failure",
              failure: adapterFailure.invalidResult(
                "Codex returned malformed JSON for the reviewer result.",
              ),
              isolation: "runtime_read_only",
            };
            return;
          }
          const parsedResult =
            currentReviewerOutputSchema.safeParse(parsedJson);
          if (!parsedResult.success) {
            yield {
              type: "failure",
              failure: adapterFailure.invalidResult(
                "Codex returned an invalid reviewer result.",
              ),
              isolation: "runtime_read_only",
            };
            return;
          }
          yield {
            type: "result",
            result: parsedResult.data,
            isolation: "runtime_read_only",
          };
          return;
        }
        const activity = activityFor(event);
        if (activity !== undefined)
          yield { type: "activity", message: activity };
      }

      yield {
        type: "failure",
        failure: adapterFailure.protocolViolation(
          "The Codex event stream ended before turn completion.",
        ),
        isolation: "runtime_read_only",
      };
    } catch (error) {
      yield {
        type: "failure",
        failure: input.signal.aborted
          ? adapterFailure.cancelled()
          : adapterFailure.processCrashed("The Codex SDK stream failed."),
        isolation: "runtime_read_only",
      };
    } finally {
      if (!resultStorageTransferred) {
        await pageStorage?.abandon().catch(() => undefined);
      }
      if (runtimeHome !== undefined) {
        await this.removeRuntimeHome(runtimeHome).catch(() => undefined);
      }
    }
  }

  async forceCleanup(): Promise<void> {
    await Promise.all(
      [...this.activeHomes].map((runtimeHome) =>
        this.removeRuntimeHome(runtimeHome),
      ),
    );
  }
}

export function createCodexAdapter(
  registration: AdapterRegistration,
  dependencies: CodexAdapterDependencies = {},
): ReviewAdapter {
  if (registration.type !== "codex") {
    throw new Error("createCodexAdapter requires a Codex registration");
  }
  return new CodexAdapter(registration, dependencies);
}
