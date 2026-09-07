import { createNativeSubmissionGuard } from "../runtime/native-submission-guard.js";
import type {
  CopilotClient,
  CopilotClientOptions,
  SessionConfig,
} from "@github/copilot-sdk";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { getAppPaths } from "../config/paths.js";
import type { AdapterRegistration } from "../config/schemas.js";
import { loadCopilotSdkModule } from "../copilot/runtime.js";
import { resolveSdkRuntime, type SdkRuntime } from "../runtime/sdk-runtime.js";
import { sendCopilotReviewAndWait } from "../runtime/copilot-completion.js";
import { createCopilotProgressTracker } from "../runtime/copilot-progress.js";
import {
  createNativeContextFile,
  nativeContextFileHint,
} from "../runtime/native-context.js";
import type { ResolvedContext } from "../context/resolve.js";
import {
  providerReviewerResultV4Schema,
  adjudicationResultV2Schema,
} from "../protocol/v9.js";
import {
  buildAllowlistedEnvironment,
  type ReviewAdapter,
  type AdapterEvent,
  type AdapterReviewInput,
} from "./types.js";
import {
  adapterFailure,
  sanitizePublicText,
  type AdapterFailureDiagnostics,
} from "./errors.js";

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("Cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    operation
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort))
      .catch(() => undefined);
    if (signal.aborted) {
      signal.removeEventListener("abort", abort);
      abort();
    }
  });
}

type Module = typeof import("@github/copilot-sdk");
interface Dependencies {
  environment?: NodeJS.ProcessEnv;
  runtime?: () => SdkRuntime;
  createClient?: (options: CopilotClientOptions) => CopilotClient;
  applicationDataDirectory?: string;
}

