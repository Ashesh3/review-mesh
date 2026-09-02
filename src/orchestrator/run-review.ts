import {
  adapterFailure,
  sanitizeAdapterFailure,
  type AdapterFailure,
} from "../adapters/errors.js";
import type {
  AdapterCapabilities,
  AdapterEvent,
  ReviewAdapter,
} from "../adapters/types.js";
import type { AdapterRegistry } from "../adapters/registry.js";
import type { ResolvedConfig, ResolvedReviewer } from "../config/schemas.js";
import type { ResolvedContext } from "../context/resolve.js";
import type { EventDraft, EventWriter } from "../protocol/event-writer.js";
import { reviewerResultJsonSchema } from "../protocol/json-schema.js";
import { buildReviewerPrompt } from "../protocol/prompt.js";
import {
  reviewerPhaseSchema,
  reviewerResultSchema,
  incompleteReasonSchema,
  type IsolationLevel,
  type JsonValue,
  type ReviewerPhase,
  type ReviewerTerminalRecord,
  type RunStatus,
} from "../protocol/schemas.js";
import {
  aggregateRun,
  createSuiteState,
  exitCodeFor,
  reviewerTerminalRecord,
  summarizeSuite,
  type SuiteState,
} from "./state.js";

export interface OrchestratorClock {
  now(): Date;
  setTimeout(
    callback: () => void,
    delay?: number,
  ): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
  setInterval(
    callback: () => void,
    delay?: number,
  ): ReturnType<typeof setInterval>;
  clearInterval(timer: ReturnType<typeof setInterval>): void;
}

export interface RunReviewRoundInput {
  runId: string;
  requestId?: string;
  config: ResolvedConfig;
  context: ResolvedContext;
  registry: AdapterRegistry;
  writer: EventWriter;
  signal: AbortSignal;
  clock: OrchestratorClock;
}

export interface RunCompletion {
  status: RunStatus;
  exitCode: 0 | 1 | 3 | 4;
  reviewers: ReviewerTerminalRecord[];
  totalElapsedMs: number;
}

interface ReviewerJob {
  reviewer: ResolvedReviewer;
  adapter?: ReviewAdapter;
  creationFailure?: AdapterFailure;
}

interface ActiveJob {
  job: ReviewerJob;
  controller: AbortController;
  iterator?: AsyncIterator<AdapterEvent>;
  iteratorReturnRequested: boolean;
  deadline?: ReturnType<typeof setTimeout>;
  heartbeat?: ReturnType<typeof setInterval>;
  heartbeatEmissions: Set<Promise<void>>;
  timedOut: boolean;
  cleanup?: Promise<void>;
  shutdownReleased: Promise<void>;
  releaseShutdown(): void;
}

class ProbeTimeoutError extends Error {}

const MAX_PROBE_TIMEOUT_MS = 30_000;

