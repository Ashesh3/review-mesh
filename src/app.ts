import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { createCommandAdapter } from "./adapters/command.js";
import { AdapterRegistry } from "./adapters/registry.js";
import { loadConfigFiles } from "./config/load.js";
import { getAppPaths, type AppPaths } from "./config/paths.js";
import { resolveConfig } from "./config/resolve.js";
import { createGitRunner } from "./context/git.js";
import { resolveContext } from "./context/resolve.js";
import { createRunRecorder } from "./diagnostics/run-recorder.js";
import {
  runReviewRound,
  type OrchestratorClock,
} from "./orchestrator/run-review.js";
import { createEventWriter } from "./protocol/event-writer.js";
import { reviewRequestSchema } from "./protocol/schemas.js";

export interface ReviewApplicationOptions {
  requestText: string;
  configFile?: string;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  signal: AbortSignal;
  adapterRegistry?: AdapterRegistry;
  runIdFactory?: () => string;
  appPaths?: AppPaths;
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
  const line = `${JSON.stringify({ error, message })}\n`;
  if (stderr.write(line)) return;
  await new Promise<void>((resolve, reject) => {
    stderr.once("drain", resolve);
    stderr.once("error", reject);
  });
}

function defaultRegistry(): AdapterRegistry {
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
      purpose: reviewer.purpose,
      adapter: reviewer.adapterId,
      model: reviewer.model,
      isolation_policy: reviewer.isolationPolicy,
      timeout_ms: reviewer.timeoutMs,
      runtime: reviewer.runtime,
      instruction_sources: reviewer.instruction_layers.map(
        (layer) => layer.source,
      ),
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

  let config: ReturnType<typeof resolveConfig>;
  try {
    const loaded = await loadConfigFiles({
      ...(options.configFile === undefined
        ? {}
        : { configFile: options.configFile }),
      workspace: request.workspace,
      signal: options.signal,
    });
    config = resolveConfig(loaded);
  } catch {
    await writeDiagnostic(
      options.stderr,
      "invalid_configuration",
      "The trusted or repository Review Mesh configuration is invalid.",
    );
    return 2;
  }

  let context: Awaited<ReturnType<typeof resolveContext>>;
  try {
    context = await resolveContext({
      request,
      git: createGitRunner(),
      signal: options.signal,
    });
  } catch {
    await writeDiagnostic(
      options.stderr,
      "invalid_request",
      "The requested workspace or review scope could not be resolved.",
    );
    return 2;
  }

  const runId = (options.runIdFactory ?? (() => `run_${randomUUID()}`))();
  const appPaths = options.appPaths ?? getAppPaths();
  const recorder = config.diagnostics.persist_runs
    ? createRunRecorder({
        runsDirectory: appPaths.runsDirectory,
        applicationDataRoot: dirname(appPaths.runsDirectory),
        runId,
        maxRuns: config.diagnostics.max_runs,
        resolution: resolvedRunHeader(config),
      })
    : undefined;
  const writer = createEventWriter({
    output: options.stdout,
    runId,
    ...(request.request_id === undefined
      ? {}
      : { requestId: request.request_id }),
    ...(recorder === undefined ? {} : { onEvent: recorder.onEvent }),
    ...(recorder === undefined ? {} : { onMirrorClose: recorder.close }),
    onWarning: () => {
      void writeDiagnostic(
        options.stderr,
        "persistence_failed",
        "The sanitized run record could not be persisted.",
      ).catch(() => undefined);
    },
  });

  try {
    const completion = await runReviewRound({
      runId,
      ...(request.request_id === undefined
        ? {}
        : { requestId: request.request_id }),
      config,
      context,
      registry: options.adapterRegistry ?? defaultRegistry(),
      writer,
      signal: options.signal,
      clock,
    });
    return completion.exitCode;
  } catch (error) {
    const failure = new ReviewRunError(error);
    await writeDiagnostic(options.stderr, "review_failed", failure.message);
    return 3;
  }
}