export function createNativeCopilotAdapter(
  registration: AdapterRegistration,
  dependencies: Dependencies = {},
): ReviewAdapter {
  if (registration.type !== "copilot")
    throw new Error("Expected Copilot SDK registration");
  const settings = registration,
    environment = dependencies.environment ?? process.env;
  const runtime = dependencies.runtime ?? (() => resolveSdkRuntime("copilot"));
  const baseDirectory = join(
    dependencies.applicationDataDirectory ??
      dirname(getAppPaths().runsDirectory),
    "runtime",
    "copilot-native",
  );
  const active = new Map<
    CopilotClient,
    { directory: string; closing?: Promise<void>; forcing?: Promise<void> }
  >();
  const ownEnvironment = (name: string) =>
    Object.hasOwn(environment, name) && typeof environment[name] === "string"
      ? environment[name]
      : undefined;
  const redactions = [settings.api_key_env, ...(settings.env_allowlist ?? [])]
    .flatMap((name) => {
      const value = name ? ownEnvironment(name) : undefined;
      return value ? [value, encodeURIComponent(value)] : [];
    })
    .sort((a, b) => b.length - a.length);
  const safe = (value: unknown) =>
    typeof value === "string"
      ? sanitizePublicText(
          redactions
            .reduce(
              (text, secret) => text.split(secret).join("[redacted]"),
              value,
            )
            .replace(/https?:\/\/[^\s"'<>]+/giu, "[redacted-url]")
            .replace(
              /(["'](?:authorization|api[_-]?key|access[_-]?token|auth|client[_-]?secret|password|secret|accountkey|token)["']\s*:\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/giu,
              '$1"[redacted]"',
            ),
        )
      : undefined;
  const redactLiteralValues = (value: unknown): unknown => {
    if (typeof value === "string")
      return redactions.reduce(
        (text, secret) => text.split(secret).join("[redacted]"),
        value,
      );
    if (Array.isArray(value)) return value.map(redactLiteralValues);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [
          key,
          redactLiteralValues(child),
        ]),
      );
    return value;
  };
  const provider = () => {
    if (!settings.base_url_env) {
      if (settings.api_key_env)
        throw new Error("Configured SDK API key requires a provider URL.");
      return undefined;
    }
    const baseUrl = ownEnvironment(settings.base_url_env);
    if (!baseUrl) throw new Error("Configured SDK provider URL is missing.");
    const apiKey = settings.api_key_env
      ? ownEnvironment(settings.api_key_env)
      : undefined;
    if (settings.api_key_env && !apiKey)
      throw new Error("Configured SDK provider key is missing.");
    return {
      type: "openai" as const,
      baseUrl,
      wireApi: "completions" as const,
      ...(apiKey ? { apiKey } : {}),
    };
  };
  async function client(signal: AbortSignal, selectedRuntime: SdkRuntime) {
    signal.throwIfAborted();
    const selectedProvider = provider();
    const useLoggedInUser =
      selectedProvider === undefined && (settings.use_logged_in_user ?? true);
    await mkdir(baseDirectory, { recursive: true });
    const authenticationDirectory = join(dirname(baseDirectory), "copilot");
    if (useLoggedInUser)
      await mkdir(authenticationDirectory, { recursive: true });
    signal.throwIfAborted();
    const directory = await mkdtemp(join(baseDirectory, "session-"));
    try {
      signal.throwIfAborted();
      const module = loadCopilotSdkModule() as Module;
      const value = (
        dependencies.createClient ??
        ((options) => new module.CopilotClient(options))
      )({
        mode: "empty",
        connection: module.RuntimeConnection.forStdio({
          path: selectedRuntime.executablePath,
        }),
        baseDirectory: useLoggedInUser ? authenticationDirectory : directory,
        workingDirectory: directory,
        logLevel: "error",
        env: buildAllowlistedEnvironment(settings.env_allowlist, environment),
        useLoggedInUser,
      });
      active.set(value, { directory });
      return value;
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
  async function close(value: CopilotClient) {
    const state = active.get(value);
    if (!state) return;
    if (state.closing) return state.closing;
    state.closing = (async () => {
      try {
        await state.forcing;
        const errors = await value.stop();
        if (errors.length) await force(value);
      } catch {
        await force(value);
      } finally {
        await rm(state.directory, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 100,
        }).catch(() => undefined);
        active.delete(value);
      }
    })();
    return state.closing;
  }
  function force(value: CopilotClient): Promise<void> {
    const state = active.get(value);
    if (!state) return Promise.resolve();
    return (state.forcing ??= (async () => {
      await value.forceStop().catch(() => undefined);
    })());
  }
  return {
    id: "copilot",
    async probe(reviewer, signal) {
      let value: CopilotClient | undefined;
      let available = false,
        authenticated: boolean | "unknown" = "unknown",
        modelAvailable: boolean | "unknown" = "unknown",
        message: string | undefined,
        selectedRuntime: SdkRuntime | undefined;
      try {
        if (signal.aborted) throw new Error("Copilot probe cancelled.");
        if (reviewer.isolationPolicy === "require_enforced")
          throw new Error(
            "Copilot provides runtime read-only tool restrictions, not an independently enforced filesystem boundary.",
          );
        selectedRuntime = runtime();
        value = await client(signal, selectedRuntime);
        const abort = () => {
          void force(value!);
        };
        signal.addEventListener("abort", abort, { once: true });
        try {
          signal.throwIfAborted();
          await abortable(value.start(), signal);
          if (provider()) {
            authenticated = true;
            modelAvailable = "unknown";
          } else {
            authenticated = (await abortable(value.getAuthStatus(), signal))
              .isAuthenticated;
            signal.throwIfAborted();
            const models = await abortable(value.listModels(), signal);
            const model = models.find((m) => m.id === reviewer.model);
            modelAvailable = Boolean(
              model &&
              (model.policy === undefined ||
                model.policy.state === "enabled") &&
              (!reviewer.effort ||
                (
                  model.supportedReasoningEfforts as
                    readonly string[] | undefined
                )?.includes(reviewer.effort)),
            );
          }
          available = true;
          if (modelAvailable === false)
            message = `The Copilot account does not offer model ${reviewer.model} with the configured effort.`;
        } finally {
          signal.removeEventListener("abort", abort);
        }
      } catch (error) {
        message =
          error instanceof Error
            ? safe(error.message)
            : "Copilot SDK runtime initialization failed.";
      } finally {
        if (value) await close(value);
      }
      return {
        available,
        authenticated,
        model_available: modelAvailable,
        streaming: true,
        cancellation: true,
        maximumIsolation: "runtime_read_only",
        observed_file_access: false,
        progress_observable: true,
        ...(selectedRuntime
          ? {
              runtime_version: selectedRuntime.runtimeVersion,
              sdk_version: selectedRuntime.sdkVersion,
            }
          : {}),
        ...(message ? { message } : {}),
      };
    },
    async *run(input: AdapterReviewInput): AsyncIterable<AdapterEvent> {
      if (input.isolationPolicy === "require_enforced") {
        yield {
          type: "failure",
          failure: adapterFailure.unavailable(
            "Copilot cannot provide the required external read-only boundary.",
          ),
        };
        return;
      }
      let value: CopilotClient | undefined;
      let session:
        Awaited<ReturnType<CopilotClient["createSession"]>> | undefined;
      const abort = () => {
        void session?.abort().catch(() => undefined);
        if (value) void force(value);
      };
      input.signal.addEventListener("abort", abort, { once: true });
      let wake: (() => void) | undefined,
        done = false,
        failed = false,
        submissionFeedback: string | undefined,
        submitted:
          | ReturnType<typeof providerReviewerResultV4Schema.parse>
          | ReturnType<typeof adjudicationResultV2Schema.parse>
          | undefined;
      const events: AdapterEvent[] = [];
      const trackProgress = createCopilotProgressTracker();
      const submissionGuard = createNativeSubmissionGuard({
        reviewer: input.reviewer,
        context: input.context,
        signal: input.signal,
        ...(input.recordDiagnostic
          ? { recordDiagnostic: input.recordDiagnostic }
          : {}),
        redactLiteralValues,
        sanitizeMessage: safe,
        diagnosticPrefix: "native-copilot-submission",
      });
      let lastOperation = "initialize";
      let failureDetails: AdapterFailureDiagnostics | undefined;
      const captureException = (error: unknown) => {
        failureDetails ??= {
          failure_stage: "native_copilot",
          last_operation: lastOperation,
          exception_name:
            (error instanceof Error ? safe(error.name) : undefined) ?? "Error",
          exception_message:
            safe(error instanceof Error ? error.message : error) ??
            "Copilot SDK operation failed.",
        };
      };
      const failure = async () => {
        const detail =
          failureDetails?.provider_error_message ??
          failureDetails?.exception_message;
        const result = adapterFailure.processCrashed(
          detail
            ? `Copilot SDK review failed: ${detail}`
            : "Copilot SDK review failed.",
          false,
          failureDetails ? { diagnostics: failureDetails } : {},
        );
        if (result.diagnostics)
          await input.recordDiagnostic?.({
            kind: "adapter_exception",
            diagnostics: result.diagnostics,
          });
        return result;
      };
      const push = (event: AdapterEvent) => {
        events.push(event);
        wake?.();
      };
      try {
        if (input.signal.aborted) {
          yield { type: "failure", failure: adapterFailure.cancelled() };
          return;
        }
        lastOperation = "createClient";
        value = await client(input.signal, runtime());
        input.signal.throwIfAborted();
        lastOperation = "start";
        await abortable(value.start(), input.signal);
        input.signal.throwIfAborted();
        const contextFile = await createNativeContextFile(
          active.get(value)!.directory,
          redactLiteralValues(input.context) as ResolvedContext,
        );
        input.signal.throwIfAborted();
        const schema =
          input.reviewer.policy?.mode === "adjudication"
            ? adjudicationResultV2Schema
            : providerReviewerResultV4Schema;
        const config: SessionConfig = {
          model: input.reviewer.model,
          workingDirectory: input.context.workspace,
          configDirectory: active.get(value)!.directory,
          streaming: true,
          systemMessage: {
            mode: "append",
            content: `${input.prompt.system}\n\n${nativeContextFileHint(contextFile)}`,
          },
          enableConfigDiscovery: false,
          enableOnDemandInstructionDiscovery: false,
          enableFileHooks: false,
          enableSkills: false,
          enableSessionStore: false,
          enableHostGitOperations: false,
          availableTools: [
            "builtin:view",
            "builtin:grep",
            "builtin:glob",
            "custom:submit_review",
          ],
          excludedTools: [
            "builtin:bash",
            "builtin:powershell",
            "builtin:edit",
            "builtin:create",
            "builtin:apply_patch",
          ],
          mcpServers: {},
          pluginDirectories: [],
          instructionDirectories: [],
          remoteSession: "off",
          infiniteSessions: { enabled: true },
          onPermissionRequest: (request) =>
            request.kind === "read" && !request.managedApprovalRequired
              ? { kind: "approve-once" }
              : { kind: "reject", feedback: "Read-only review" },
          tools: [
            {
              name: "submit_review",
              description:
                "Submit the complete structured review after inspecting the requested scope. This ends your review.",
              parameters: input.resultJsonSchema,
              isTerminal: true,
              skipPermission: true,
              defer: "never",
              handler: async (args) => {
                const parsed = schema.safeParse(args);
                if (!parsed.success) {
                  const issues = parsed.error.issues
                    .slice(0, 12)
                    .map((issue) => {
                      const path = issue.path.map(String).join(".") || "<root>";
                      const expected =
                        issue.code === "invalid_type"
                          ? `; expected ${issue.expected}`
                          : "";
                      return `${safe(path) ?? "<field>"}: ${issue.code}${expected}`;
                    });
                  submissionFeedback = `Review does not satisfy the required schema: ${issues.join("; ")}. Provide all required fields and preserve every finding and candidate decision.`;
                  return {
                    resultType: "failure",
                    textResultForLlm: submissionFeedback,
                    error: submissionFeedback,
                  };
                }
                if (submitted)
                  return {
                    resultType: "failure",
                    textResultForLlm: "Review was already submitted.",
                    error: "Review was already submitted.",
                  };
                const validation = await submissionGuard.validate(parsed.data);
                if (!validation.accepted) {
                  submissionFeedback = validation.message;
                  return {
                    resultType: "failure",
                    textResultForLlm: submissionFeedback,
                    error: submissionFeedback,
                  };
                }
                submitted = parsed.data;
                return {
                  resultType: "success",
                  textResultForLlm: "Review accepted.",
                };
              },
            },
          ],
          ...(provider() ? { provider: provider()! } : {}),
          ...(input.reviewer.effort
            ? {
                reasoningEffort: input.reviewer.effort as NonNullable<
                  SessionConfig["reasoningEffort"]
                >,
              }
            : {}),
        };
        lastOperation = "createSession";
        const creation = value.createSession(config);
        void creation.then(
          (late) => {
            if (input.signal.aborted)
              void late.disconnect().catch(() => undefined);
          },
          () => undefined,
        );
        session = await abortable(creation, input.signal);
        input.signal.throwIfAborted();
        session.on((event) => {
          if (event.type === "session.error") {
            failed = true;
            failureDetails ??= {
              failure_stage: "native_copilot",
              last_operation: "session.error",
              exception_name: safe(event.data.errorType) ?? "Error",
              provider_error_message:
                safe(event.data.message) ?? "Copilot SDK session failed.",
              ...(event.data.errorCode
                ? {
                    provider_error_code:
                      safe(event.data.errorCode) ?? "unknown",
                  }
                : {}),
              ...(event.data.providerCallId
                ? {
                    provider_request_id:
                      safe(event.data.providerCallId) ?? "unknown",
                  }
                : {}),
              ...(event.data.statusCode === undefined
                ? {}
                : { http_status: event.data.statusCode }),
            };
          }
          const progress = trackProgress(event);
          if (progress) push(progress);
        });
        lastOperation = "sendAndWait";
        const pending = sendCopilotReviewAndWait(
          session,
          {
            prompt: `${input.prompt.user}\n\nSubmit the final result with submit_review.`,
            agentMode: "interactive",
          },
          input.reviewer.timeoutMs,
          input.signal,
        )
          .catch((error: unknown) => {
            failed = true;
            captureException(error);
          })
          .finally(() => {
            done = true;
            wake?.();
          });
        while (!done || events.length) {
          while (events.length) yield events.shift()!;
          if (!done)
            await new Promise<void>((resolve) => {
              wake = resolve;
              if (done || events.length) resolve();
            });
        }
        await pending;
        if (input.signal.aborted)
          yield { type: "failure", failure: adapterFailure.cancelled() };
        else if (failed)
          yield {
            type: "failure",
            failure: await failure(),
          };
        else if (!submitted)
          yield {
            type: "failure",
            failure: adapterFailure.invalidResult(
              submissionFeedback
                ? `Copilot could not submit a valid review: ${safe(submissionFeedback)}`
                : "Copilot ended without submitting a structured review.",
            ),
          };
        else
          yield {
            type: "result",
            result: submitted,
            isolation: "runtime_read_only",
          };
      } catch (error) {
        captureException(error);
        yield {
          type: "failure",
          failure: input.signal.aborted
            ? adapterFailure.cancelled()
            : await failure(),
        };
      } finally {
        input.signal.removeEventListener("abort", abort);
        await session?.disconnect().catch(() => undefined);
        if (value) await close(value);
      }
    },
    async forceCleanup() {
      await Promise.all(
        [...active.keys()].map(async (value) => {
          await force(value);
          await close(value);
        }),
      );
    },
  };
}