const globalClock: OrchestratorClock = {
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

function probeFailure(
  capabilities: AdapterCapabilities,
): AdapterFailure | undefined {
  if (capabilities.authenticated === false) {
    return adapterFailure.authentication(
      capabilities.message ?? "Adapter authentication is unavailable.",
    );
  }
  if (capabilities.model_available === false) {
    return adapterFailure.modelUnavailable(
      capabilities.message ?? "The configured model is unavailable.",
    );
  }
  if (!capabilities.available) {
    return adapterFailure.unavailable(
      capabilities.message ?? "The adapter is unavailable.",
    );
  }
  return undefined;
}

function boundedMessage(message: unknown): string | undefined {
  if (typeof message !== "string") return undefined;
  const normalized = message.trim().slice(0, 1_000);
  return normalized.length === 0 ? undefined : normalized;
}

function normalizeFailure(failure: unknown): AdapterFailure {
  if (typeof failure !== "object" || failure === null) {
    return adapterFailure.unknown(failure);
  }
  const candidate = failure as Partial<AdapterFailure>;
  const reason = incompleteReasonSchema.safeParse(candidate.reason);
  if (!reason.success) {
    return adapterFailure.unknown(candidate.message);
  }
  return sanitizeAdapterFailure(
    reason.data,
    candidate.message,
    candidate.retryable === true,
  );
}

function phaseForHeartbeat(
  state: SuiteState,
  reviewerId: string,
): ReviewerPhase {
  const status = state.reviewer(reviewerId).status;
  const parsed = reviewerPhaseSchema.safeParse(status);
  return parsed.success ? parsed.data : "reviewing";
}

function linkAbort(parent: AbortSignal, child: AbortController): () => void {
  const abort = () => child.abort(parent.reason);
  if (parent.aborted) abort();
  else parent.addEventListener("abort", abort, { once: true });
  return () => parent.removeEventListener("abort", abort);
}

function signalPromise(signal: AbortSignal): {
  promise: Promise<void>;
  dispose(): void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((completed) => {
    resolve = completed;
  });
  const onAbort = () => resolve();
  if (signal.aborted) resolve();
  else signal.addEventListener("abort", onAbort, { once: true });
  return {
    promise,
    dispose: () => signal.removeEventListener("abort", onAbort),
  };
}

function ownedPromise(
  operation: () => PromiseLike<unknown> | void,
): Promise<void> {
  try {
    return Promise.resolve(operation()).then(
      () => undefined,
      () => undefined,
    );
  } catch {
    return Promise.resolve();
  }
}

function terminalDraft(record: ReviewerTerminalRecord): EventDraft {
  if (record.status === "completed") {
    return {
      event: "reviewer.completed",
      reviewer_id: record.reviewer_id,
      data: {
        adapter: record.adapter,
        model: record.model,
        isolation: record.isolation,
        elapsed_ms: record.elapsed_ms,
        result: record.result,
      },
    };
  }
  return {
    event: "reviewer.incomplete",
    reviewer_id: record.reviewer_id,
    data: {
      adapter: record.adapter,
      model: record.model,
      ...(record.isolation === undefined
        ? {}
        : { isolation: record.isolation }),
      elapsed_ms: record.elapsed_ms,
      reason: record.reason,
      message: record.message,
      retryable: record.retryable,
    },
  };
}

export async function runReviewRound({
  runId,
  config,
  context,
  registry,
  writer,
  signal,
  clock = globalClock,
}: RunReviewRoundInput): Promise<RunCompletion> {
  const startedAt = clock.now();
  const state = createSuiteState(config.reviewers, clock.now);
  let writerUsable = true;
  let interrupted = signal.aborted;
  const active = new Map<string, ActiveJob>();
  const activeProbes = new Set<string>();
  const finalizing = new Set<string>();
  let preflightHeartbeat: ReturnType<typeof setInterval> | undefined;
  const preflightHeartbeatEmissions = new Set<Promise<void>>();
  let preflightHeartbeatCursor = 0;

  const settleWithin = async (
    operation: PromiseLike<unknown>,
    maximumMs: number,
  ): Promise<"fulfilled" | "rejected" | "timeout"> => {
    const observed = Promise.resolve(operation).then(
      () => "fulfilled" as const,
      () => "rejected" as const,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      observed,
      new Promise<"timeout">((resolve) => {
        timer = clock.setTimeout(() => resolve("timeout"), maximumMs);
      }),
    ]);
    if (timer !== undefined) clock.clearTimeout(timer);
    return outcome;
  };

  const emit = async (draft: EventDraft): Promise<void> => {
    if (!writerUsable) return;
    let emission: PromiseLike<unknown>;
    try {
      emission = writer.emit(draft);
    } catch {
      writerUsable = false;
      return;
    }
    const outcome = await settleWithin(
      emission,
      config.execution.shutdown_grace_period_ms,
    );
    if (outcome !== "fulfilled") writerUsable = false;
  };

  const emitHeartbeat = (draft: EventDraft): Promise<void> => {
    if (!writerUsable) return Promise.resolve();
    let emission: PromiseLike<unknown>;
    try {
      emission = writer.emit(draft);
    } catch {
      writerUsable = false;
      return Promise.resolve();
    }
    return settleWithin(
      emission,
      config.execution.shutdown_grace_period_ms,
    ).then((outcome) => {
      if (outcome !== "fulfilled") writerUsable = false;
    });
  };

  const terminalRecord = (reviewerId: string): ReviewerTerminalRecord => {
    return reviewerTerminalRecord(state, reviewerId);
  };

  const heartbeatSuite = () => {
    const summary = summarizeSuite(state);
    const activeIds = new Set([...active.keys(), ...activeProbes]);
    summary.queued = state.reviewers.filter(
      (reviewer) =>
        reviewer.status !== "completed" &&
        reviewer.status !== "incomplete" &&
        !activeIds.has(reviewer.reviewer.id),
    ).length;
    summary.running = state.reviewers.filter(
      (reviewer) =>
        reviewer.status !== "completed" &&
        reviewer.status !== "incomplete" &&
        activeIds.has(reviewer.reviewer.id),
    ).length;
    return summary;
  };

  const clearPreflightHeartbeat = (): void => {
    if (preflightHeartbeat === undefined) return;
    clock.clearInterval(preflightHeartbeat);
    preflightHeartbeat = undefined;
  };

  const startPreflightHeartbeat = (): void => {
    preflightHeartbeat = clock.setInterval(() => {
      if (preflightHeartbeatEmissions.size > 0) return;
      const candidates = state.reviewers.filter(
        (reviewer) =>
          reviewer.status === "queued" || reviewer.status === "probing",
      );
      if (candidates.length === 0) return;
      const current = candidates[preflightHeartbeatCursor % candidates.length]!;
      preflightHeartbeatCursor += 1;
      const heartbeat = emitHeartbeat({
        event: "reviewer.heartbeat",
        reviewer_id: current.reviewer.id,
        data: {
          phase: phaseForHeartbeat(state, current.reviewer.id),
          elapsed_ms: Math.max(
            0,
            clock.now().getTime() -
              (current.startedAt ?? current.queuedAt).getTime(),
          ),
          ...(current.lastActivity === undefined
            ? {}
            : {
                last_activity_at: current.lastActivity.at.toISOString(),
                last_activity_message: current.lastActivity.message,
              }),
          suite: heartbeatSuite(),
          ...(current.isolation === undefined
            ? {}
            : { isolation: current.isolation }),
        },
      });
      preflightHeartbeatEmissions.add(heartbeat);
      void heartbeat.finally(() =>
        preflightHeartbeatEmissions.delete(heartbeat),
      );
    }, config.execution.heartbeat_interval_ms);
  };

  const stopPreflightHeartbeat = async (): Promise<void> => {
    clearPreflightHeartbeat();
    const pendingHeartbeats = [...preflightHeartbeatEmissions];
    preflightHeartbeatEmissions.clear();
    if (pendingHeartbeats.length === 0) return;
    const outcome = await settleWithin(
      Promise.allSettled(pendingHeartbeats),
      config.execution.shutdown_grace_period_ms,
    );
    if (outcome === "timeout") writerUsable = false;
  };

  const stopRuntimeTimers = async (runtime: ActiveJob): Promise<void> => {
    if (runtime.deadline !== undefined) {
      clock.clearTimeout(runtime.deadline);
      delete runtime.deadline;
    }
    if (runtime.heartbeat !== undefined) {
      clock.clearInterval(runtime.heartbeat);
      delete runtime.heartbeat;
    }
    const pendingHeartbeats = [...runtime.heartbeatEmissions];
    runtime.heartbeatEmissions.clear();
    if (pendingHeartbeats.length === 0) return;
    const outcome = await settleWithin(
      Promise.allSettled(pendingHeartbeats),
      config.execution.shutdown_grace_period_ms,
    );
    if (outcome === "timeout") writerUsable = false;
  };

  const waitAtMost = async (
    operation: PromiseLike<unknown>,
    maximumMs: number,
  ): Promise<void> => {
    await settleWithin(operation, maximumMs);
  };

  const cleanupRuntime = (runtime: ActiveJob): Promise<void> => {
    if (runtime.cleanup !== undefined) return runtime.cleanup;
    const cleanup =
      runtime.job.adapter?.forceCleanup === undefined
        ? Promise.resolve()
        : waitAtMost(
            ownedPromise(() => runtime.job.adapter!.forceCleanup!()),
            config.execution.shutdown_grace_period_ms,
          );
    runtime.cleanup = cleanup;
    return cleanup;
  };

  const cleanupWithinBound = async (
    runtimes: readonly ActiveJob[],
  ): Promise<void> => {
    await Promise.all(runtimes.map((runtime) => cleanupRuntime(runtime)));
  };

  const requestIteratorReturn = (runtime: ActiveJob): void => {
    if (
      runtime.iteratorReturnRequested ||
      runtime.iterator?.return === undefined
    ) {
      return;
    }
    runtime.iteratorReturnRequested = true;
    void ownedPromise(() => runtime.iterator!.return!());
  };

  const finalizeIncomplete = async (
    reviewerId: string,
    failure: AdapterFailure,
    isolation?: IsolationLevel,
  ): Promise<void> => {
    const current = state.reviewer(reviewerId);
    if (
      current.status === "completed" ||
      current.status === "incomplete" ||
      finalizing.has(reviewerId)
    )
      return;
    finalizing.add(reviewerId);
    const runtime = active.get(reviewerId);
    if (runtime !== undefined) await stopRuntimeTimers(runtime);
    state.incomplete(reviewerId, failure, isolation);
    await emit(terminalDraft(terminalRecord(reviewerId)));
  };

  const finalizeResult = async (
    reviewer: ResolvedReviewer,
    result: unknown,
    isolation: IsolationLevel,
  ): Promise<void> => {
    const current = state.reviewer(reviewer.id);
    if (
      current.status === "completed" ||
      current.status === "incomplete" ||
      finalizing.has(reviewer.id)
    )
      return;
    finalizing.add(reviewer.id);
    const runtime = active.get(reviewer.id);
    if (runtime !== undefined) await stopRuntimeTimers(runtime);
    if (
      reviewer.isolationPolicy === "require_enforced" &&
      isolation !== "enforced_read_only"
    ) {
      state.incomplete(
        reviewer.id,
        adapterFailure.unavailable(
          "The adapter did not achieve the required enforced read-only isolation.",
        ),
        isolation,
      );
      await emit(terminalDraft(terminalRecord(reviewer.id)));
      return;
    }
    const parsed = reviewerResultSchema.safeParse(result);
    if (!parsed.success) {
      state.incomplete(
        reviewer.id,
        adapterFailure.invalidResult(
          "The adapter returned an invalid reviewer result.",
        ),
        isolation,
      );
      await emit(terminalDraft(terminalRecord(reviewer.id)));
      return;
    }
    state.complete(reviewer.id, parsed.data, isolation);
    await emit(terminalDraft(terminalRecord(reviewer.id)));
  };

  const abortActive = () => {
    interrupted = true;
    for (const runtime of active.values()) {
      runtime.controller.abort(signal.reason);
    }
  };
  signal.addEventListener("abort", abortActive, { once: true });

  try {
    await emit({
      event: "run.started",
      data: { consistency_mode: "live_worktree" },
    });
    await emit({
      event: "context.resolved",
      data: { context: structuredClone(context) as unknown as JsonValue },
    });
    await emit({
      event: "suite.resolved",
      data: {
        total: config.reviewers.length,
        execution: { ...config.execution },
        ...(config.selection === undefined
          ? {}
          : {
              selection: {
                source: config.selection.source,
                ...(config.selection.projectName === undefined
                  ? {}
                  : { project_name: config.selection.projectName }),
                ...(config.selection.projectNameSource === undefined
                  ? {}
                  : {
                      project_name_source: config.selection.projectNameSource,
                    }),
                ...(config.selection.matchedProjectName === undefined
                  ? {}
                  : {
                      matched_project_name: config.selection.matchedProjectName,
                    }),
              },
            }),
        reviewers: config.reviewers.map((reviewer) => ({
          id: reviewer.id,
          purpose: reviewer.purpose,
          adapter: reviewer.adapterId,
          adapter_type: reviewer.adapter.type,
          model: reviewer.model,
          ...(reviewer.effort === undefined ? {} : { effort: reviewer.effort }),
          isolation_policy: reviewer.isolationPolicy,
          timeout_ms: reviewer.timeoutMs,
          instruction_sources: reviewer.instruction_layers.map(
            (layer) => layer.source,
          ),
        })),
      },
    });
    startPreflightHeartbeat();

    const jobs: ReviewerJob[] = config.reviewers.map((reviewer) => {
      try {
        return {
          reviewer,
          adapter: registry.create(reviewer.adapterId, reviewer.adapter),
        };
      } catch (error) {
        return {
          reviewer,
          creationFailure: adapterFailure.unavailable(
            error instanceof Error ? error.message : error,
          ),
        };
      }
    });

    const probeStarted = jobs.map(() => false);
    const probeSettled = jobs.map(() => false);
    const probeOperations: Array<Promise<void> | undefined> = jobs.map(
      () => undefined,
    );
    const probeCleanup: Array<Promise<void> | undefined> = jobs.map(
      () => undefined,
    );
    const cleanupProbe = (job: ReviewerJob, index: number): Promise<void> => {
      if (
        !probeStarted[index] ||
        probeSettled[index] ||
        job.adapter?.forceCleanup === undefined
      ) {
        return Promise.resolve();
      }
      const existing = probeCleanup[index];
      if (existing !== undefined) return existing;
      const cleanup = waitAtMost(
        ownedPromise(() => job.adapter!.forceCleanup!()),
        config.execution.shutdown_grace_period_ms,
      );
      probeCleanup[index] = cleanup;
      return cleanup;
    };
    const probeAbort = signalPromise(signal);
    const probe = async (
      job: ReviewerJob,
      index: number,
    ): Promise<AdapterCapabilities> => {
      if (job.creationFailure !== undefined) {
        probeSettled[index] = true;
        probeOperations[index] = Promise.resolve();
        throw job.creationFailure;
      }
      probeStarted[index] = true;
      const controller = new AbortController();
      const unlink = linkAbort(signal, controller);
      const localAbort = signalPromise(controller.signal);
      let timedOut = false;
      const deadline = clock.setTimeout(
        () => {
          timedOut = true;
          controller.abort(
            new Error("Adapter capability probe deadline expired."),
          );
        },
        Math.min(job.reviewer.timeoutMs, MAX_PROBE_TIMEOUT_MS),
      );
      let operation: Promise<AdapterCapabilities>;
      try {
        operation = Promise.resolve(
          job.adapter!.probe(job.reviewer, controller.signal),
        );
      } catch (error) {
        operation = Promise.reject(error);
      }
      const observed = operation.then(
        (value) => ({ type: "result" as const, value }),
        (error: unknown) => ({ type: "error" as const, error }),
      );
      probeOperations[index] = observed.then(() => {
        probeSettled[index] = true;
      });
      try {
        const outcome = await Promise.race([
          observed,
          localAbort.promise.then(() => ({ type: "abort" as const })),
        ]);
        if (timedOut) {
          await cleanupProbe(job, index);
          throw new ProbeTimeoutError(
            "The adapter capability probe exceeded the reviewer deadline.",
          );
        }
        if (outcome.type === "abort") {
          throw adapterFailure.cancelled();
        }
        if (outcome.type === "error") throw outcome.error;
        return outcome.value;
      } finally {
        clock.clearTimeout(deadline);
        localAbort.dispose();
        unlink();
      }
    };
    const probeOutcomes: PromiseSettledResult<AdapterCapabilities>[] =
      new Array(jobs.length);
    let nextProbe = 0;
    const probeWorkers = Array.from(
      { length: Math.min(config.execution.max_concurrency, jobs.length) },
      () => {
        return (async () => {
          while (!interrupted) {
            const index = nextProbe;
            const job = jobs[index];
            if (job === undefined) return;
            nextProbe += 1;
            state.transition(job.reviewer.id, "probing");
            activeProbes.add(job.reviewer.id);
            const probingMessage =
              "Checking the configured adapter, authentication, model, and isolation capability.";
            state.recordActivity(job.reviewer.id, probingMessage);
            await emit({
              event: "reviewer.progress",
              reviewer_id: job.reviewer.id,
              data: { phase: "probing", message: probingMessage },
            });
            try {
              probeOutcomes[index] = {
                status: "fulfilled",
                value: await probe(job, index),
              };
            } catch (reason) {
              probeOutcomes[index] = { status: "rejected", reason };
            } finally {
              activeProbes.delete(job.reviewer.id);
            }
          }
        })();
      },
    );
    const probesPromise = Promise.all(probeWorkers).then(() => probeOutcomes);
    await Promise.race([probesPromise, probeAbort.promise]);
    probeAbort.dispose();
    if (interrupted && probeSettled.some((settled) => !settled)) {
      await stopPreflightHeartbeat();
      const activeProbeOperations = probeOperations.filter(
        (operation): operation is Promise<void> => operation !== undefined,
      );
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.all(activeProbeOperations),
        new Promise<void>((resolve) => {
          graceTimer = clock.setTimeout(
            resolve,
            config.execution.shutdown_grace_period_ms,
          );
        }),
      ]);
      if (graceTimer !== undefined) clock.clearTimeout(graceTimer);
      await Promise.all(jobs.map((job, index) => cleanupProbe(job, index)));
    }
    const completedProbeResults = interrupted ? undefined : await probesPromise;
    const available: ReviewerJob[] = [];
    for (
      let index = 0;
      completedProbeResults !== undefined && index < jobs.length;
      index += 1
    ) {
      const job = jobs[index]!;
      const probe = completedProbeResults[index]!;
      if (probe.status === "rejected") {
        const failure =
          job.creationFailure ??
          (probe.reason instanceof ProbeTimeoutError
            ? adapterFailure.timeout(probe.reason.message)
            : adapterFailure.unavailable(
                probe.reason instanceof Error
                  ? probe.reason.message
                  : probe.reason,
              ));
        await finalizeIncomplete(
          job.reviewer.id,
          interrupted ? adapterFailure.cancelled() : failure,
        );
        continue;
      }
      state.setCapabilities(job.reviewer.id, probe.value);
      const failure = probeFailure(probe.value);
      if (failure !== undefined)
        await finalizeIncomplete(job.reviewer.id, failure);
      else {
        state.transition(job.reviewer.id, "queued");
        const queuedMessage = "Ready and waiting for an execution slot.";
        state.recordActivity(job.reviewer.id, queuedMessage);
        await emit({
          event: "reviewer.progress",
          reviewer_id: job.reviewer.id,
          data: { phase: "queued", message: queuedMessage },
        });
        available.push(job);
      }
    }

    let nextJob = 0;
    const execute = async (job: ReviewerJob): Promise<void> => {
      const reviewer = job.reviewer;
      const controller = new AbortController();
      const unlink = linkAbort(signal, controller);
      let releaseShutdown!: () => void;
      const shutdownReleased = new Promise<void>((resolve) => {
        releaseShutdown = resolve;
      });
      const runtime: ActiveJob = {
        job,
        controller,
        iteratorReturnRequested: false,
        heartbeatEmissions: new Set(),
        timedOut: false,
        shutdownReleased,
        releaseShutdown,
      };
      active.set(reviewer.id, runtime);
      try {
        if (interrupted) {
          await finalizeIncomplete(reviewer.id, adapterFailure.cancelled());
          return;
        }
        state.transition(reviewer.id, "starting");
        if (
          !state.reviewers.some(
            (candidate) =>
              candidate.status === "queued" || candidate.status === "probing",
          )
        ) {
          clearPreflightHeartbeat();
        }
        await emit({
          event: "reviewer.started",
          reviewer_id: reviewer.id,
          data: {
            purpose: reviewer.purpose,
            adapter: reviewer.adapterId,
            model: reviewer.model,
            ...(reviewer.effort === undefined
              ? {}
              : { effort: reviewer.effort }),
            isolation_policy: reviewer.isolationPolicy,
            timeout_ms: reviewer.timeoutMs,
          },
        });
        state.transition(reviewer.id, "reviewing");

        runtime.deadline = clock.setTimeout(() => {
          runtime.timedOut = true;
          controller.abort(new Error("Reviewer deadline expired."));
        }, reviewer.timeoutMs);
        runtime.heartbeat = clock.setInterval(() => {
          const current = state.reviewer(reviewer.id);
          if (current.status === "completed" || current.status === "incomplete")
            return;
          if (runtime.heartbeatEmissions.size > 0) return;
          const heartbeat = emitHeartbeat({
            event: "reviewer.heartbeat",
            reviewer_id: reviewer.id,
            data: {
              phase: phaseForHeartbeat(state, reviewer.id),
              elapsed_ms: Math.max(
                0,
                clock.now().getTime() -
                  (current.startedAt ?? startedAt).getTime(),
              ),
              ...(current.lastActivity === undefined
                ? {}
                : {
                    last_activity_at: current.lastActivity.at.toISOString(),
                    last_activity_message: current.lastActivity.message,
                  }),
              suite: heartbeatSuite(),
              ...(current.isolation === undefined
                ? {}
                : { isolation: current.isolation }),
            },
          });
          runtime.heartbeatEmissions.add(heartbeat);
          void heartbeat.finally(() =>
            runtime.heartbeatEmissions.delete(heartbeat),
          );
        }, config.execution.heartbeat_interval_ms);

        const prompt = buildReviewerPrompt({
          reviewer,
          context,
          ...(config.project_context === undefined
            ? {}
            : { projectContext: config.project_context }),
          resultJsonSchema: reviewerResultJsonSchema,
        });
        let terminal:
          Extract<AdapterEvent, { type: "result" | "failure" }> | undefined;
        let duplicateTerminal = false;
        let iteratorAbort:
          { promise: Promise<void>; dispose(): void } | undefined;
        try {
          const stream = job.adapter!.run({
            runId,
            reviewer,
            context,
            prompt,
            resultJsonSchema: reviewerResultJsonSchema,
            isolationPolicy: reviewer.isolationPolicy,
            signal: controller.signal,
          });
          const iterator = stream[Symbol.asyncIterator]();
          runtime.iterator = iterator;
          iteratorAbort = signalPromise(controller.signal);
          for (;;) {
            const next = iterator.next();
            const outcome = await Promise.race([
              next.then(
                (result) => ({ type: "next" as const, result }),
                (error: unknown) => ({ type: "error" as const, error }),
              ),
              iteratorAbort.promise.then(() => ({ type: "abort" as const })),
            ]);
            if (outcome.type === "abort") {
              if (runtime.timedOut) {
                let nextSettled = false;
                const ownedNext = next.then(
                  () => {
                    nextSettled = true;
                  },
                  () => {
                    nextSettled = true;
                  },
                );
                await waitAtMost(
                  ownedNext,
                  config.execution.shutdown_grace_period_ms,
                );
                if (!nextSettled) {
                  await cleanupWithinBound([runtime]);
                }
                requestIteratorReturn(runtime);
                break;
              }
              await Promise.race([
                next.catch(() => undefined),
                runtime.shutdownReleased,
              ]);
              break;
            }
            if (outcome.type === "error") throw outcome.error;
            if (outcome.result.done) break;
            const event = outcome.result.value;
            if (event.type === "activity" || event.type === "progress") {
              const message = boundedMessage(event.message);
              if (message !== undefined)
                state.recordActivity(reviewer.id, message);
              if (
                event.type === "progress" &&
                event.phase === "validating" &&
                state.reviewer(reviewer.id).status === "reviewing"
              ) {
                state.transition(reviewer.id, "validating");
              }
              await emit({
                event: "reviewer.progress",
                reviewer_id: reviewer.id,
                data: {
                  phase: phaseForHeartbeat(state, reviewer.id),
                  ...(message === undefined ? {} : { message }),
                },
              });
              continue;
            }
            if (terminal !== undefined) {
              duplicateTerminal = true;
              continue;
            }
            terminal = event;
            if (event.isolation !== undefined)
              state.setIsolation(reviewer.id, event.isolation);
          }
        } catch (error) {
          if (!controller.signal.aborted) {
            await finalizeIncomplete(
              reviewer.id,
              adapterFailure.processCrashed(
                error instanceof Error ? error.message : error,
              ),
            );
            return;
          }
        } finally {
          iteratorAbort?.dispose();
        }

        if (interrupted) {
          await finalizeIncomplete(reviewer.id, adapterFailure.cancelled());
        } else if (runtime.timedOut) {
          await finalizeIncomplete(
            reviewer.id,
            adapterFailure.timeout(
              "The reviewer exceeded its configured deadline.",
            ),
          );
        } else if (duplicateTerminal || terminal === undefined) {
          await finalizeIncomplete(
            reviewer.id,
            adapterFailure.protocolViolation(
              duplicateTerminal
                ? "The adapter emitted more than one terminal event."
                : "The adapter stream ended without a terminal event.",
            ),
            terminal?.isolation,
          );
        } else if (
          reviewer.isolationPolicy === "require_enforced" &&
          terminal.isolation !== "enforced_read_only"
        ) {
          await finalizeIncomplete(
            reviewer.id,
            adapterFailure.unavailable(
              "The adapter did not achieve the required enforced read-only isolation.",
            ),
            terminal.isolation,
          );
        } else if (terminal.type === "failure") {
          await finalizeIncomplete(
            reviewer.id,
            normalizeFailure(terminal.failure),
            terminal.isolation,
          );
        } else {
          if (state.reviewer(reviewer.id).status === "reviewing") {
            state.transition(reviewer.id, "validating");
          }
          await finalizeResult(reviewer, terminal.result, terminal.isolation);
        }
      } finally {
        await stopRuntimeTimers(runtime);
        unlink();
        active.delete(reviewer.id);
      }
    };

    const workers = Array.from(
      { length: Math.min(config.execution.max_concurrency, available.length) },
      () => {
        return (async () => {
          while (!interrupted) {
            const job = available[nextJob];
            if (job === undefined) return;
            nextJob += 1;
            await execute(job);
          }
        })();
      },
    );
    const workersPromise = Promise.allSettled(workers);
    let workersSettled = false;
    void workersPromise.then(() => {
      workersSettled = true;
    });

    if (!interrupted) {
      let abortResolve!: () => void;
      const aborted = new Promise<void>((resolve) => {
        abortResolve = resolve;
      });
      const onAbort = () => abortResolve();
      signal.addEventListener("abort", onAbort, { once: true });
      await Promise.race([workersPromise, aborted]);
      signal.removeEventListener("abort", onAbort);
    }

    if (interrupted) {
      if (!workersSettled) {
        let graceTimer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          workersPromise,
          new Promise<void>((resolve) => {
            graceTimer = clock.setTimeout(
              resolve,
              config.execution.shutdown_grace_period_ms,
            );
          }),
        ]);
        if (graceTimer !== undefined) clock.clearTimeout(graceTimer);
      }
      if (!workersSettled) {
        await cleanupWithinBound([...active.values()]);
        for (const runtime of active.values()) {
          requestIteratorReturn(runtime);
          runtime.releaseShutdown();
        }
        await workersPromise;
      }
      for (const runtime of active.values()) await stopRuntimeTimers(runtime);
      for (const reviewer of state.reviewers) {
        if (
          reviewer.status !== "completed" &&
          reviewer.status !== "incomplete"
        ) {
          await finalizeIncomplete(
            reviewer.reviewer.id,
            adapterFailure.cancelled(),
          );
        }
      }
    } else {
      await workersPromise;
    }
    await stopPreflightHeartbeat();
    const aggregate = aggregateRun(state);
    const totalElapsedMs = Math.max(
      0,
      clock.now().getTime() - startedAt.getTime(),
    );
    const exitCode = exitCodeFor(aggregate.status, interrupted);
    await emit({
      event: "run.completed",
      data: {
        status: aggregate.status,
        exit_code: exitCode,
        consistency_mode: "live_worktree",
        total_elapsed_ms: totalElapsedMs,
        suite: summarizeSuite(state),
        reviewers: aggregate.reviewers,
      },
    });
    return {
      status: aggregate.status,
      exitCode,
      reviewers: aggregate.reviewers,
      totalElapsedMs,
    };
  } finally {
    signal.removeEventListener("abort", abortActive);
    await stopPreflightHeartbeat();
    for (const runtime of active.values()) await stopRuntimeTimers(runtime);
    const closeOutcome = await settleWithin(
      Promise.resolve().then(() => writer.close()),
      config.execution.shutdown_grace_period_ms,
    );
    if (closeOutcome !== "fulfilled") writerUsable = false;
    if (!writerUsable) {
      throw new Error("The public event stream became unavailable.");
    }
  }
}
