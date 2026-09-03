import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, rm, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createCommandAdapter } from "./adapters/command.js";
import { AdapterRegistry } from "./adapters/registry.js";
import { loadConfigFiles } from "./config/load.js";
import { getAppPaths, type AppPaths } from "./config/paths.js";
import { resolveConfig } from "./config/resolve.js";
import { createGitRunner } from "./context/git.js";
import { resolveContext, ReviewScopeError } from "./context/resolve.js";
import { createRunRecorder } from "./diagnostics/run-recorder.js";
import {
  runReviewRound,
  type OrchestratorClock,
} from "./orchestrator/run-review.js";
import { createEventWriter } from "./protocol/event-writer.js";
import {
  reviewOutputModeSchema,
  reviewRequestSchema,
  type ReviewOutputMode,
} from "./protocol/schemas.js";

export interface ReviewApplicationOptions {
  requestText: string;
  configFile?: string;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  signal: AbortSignal;
  adapterRegistry?: AdapterRegistry;
  runIdFactory?: () => string;
  appPaths?: AppPaths;
  parentRunId?: string;
  onlyLensIds?: readonly string[];
  detailsFile?: string;
  outputMode?: ReviewOutputMode;
}

export class ReviewRunError extends Error {
  readonly validRunBegan = true;

  constructor(cause: unknown) {
    super("The review run failed unexpectedly.", { cause });
    this.name = "ReviewRunError";
  }
}

const clock: OrchestratorClock = {
  now: () => new Date(),
  setTimeout: ((callback: () => void, delay?: number) =>
    globalThis.setTimeout(callback, delay)) as OrchestratorClock["setTimeout"],
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
  setInterval: ((callback: () => void, delay?: number) =>
    globalThis.setInterval(
      callback,
      delay,
    )) as OrchestratorClock["setInterval"],
  clearInterval: globalThis.clearInterval.bind(globalThis),
};

async function writeDiagnostic(
  stderr: NodeJS.WritableStream,
  error: string,
  message: string,
): Promise<void> {
  const line = `${JSON.stringify({
    schema_version: "1",
    kind: "review-mesh.diagnostic",
    error,
    message,
    retryable: false,
  })}\n`;
  if (stderr.write(line)) return;
  await new Promise<void>((resolve, reject) => {
    stderr.once("drain", resolve);
    stderr.once("error", reject);
  });
}

export function createDefaultRegistry(): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry.register("command", (registration) =>
    createCommandAdapter(registration),
  );
  return registry;
}

function resolvedRunHeader(config: ReturnType<typeof resolveConfig>) {
  return {
    execution: config.execution,
    diagnostics: config.diagnostics,
    reviewers: config.reviewers.map((reviewer) => ({
      id: reviewer.id,
      ...(reviewer.agentId === undefined ? {} : { agent_id: reviewer.agentId }),
      ...(reviewer.modelIndex === undefined
        ? {}
        : { model_index: reviewer.modelIndex }),
      ...(reviewer.configuredModelIndex === undefined
        ? {}
        : { configured_model_index: reviewer.configuredModelIndex }),
      ...(reviewer.modelCount === undefined
        ? {}
        : { model_count: reviewer.modelCount }),
      ...(reviewer.previousReviewerId === undefined
        ? {}
        : { previous_reviewer_id: reviewer.previousReviewerId }),
      purpose: reviewer.purpose,
      adapter: reviewer.adapterId,
      model: reviewer.model,
      ...(reviewer.effort === undefined ? {} : { effort: reviewer.effort }),
      isolation_policy: reviewer.isolationPolicy,
      timeout_ms: reviewer.timeoutMs,
      instruction_sources: reviewer.instruction_layers.map(
        (layer) => layer.source,
      ),
      provider_group: reviewer.providerGroup ?? reviewer.adapterId,
      attempt_timeout_ms: reviewer.attemptTimeoutMs ?? reviewer.timeoutMs,
      ...(reviewer.policy === undefined
        ? {}
        : { policy: structuredClone(reviewer.policy) }),
    })),
  };
}

export async function runReviewApplication(
  options: ReviewApplicationOptions,
): Promise<number> {
  let request: ReturnType<typeof reviewRequestSchema.parse>;
  try {
    request = reviewRequestSchema.parse(JSON.parse(options.requestText));
  } catch {
    await writeDiagnostic(
      options.stderr,
      "invalid_request",
      "Stdin must contain one valid Review Mesh request object.",
    );
    return 2;
  }

  let loaded: Awaited<ReturnType<typeof loadConfigFiles>>;
  try {
    loaded = await loadConfigFiles({
      ...(options.configFile === undefined
        ? {}
        : { configFile: options.configFile }),
      workspace: request.workspace,
      signal: options.signal,
    });
  } catch {
    await writeDiagnostic(
      options.stderr,
      "invalid_configuration",
      "The global Review Mesh configuration or project assignment is invalid.",
    );
    return 2;
  }
  if (
    request.project_name.toLocaleLowerCase("en-US") !==
    loaded.projectName.toLocaleLowerCase("en-US")
  ) {
    await writeDiagnostic(
      options.stderr,
      "invalid_request",
      `The request project_name must match the workspace identity ${loaded.projectName}.`,
    );
    return 2;
  }

  let config: ReturnType<typeof resolveConfig>;
  try {
    config = resolveConfig({
      trusted: loaded.trusted,
      workspace: loaded.workspace,
      projectName: loaded.projectName,
      projectNameSource: loaded.projectNameSource,
    });
  } catch {
    await writeDiagnostic(
      options.stderr,
      "invalid_configuration",
      "The global Review Mesh configuration or project assignment is invalid.",
    );
    return 2;
  }

  let context: Awaited<ReturnType<typeof resolveContext>>;
  try {
    context = await resolveContext({
      request: { ...request, workspace: loaded.workspace },
      git: createGitRunner(),
      signal: options.signal,
    });
  } catch (error) {
    await writeDiagnostic(
      options.stderr,
      "invalid_request",
      error instanceof ReviewScopeError
        ? error.message
        : "The requested workspace or review scope could not be resolved.",
    );
    return 2;
  }

  const runId = (options.runIdFactory ?? (() => `run_${randomUUID()}`))();
  const appPaths = options.appPaths ?? getAppPaths();
  const outputMode = reviewOutputModeSchema.parse(
    options.outputMode ?? "full-jsonl",
  );
  const compactRequiresArtifact = outputMode === "compact-jsonl";
  let detailsHandle: FileHandle | undefined;
  let detailsTargetCreated = false;
  let detailsIdentity:
    { dev: number; ino: number; size: number; mtimeMs: number } | undefined;
  if (options.detailsFile !== undefined) {
    try {
      detailsHandle = await open(
        options.detailsFile,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      detailsTargetCreated = true;
      const opened = await detailsHandle.stat();
      const target = await lstat(options.detailsFile);
      if (
        !opened.isFile() ||
        !target.isFile() ||
        target.isSymbolicLink() ||
        opened.dev !== target.dev ||
        opened.ino !== target.ino
      ) {
        throw new Error("details file identity is unsafe");
      }
      detailsIdentity = {
        dev: opened.dev,
        ino: opened.ino,
        size: opened.size,
        mtimeMs: opened.mtimeMs,
      };
    } catch {
      await detailsHandle?.close().catch(() => undefined);
      detailsHandle = undefined;
      if (detailsTargetCreated) {
        await rm(options.detailsFile, { force: true }).catch(() => undefined);
        detailsTargetCreated = false;
      }
      await writeDiagnostic(
        options.stderr,
        "details_file_unavailable",
        "The requested details file must be a new writable regular file.",
      );
      return 2;
    }
  }
  let recorder: ReturnType<typeof createRunRecorder>;
  try {
    recorder = createRunRecorder({
      runsDirectory: appPaths.runsDirectory,
      applicationDataRoot: dirname(appPaths.runsDirectory),
      runId,
      maxRuns: config.diagnostics.max_runs,
      resolution: resolvedRunHeader(config),
      publish:
        config.diagnostics.persist_runs ||
        options.detailsFile !== undefined ||
        compactRequiresArtifact,
    });
    await recorder.ready();
  } catch {
    await writeDiagnostic(
      options.stderr,
      "persistence_failed",
      "The sanitized active run record could not be initialized.",
    );
    return 2;
  }
  const writer = createEventWriter({
    output: options.stdout,
    runId,
    ...(request.request_id === undefined
      ? {}
      : { requestId: request.request_id }),
    onEvent: recorder.onEvent,
    onRecord: recorder.onRecord,
    onMirrorClose: recorder.close,
    onWarning: () => {
      void writeDiagnostic(
        options.stderr,
        "persistence_failed",
        "The sanitized run record could not be persisted.",
      ).catch(() => undefined);
    },
  });

  try {
    const internalReportPath = join(appPaths.runsDirectory, `${runId}.jsonl`);
    const completion = await runReviewRound({
      runId,
      ...(request.request_id === undefined
        ? {}
        : { requestId: request.request_id }),
      config,
      context,
      registry: options.adapterRegistry ?? createDefaultRegistry(),
      writer,
      signal: options.signal,
      clock,
      ...(options.parentRunId === undefined
        ? {}
        : { parentRunId: options.parentRunId }),
      ...(options.onlyLensIds === undefined
        ? {}
        : { onlyLensIds: options.onlyLensIds }),
      ...(config.diagnostics.persist_runs ||
      options.detailsFile !== undefined ||
      compactRequiresArtifact
        ? { reportPath: options.detailsFile ?? internalReportPath }
        : {}),
      outputMode,
    });
    if (detailsHandle !== undefined) {
      const current = await detailsHandle.stat();
      const target = await lstat(options.detailsFile!);
      if (
        detailsIdentity === undefined ||
        !current.isFile() ||
        !target.isFile() ||
        target.isSymbolicLink() ||
        current.dev !== detailsIdentity.dev ||
        current.ino !== detailsIdentity.ino ||
        target.dev !== detailsIdentity.dev ||
        target.ino !== detailsIdentity.ino ||
        current.size !== detailsIdentity.size ||
        current.mtimeMs !== detailsIdentity.mtimeMs
      ) {
        throw new Error("details file changed before publication");
      }
      await detailsHandle.writeFile(await readFile(internalReportPath), {
        encoding: undefined,
      });
      await detailsHandle.sync();
      await detailsHandle.close();
      detailsHandle = undefined;
      detailsTargetCreated = false;
      if (!config.diagnostics.persist_runs) {
        await rm(internalReportPath, { force: true });
      }
    }
    return completion.exitCode;
  } catch (error) {
    const failure = new ReviewRunError(error);
    await writeDiagnostic(options.stderr, "review_failed", failure.message);
    return 3;
  } finally {
    await detailsHandle?.close().catch(() => undefined);
    if (detailsTargetCreated && options.detailsFile !== undefined) {
      await rm(options.detailsFile, { force: true }).catch(() => undefined);
    }
  }
}
