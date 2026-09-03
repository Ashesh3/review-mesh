import {
  adapterFailure,
  sanitizeAdapterFailure,
  sanitizePublicText,
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
  incompleteReasonSchema,
  reviewerPhaseSchema,
  reviewerResultSchema,
  reviewerResultV2Schema,
  type IsolationLevel,
  type JsonValue,
  type ReviewerMode,
  type ReviewerPhase,
  type ReviewerSkipReason,
  type ReviewerTerminalRecord,
  type RunStatus,
} from "../protocol/schemas.js";
import {
  aggregateRun,
  createSuiteState,
  exitCodeFor,
  reviewerTerminalRecord,
  summarizeLogicalLenses,
  summarizeSuite,
  type SuiteState,
} from "./state.js";
import {
  DEFAULT_GATE_THRESHOLDS,
  evaluateLensPolicy,
  evaluatePassQuorum,
  meetsGateThresholds,
  type LensPolicy,
} from "./lens-policy.js";

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
  parentRunId?: string;
  onlyLensIds?: readonly string[];
  reportPath?: string;
  config: ResolvedConfig;
  context: ResolvedContext;
  registry: AdapterRegistry;
  writer: EventWriter;
  signal: AbortSignal;
  clock: OrchestratorClock;
  random?: () => number;
}

export interface RunCompletion {
  status: RunStatus;
  gateOutcome: "no_findings" | "findings";
  coverageOutcome: "complete" | "partial";
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
  reviewer: ResolvedReviewer;
  controller: AbortController;
  iterator?: AsyncIterator<AdapterEvent>;
  phase: ReviewerPhase;
  startedAt: Date;
  deadlineAt: number;
  lastActivityAt: Date;
  lastActivityMessage?: string;
  timedOut: boolean;
  cleanup?: Promise<void>;
}

interface ModelExecution {
  outcome: "pass" | "findings" | "incomplete";
  failure?: AdapterFailure;
}

interface ProviderCircuit {
  failures: number;
  state: "closed" | "open" | "half_open";
  openedAt?: number;
  causedByReviewerId?: string;
  halfOpenReviewerId?: string;
}

interface AttemptRecord {
  attempt: number;
  startedAt: string;
  elapsedMs: number;
  failure: AdapterFailure;
}

const MAX_PROBE_TIMEOUT_MS = 30_000;
const MAX_UNTRUSTED_RETRY_AFTER_MS = 60_000;

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

function lensId(reviewer: ResolvedReviewer): string {
  return reviewer.agentId ?? reviewer.id;
}

function providerGroup(reviewer: ResolvedReviewer): string {
  return reviewer.providerGroup ?? reviewer.adapterId;
}

function reviewerMode(reviewer: ResolvedReviewer): ReviewerMode {
  return reviewer.policy?.mode ?? "full_review";
}

function boundedMessage(message: unknown): string | undefined {
  if (typeof message !== "string") return undefined;
  const value = message.trim().slice(0, 1_000);
  return value.length === 0 ? undefined : value;
}

function normalizeFailure(value: unknown): AdapterFailure {
  if (typeof value !== "object" || value === null) {
    return adapterFailure.unknown(value);
  }
  const candidate = value as Partial<AdapterFailure>;
  const reason = incompleteReasonSchema.safeParse(candidate.reason);
  if (!reason.success) return adapterFailure.unknown(candidate.message);
  return sanitizeAdapterFailure(
    reason.data,
    candidate.message,
    candidate.retryable === true,
    {
      ...(candidate.fallback_eligible === undefined
        ? {}
        : { fallback_eligible: candidate.fallback_eligible }),
      ...(candidate.circuit_qualifying === undefined
        ? {}
        : { circuit_qualifying: candidate.circuit_qualifying }),
      ...(candidate.diagnostics === undefined
        ? {}
        : { diagnostics: candidate.diagnostics }),
    },
  );
}

function probeFailure(
  capabilities: AdapterCapabilities,
): AdapterFailure | undefined {
  if (capabilities.authenticated === false) {
    return adapterFailure.authentication(
      capabilities.message ?? "Adapter authentication is unavailable.",
      false,
      { diagnostics: { failure_stage: "probe", scope: "provider" } },
    );
  }
  if (capabilities.model_available === false) {
    return adapterFailure.modelUnavailable(
      capabilities.message ?? "The configured model is unavailable.",
      false,
      { diagnostics: { failure_stage: "probe", scope: "model" } },
    );
  }
  if (!capabilities.available) {
    return adapterFailure.unavailable(
      capabilities.message ?? "The adapter is unavailable.",
      capabilities.retryable === true,
      { diagnostics: { failure_stage: "probe", scope: "adapter" } },
    );
  }
  return undefined;
}

function linkAbort(parent: AbortSignal, child: AbortController): () => void {
  const abort = () => child.abort(parent.reason);
  if (parent.aborted) abort();
  else parent.addEventListener("abort", abort, { once: true });
  return () => parent.removeEventListener("abort", abort);
}

function abortPromise(signal: AbortSignal): {
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

function delay(
  clock: OrchestratorClock,
  signal: AbortSignal,
  milliseconds: number,
): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      clock.clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve(value);
    };
    const abort = () => finish(false);
    const timer = clock.setTimeout(() => finish(true), milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}

function compactContext(
  context: ResolvedContext,
  detailRef?: string,
): EventDraft {
  const git = context.git;
  const changedFiles = git.is_repository ? git.changed_files : [];
  return {
    event: "context.resolved",
    data: {
      workspace: context.workspace,
      project_name: context.project_name,
      review_scope: {
        mode: context.review_scope.mode,
        ...(context.review_scope.paths === undefined
          ? {}
          : { paths: [...context.review_scope.paths] }),
      },
      git: git.is_repository
        ? {
            is_repository: true,
            branch: git.branch,
            head: git.head,
            merge_base: git.merge_base,
            changed_files_count: changedFiles.length,
            changed_files: changedFiles.slice(0, 25),
            diff_stat: git.diff_stat.slice(0, 4 * 1_024),
            truncated:
              git.truncated.changed_files ||
              git.truncated.diff_stat ||
              git.truncated.diff,
          }
        : {
            is_repository: false,
            changed_files_count: 0,
            changed_files: [],
            truncated: false,
          },
      ...(detailRef === undefined ? {} : { detail_ref: detailRef }),
    },
  };
}

function policyFor(
  reviewer: ResolvedReviewer,
  _modelCount: number,
): LensPolicy {
  const policy = reviewer.policy;
  return {
    ...(policy?.applicability === undefined
      ? {}
      : { applicability: policy.applicability }),
    ...(policy?.requiredCallerContext === undefined
      ? {}
      : { requiredCallerContext: policy.requiredCallerContext }),
    pass: {
      passQuorum: policy?.passQuorum ?? _modelCount,
      minimumProviderGroups: policy?.minimumProviderGroups ?? 1,
    },
    gate: {
      minimumSeverity:
        policy?.gateMinimumSeverity ?? DEFAULT_GATE_THRESHOLDS.minimumSeverity,
      minimumConfidence:
        policy?.gateMinimumConfidence ??
        DEFAULT_GATE_THRESHOLDS.minimumConfidence,
    },
  };
}

function gateFindingCount(reviewer: ResolvedReviewer, result: unknown): number {
  const parsed = reviewerResultSchema.safeParse(result);
  if (!parsed.success) return 0;
  const policy = policyFor(reviewer, reviewer.modelCount ?? 1);
  return parsed.data.actionable_findings.filter(
    (finding) =>
      finding.severity !== "low" &&
      (!("classification" in finding) ||
        finding.classification !== "advisory") &&
      meetsGateThresholds(
        {
          severity: finding.severity,
          confidence:
            "confidence" in finding &&
            (finding.confidence === "high" ||
              finding.confidence === "medium" ||
              finding.confidence === "low")
              ? finding.confidence
              : "medium",
        },
        policy.gate,
      ),
  ).length;
}

function circuitKey(reviewer: ResolvedReviewer): string {
  return providerGroup(reviewer);
}

function circuitQualifying(failure: AdapterFailure): boolean {
  if (failure.circuit_qualifying !== undefined)
    return failure.circuit_qualifying;
  if (failure.diagnostics?.scope === "run_input") return false;
  if (
    failure.reason === "invalid_result" ||
    failure.reason === "protocol_violation" ||
    failure.reason === "authentication_failed" ||
    failure.reason === "model_unavailable" ||
    failure.reason === "read_failure" ||
    failure.reason === "cancelled"
  )
    return false;
  return (
    failure.diagnostics?.scope === "provider" ||
    failure.retryable === true ||
    failure.reason === "timeout" ||
    failure.reason === "process_crashed"
  );
}

function retryBackoffMs(
  failure: AdapterFailure,
  attempt: number,
  baseMs: number,
  random: () => number,
): number {
  const exponential = Math.min(2_147_483_647, baseMs * 2 ** (attempt - 1));
  const jittered = Math.floor(
    exponential * (0.5 + Math.max(0, Math.min(1, random()))),
  );
  const boundedRetryAfter = Math.min(
    failure.diagnostics?.retry_after_ms ?? 0,
    Math.max(baseMs, MAX_UNTRUSTED_RETRY_AFTER_MS),
  );
  return Math.max(jittered, boundedRetryAfter);
}

class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly maximum: number) {}

  async acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) throw adapterFailure.cancelled();
    if (this.active < this.maximum) {
      this.active += 1;
      return () => this.release();
    }
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        const index = this.waiting.indexOf(resolve);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(adapterFailure.cancelled());
      };
      signal.addEventListener("abort", abort, { once: true });
      this.waiting.push(() => {
        signal.removeEventListener("abort", abort);
        resolve();
      });
    });
    this.active += 1;
    return () => this.release();
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    this.waiting.shift()?.();
  }
}

export async function runReviewRound({
  runId,
  parentRunId,
  onlyLensIds,
  reportPath,
  config,
  context,
  registry,
  writer,
  signal,
  clock = globalClock,
  random = Math.random,
}: RunReviewRoundInput): Promise<RunCompletion> {
  const startedAt = clock.now();
  const state = createSuiteState(config.reviewers, clock.now);
  const active = new Map<string, ActiveJob>();
  const attemptHistory = new Map<string, AttemptRecord[]>();
  const circuits = new Map<string, ProviderCircuit>();
  const providerSemaphores = new Map<string, Semaphore>();
  let interrupted = signal.aborted;
  let writerUsable = true;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const circuitAdmission = (
    reviewer: ResolvedReviewer,
  ): { allowed: boolean; causedByReviewerId?: string } => {
    const circuit = circuits.get(circuitKey(reviewer));
    if (circuit === undefined || circuit.state === "closed")
      return { allowed: true };
    if (circuit.state === "half_open") {
      if (circuit.halfOpenReviewerId === reviewer.id) return { allowed: true };
      return {
        allowed: false,
        ...(circuit.causedByReviewerId === undefined
          ? {}
          : { causedByReviewerId: circuit.causedByReviewerId }),
      };
    }
    if (
      clock.now().getTime() - (circuit.openedAt ?? 0) <
      config.execution.circuit_breaker_cooldown_ms
    ) {
      return {
        allowed: false,
        ...(circuit.causedByReviewerId === undefined
          ? {}
          : { causedByReviewerId: circuit.causedByReviewerId }),
      };
    }
    circuit.state = "half_open";
    circuit.halfOpenReviewerId = reviewer.id;
    circuits.set(circuitKey(reviewer), circuit);
    return { allowed: true };
  };

  const recordCircuitSuccess = (reviewer: ResolvedReviewer): void => {
    circuits.delete(circuitKey(reviewer));
  };

  const recordCircuitFailure = (
    reviewer: ResolvedReviewer,
    failure: AdapterFailure,
  ): void => {
    const key = circuitKey(reviewer);
    const previous = circuits.get(key);
    if (!circuitQualifying(failure)) {
      if (previous?.state === "half_open") circuits.delete(key);
      return;
    }
    const failures = (previous?.failures ?? 0) + 1;
    const opens =
      previous?.state === "half_open" ||
      failures >= config.execution.circuit_breaker_threshold;
    circuits.set(key, {
      failures,
      state: opens ? "open" : "closed",
      ...(opens ? { openedAt: clock.now().getTime() } : {}),
      causedByReviewerId: reviewer.id,
    });
  };

  const emit = async (draft: EventDraft): Promise<void> => {
    if (!writerUsable) return;
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        Promise.resolve(writer.emit(draft)).then(
          () => "complete" as const,
          () => "failed" as const,
        ),
        new Promise<"timeout">((resolve) => {
          timer = clock.setTimeout(
            () => resolve("timeout"),
            config.execution.shutdown_grace_period_ms,
          );
        }),
      ]);
      if (timer !== undefined) clock.clearTimeout(timer);
      if (outcome !== "complete") throw new Error("event write failed");
    } catch {
      writerUsable = false;
    }
  };

  const record = async (value: unknown): Promise<void> => {
    try {
      await writer.record?.(value);
    } catch {
      // Persistence is best-effort; public stream remains authoritative.
    }
  };

  const skipReviewer = async (
    reviewer: ResolvedReviewer,
    reason: ReviewerSkipReason,
    blockedByReviewerId?: string,
    missingInputs?: readonly string[],
  ): Promise<void> => {
    const current = state.reviewer(reviewer.id);
    if (["completed", "incomplete", "skipped"].includes(current.status)) return;
    state.skip(reviewer.id, reason, blockedByReviewerId, missingInputs);
    await emit({
      event: "reviewer.skipped",
      reviewer_id: reviewer.id,
      data: {
        lens_id: lensId(reviewer),
        mode: reviewerMode(reviewer),
        adapter: reviewer.adapterId,
        model: reviewer.model,
        provider_group: providerGroup(reviewer),
        elapsed_ms: 0,
        reason,
        ...(blockedByReviewerId === undefined
          ? {}
          : { blocked_by_reviewer_id: blockedByReviewerId }),
        ...(missingInputs === undefined
          ? {}
          : { missing_inputs: [...missingInputs] }),
      },
    });
  };

  const finalizeIncomplete = async (
    reviewer: ResolvedReviewer,
    failure: AdapterFailure,
    isolation?: IsolationLevel,
  ): Promise<void> => {
    const current = state.reviewer(reviewer.id);
    if (["completed", "incomplete", "skipped"].includes(current.status)) return;
    state.incomplete(reviewer.id, failure, isolation);
    const terminal = reviewerTerminalRecord(state, reviewer.id);
    await record({ record: "reviewer.terminal", run_id: runId, terminal });
    await emit({
      event: "reviewer.incomplete",
      reviewer_id: reviewer.id,
      data: {
        lens_id: lensId(reviewer),
        mode: reviewerMode(reviewer),
        adapter: reviewer.adapterId,
        model: reviewer.model,
        provider_group: providerGroup(reviewer),
        ...(isolation === undefined ? {} : { isolation }),
        elapsed_ms: terminal.elapsed_ms,
        reason: failure.reason,
        message: failure.message,
        retryable: failure.retryable,
        fallback_eligible: failure.fallback_eligible === true,
        ...(failure.circuit_qualifying === undefined
          ? {}
          : { circuit_qualifying: failure.circuit_qualifying }),
        ...(failure.diagnostics === undefined
          ? {}
          : { diagnostics: failure.diagnostics }),
        attempt_count: Math.max(1, current.attemptCount),
      },
    });
  };

  const finalizeResult = async (
    reviewer: ResolvedReviewer,
    result: unknown,
    isolation: IsolationLevel,
  ): Promise<ModelExecution> => {
    const parsed = reviewerResultV2Schema.safeParse(result);
    if (!parsed.success) {
      const failure = adapterFailure.invalidResult(
        "The adapter returned an invalid reviewer result.",
        false,
        {
          diagnostics: {
            failure_stage: "structured_result_parsing",
            scope: "provider",
          },
        },
      );
      await finalizeIncomplete(reviewer, failure, isolation);
      return { outcome: "incomplete", failure };
    }
    if (
      reviewer.isolationPolicy === "require_enforced" &&
      isolation !== "enforced_read_only"
    ) {
      const failure = adapterFailure.unavailable(
        "The adapter did not achieve the required enforced read-only isolation.",
        false,
        { fallback_eligible: true },
      );
      await finalizeIncomplete(reviewer, failure, isolation);
      return { outcome: "incomplete", failure };
    }
    state.complete(reviewer.id, parsed.data, isolation);
    const terminal = reviewerTerminalRecord(state, reviewer.id);
    await record({
      record: "reviewer.result",
      run_id: runId,
      reviewer_id: reviewer.id,
      lens_id: lensId(reviewer),
      mode: reviewerMode(reviewer),
      ...(reviewer.policy?.adjudicatesReviewerId === undefined
        ? {}
        : {
            adjudicates_reviewer_id: reviewer.policy.adjudicatesReviewerId,
          }),
      result: parsed.data,
    });
    await record({ record: "reviewer.terminal", run_id: runId, terminal });
    const gateFindings = gateFindingCount(reviewer, parsed.data);
    await emit({
      event: "reviewer.completed",
      reviewer_id: reviewer.id,
      data: {
        lens_id: lensId(reviewer),
        mode: reviewerMode(reviewer),
        adapter: reviewer.adapterId,
        model: reviewer.model,
        provider_group: providerGroup(reviewer),
        isolation,
        elapsed_ms: terminal.elapsed_ms,
        verdict: parsed.data.verdict,
        summary:
          sanitizePublicText(parsed.data.summary, 1_000) ??
          "Reviewer completed without a public summary.",
        actionable_findings: parsed.data.actionable_findings.length,
        gate_findings: gateFindings,
        informational_notes: parsed.data.informational_notes.length,
        ...(reportPath === undefined ? {} : { detail_ref: reportPath }),
      },
    });
    return { outcome: gateFindings > 0 ? "findings" : "pass" };
  };

  const cleanup = async (runtime: ActiveJob): Promise<void> => {
    if (runtime.cleanup !== undefined) return runtime.cleanup;
    runtime.cleanup = Promise.resolve(runtime.reviewer).then(async () => {
      const job = jobsById.get(runtime.reviewer.id);
      await job?.adapter?.forceCleanup?.().catch(() => undefined);
    });
    return runtime.cleanup;
  };

  const settleWithin = async (
    operation: PromiseLike<unknown>,
    maximumMs: number,
  ): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.resolve(operation).catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = clock.setTimeout(resolve, maximumMs);
      }),
    ]);
    if (timer !== undefined) clock.clearTimeout(timer);
  };

  const execute = async (
    job: ReviewerJob,
    lensDeadlineAt: number,
  ): Promise<ModelExecution> => {
    const reviewer = job.reviewer;
    const maximumAttempts = config.execution.retry_attempts;
    let lastFailure: AdapterFailure | undefined;
    let lastIsolation: IsolationLevel | undefined;
    for (
      let attempt = 1;
      attempt <= maximumAttempts && !interrupted;
      attempt += 1
    ) {
      const priorFailure = lastFailure;
      lastFailure = undefined;
      lastIsolation = undefined;
      const nowMs = clock.now().getTime();
      const remainingLensMs = Math.max(0, lensDeadlineAt - nowMs);
      if (remainingLensMs === 0) {
        lastFailure = adapterFailure.timeout(
          "The logical lens deadline expired.",
        );
        break;
      }
      const remainingAttempts = maximumAttempts - attempt + 1;
      const attemptTimeoutMs = Math.min(
        reviewer.attemptTimeoutMs ??
          Math.max(1, Math.floor(reviewer.timeoutMs / remainingAttempts)),
        remainingLensMs,
      );
      const controller = new AbortController();
      const unlink = linkAbort(signal, controller);
      const runtime: ActiveJob = {
        reviewer,
        controller,
        phase: "starting",
        startedAt: clock.now(),
        deadlineAt: nowMs + attemptTimeoutMs,
        lastActivityAt: clock.now(),
        timedOut: false,
      };
      active.set(reviewer.id, runtime);
      const timeout = clock.setTimeout(() => {
        runtime.timedOut = true;
        controller.abort(new Error("Reviewer attempt deadline expired."));
        if (heartbeat !== undefined) {
          clock.clearInterval(heartbeat);
          heartbeat = undefined;
        }
      }, attemptTimeoutMs);
      let releaseProvider: (() => void) | undefined;
      const attemptStartedAt = clock.now();
      try {
        state.transition(reviewer.id, "starting");
        await emit({
          event: "reviewer.started",
          reviewer_id: reviewer.id,
          data: {
            lens_id: lensId(reviewer),
            mode: reviewerMode(reviewer),
            attempt,
            maximum_attempts: maximumAttempts,
            purpose: reviewer.purpose,
            adapter: reviewer.adapterId,
            model: reviewer.model,
            provider_group: providerGroup(reviewer),
            ...(reviewer.effort === undefined
              ? {}
              : { effort: reviewer.effort }),
            isolation_policy: reviewer.isolationPolicy,
            attempt_timeout_ms: attemptTimeoutMs,
            lens_deadline_remaining_ms: remainingLensMs,
          },
        });
        const semaphore =
          providerSemaphores.get(providerGroup(reviewer)) ??
          new Semaphore(
            config.execution.provider_limits[providerGroup(reviewer)] ??
              config.execution.default_provider_concurrency,
          );
        providerSemaphores.set(providerGroup(reviewer), semaphore);
        releaseProvider = await semaphore.acquire(controller.signal);
        const admission = circuitAdmission(reviewer);
        if (!admission.allowed) {
          lastFailure = sanitizeAdapterFailure(
            priorFailure?.reason ?? "adapter_unavailable",
            priorFailure === undefined
              ? "The provider circuit opened before this queued review could start."
              : `${priorFailure.message} A retry was not attempted because the provider circuit opened.`,
            false,
            {
              fallback_eligible: priorFailure?.fallback_eligible ?? true,
              circuit_qualifying: false,
              diagnostics: {
                ...(priorFailure?.diagnostics ?? {}),
                failure_stage: "circuit_breaker",
                scope: "provider",
                retry_blocked_by_circuit: true,
                ...(admission.causedByReviewerId === undefined
                  ? {}
                  : {
                      circuit_caused_by_reviewer_id:
                        admission.causedByReviewerId,
                    }),
              },
            },
          );
        }
        if (lastFailure !== undefined) continue;
        state.transition(reviewer.id, "reviewing");
        runtime.phase = "reviewing";
        const prompt = buildReviewerPrompt({
          reviewer,
          context,
          ...(config.project_context === undefined
            ? {}
            : { projectContext: config.project_context }),
          resultJsonSchema: reviewerResultJsonSchema,
        });
        let iterator: AsyncIterator<AdapterEvent> | undefined;
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
          iterator = stream[Symbol.asyncIterator]();
        } catch (error) {
          lastFailure = adapterFailure.processCrashed(
            error instanceof Error ? error.message : error,
          );
        }
        if (iterator !== undefined) {
          runtime.iterator = iterator;
          let terminal:
            Extract<AdapterEvent, { type: "result" | "failure" }> | undefined;
          let duplicateTerminal = false;
          const iteratorAbort = abortPromise(controller.signal);
          for (;;) {
            const next = iterator.next();
            const outcome = await Promise.race([
              next.then(
                (value) => ({ type: "next" as const, value }),
                (error: unknown) => ({ type: "error" as const, error }),
              ),
              iteratorAbort.promise.then(() => ({ type: "abort" as const })),
            ]);
            if (outcome.type === "abort") {
              void next.catch(() => undefined);
              break;
            }
            if (outcome.type === "error") {
              lastFailure = adapterFailure.processCrashed(
                outcome.error instanceof Error
                  ? outcome.error.message
                  : outcome.error,
              );
              break;
            }
            if (outcome.value.done) break;
            const event = outcome.value.value;
            if (event.type === "activity" || event.type === "progress") {
              const message = boundedMessage(event.message);
              if (message !== undefined) {
                state.recordActivity(reviewer.id, message);
                runtime.lastActivityAt = clock.now();
                runtime.lastActivityMessage = message;
                await record({
                  record: "reviewer.activity",
                  run_id: runId,
                  reviewer_id: reviewer.id,
                  lens_id: lensId(reviewer),
                  phase: runtime.phase,
                  type: event.type,
                  timestamp: runtime.lastActivityAt.toISOString(),
                  message,
                });
              }
              if (event.type === "progress") {
                const phase = reviewerPhaseSchema.safeParse(event.phase);
                if (phase.success) runtime.phase = phase.data;
                if (
                  phase.success &&
                  phase.data === "validating" &&
                  state.reviewer(reviewer.id).status === "reviewing"
                ) {
                  state.transition(reviewer.id, "validating");
                }
                await emit({
                  event: "reviewer.progress",
                  reviewer_id: reviewer.id,
                  data: {
                    lens_id: lensId(reviewer),
                    mode: reviewerMode(reviewer),
                    phase: phase.success ? phase.data : "reviewing",
                    ...(message === undefined ? {} : { message }),
                  },
                });
              }
              continue;
            }
            if (terminal !== undefined) duplicateTerminal = true;
            else terminal = event;
          }
          iteratorAbort.dispose();
          if (controller.signal.aborted) {
            void iterator.return?.().catch(() => undefined);
            await settleWithin(
              delay(
                clock,
                new AbortController().signal,
                config.execution.shutdown_grace_period_ms,
              ),
              config.execution.shutdown_grace_period_ms,
            );
            void cleanup(runtime);
          }
          if (interrupted) lastFailure = adapterFailure.cancelled();
          else if (runtime.timedOut)
            lastFailure = adapterFailure.timeout(
              "The reviewer attempt exceeded its deadline.",
            );
          else if (
            lastFailure === undefined &&
            (duplicateTerminal || terminal === undefined)
          ) {
            lastFailure = adapterFailure.protocolViolation(
              duplicateTerminal
                ? "The adapter emitted more than one terminal event."
                : "The adapter stream ended without a terminal event.",
            );
          } else if (
            lastFailure === undefined &&
            terminal?.type === "failure"
          ) {
            lastFailure = normalizeFailure(terminal.failure);
            lastIsolation = terminal.isolation;
          } else if (lastFailure === undefined && terminal?.type === "result") {
            const result = await finalizeResult(
              reviewer,
              terminal.result,
              terminal.isolation,
            );
            recordCircuitSuccess(reviewer);
            return result;
          }
        }
      } finally {
        releaseProvider?.();
        clock.clearTimeout(timeout);
        unlink();
        active.delete(reviewer.id);
      }
      if (lastFailure !== undefined) {
        const history = attemptHistory.get(reviewer.id) ?? [];
        history.push({
          attempt,
          startedAt: attemptStartedAt.toISOString(),
          elapsedMs: Math.max(
            0,
            clock.now().getTime() - attemptStartedAt.getTime(),
          ),
          failure: lastFailure,
        });
        attemptHistory.set(reviewer.id, history);
        await record({
          record: "reviewer.attempt",
          run_id: runId,
          reviewer_id: reviewer.id,
          lens_id: lensId(reviewer),
          ...history.at(-1),
        });
      }
      if (
        lastFailure?.retryable !== true ||
        attempt === maximumAttempts ||
        interrupted
      )
        break;
      const retryMessage = `Retrying after a transient reviewer failure (attempt ${attempt + 1} of ${maximumAttempts}).`;
      state.recordActivity(reviewer.id, retryMessage);
      await emit({
        event: "reviewer.progress",
        reviewer_id: reviewer.id,
        data: {
          lens_id: lensId(reviewer),
          mode: reviewerMode(reviewer),
          phase: "starting",
          message: retryMessage,
        },
      });
      const remainingAfterAttempt = Math.max(
        0,
        lensDeadlineAt - clock.now().getTime(),
      );
      const backoffMs = retryBackoffMs(
        lastFailure,
        attempt,
        config.execution.retry_backoff_ms,
        random,
      );
      if (
        remainingAfterAttempt === 0 ||
        backoffMs >= remainingAfterAttempt ||
        !(await delay(clock, signal, backoffMs))
      )
        break;
    }
    const failure =
      lastFailure ?? adapterFailure.unknown("The reviewer failed.");
    await finalizeIncomplete(reviewer, failure, lastIsolation);
    return { outcome: "incomplete", failure };
  };

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
  const jobsById = new Map(jobs.map((job) => [job.reviewer.id, job]));
  const chains = new Map<string, ReviewerJob[]>();
  for (const job of jobs) {
    const id = lensId(job.reviewer);
    const chain = chains.get(id) ?? [];
    chain.push(job);
    chains.set(id, chain);
  }
  for (const chain of chains.values()) {
    chain.sort(
      (left, right) =>
        (left.reviewer.modelIndex ?? 0) - (right.reviewer.modelIndex ?? 0),
    );
  }

  const abort = () => {
    interrupted = true;
    for (const runtime of active.values()) {
      runtime.controller.abort(signal.reason);
    }
  };
  signal.addEventListener("abort", abort, { once: true });

  try {
    await emit({
      event: "run.started",
      data: {
        consistency_mode: "live_worktree",
        ...(parentRunId === undefined ? {} : { parent_run_id: parentRunId }),
      },
    });
    await record({
      record: "request",
      run_id: runId,
      request: {
        schema_version: "2",
        project_name: context.project_name,
        workspace: context.workspace,
        instructions: context.instructions,
        review_scope:
          context.review_scope.mode === "changes"
            ? {
                mode: "changes",
                ...(context.git.is_repository && context.git.base !== undefined
                  ? { base: context.git.base.requested }
                  : context.review_scope.base === undefined
                    ? {}
                    : { base: context.review_scope.base }),
                ...(context.git.is_repository && context.git.head !== null
                  ? { head: context.git.head }
                  : context.review_scope.head === undefined
                    ? {}
                    : { head: context.review_scope.head }),
                ...(context.git.is_repository && context.git.branch !== null
                  ? { branch: context.git.branch }
                  : context.review_scope.branch === undefined
                    ? {}
                    : { branch: context.review_scope.branch }),
                ...(context.review_scope.paths === undefined
                  ? {}
                  : { paths: context.review_scope.paths }),
              }
            : {
                mode: "full",
                ...(context.review_scope.paths === undefined
                  ? {}
                  : { paths: context.review_scope.paths }),
              },
        ...(context.caller_context === undefined
          ? {}
          : { context: context.caller_context }),
      },
    });
    await record({
      record: "context",
      context: structuredClone(context) as unknown as JsonValue,
    });
    await emit(compactContext(context, reportPath));
    await emit({
      event: "suite.resolved",
      data: {
        logical_lenses: chains.size,
        model_runs: config.reviewers.length,
        execution: {
          max_concurrency: config.execution.max_concurrency,
          heartbeat_interval_ms: config.execution.heartbeat_interval_ms,
          shutdown_grace_period_ms: config.execution.shutdown_grace_period_ms,
          distribute_primaries: config.execution.distribute_primaries,
          default_provider_concurrency:
            config.execution.default_provider_concurrency,
          provider_limits: { ...config.execution.provider_limits },
          circuit_breaker_threshold: config.execution.circuit_breaker_threshold,
          circuit_breaker_cooldown_ms:
            config.execution.circuit_breaker_cooldown_ms,
          retry_attempts: config.execution.retry_attempts,
          retry_backoff_ms: config.execution.retry_backoff_ms,
        },
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
        lenses: [...chains.entries()].map(([id, chain]) => {
          const policy = policyFor(chain[0]!.reviewer, chain.length);
          return {
            id,
            purpose: chain[0]!.reviewer.purpose,
            model_runs: chain.length,
            pass_quorum: policy.pass.passQuorum,
            minimum_provider_groups: policy.pass.minimumProviderGroups,
            adjudication: chain[0]!.reviewer.policy?.adjudication ?? "off",
          };
        }),
      },
    });
    heartbeat = clock.setInterval(() => {
      if (!writerUsable) return;
      const now = clock.now();
      const probing = state.reviewers.filter(
        (reviewer) => reviewer.status === "probing",
      );
      const modelRuns = summarizeSuite(state);
      modelRuns.running = active.size + probing.length;
      void emit({
        event: "suite.heartbeat",
        data: {
          elapsed_ms: Math.max(0, now.getTime() - startedAt.getTime()),
          logical_lenses: summarizeLogicalLenses(state),
          model_runs: modelRuns,
          active: [
            ...[...active.values()].map((runtime) => ({
              reviewer_id: runtime.reviewer.id,
              lens_id: lensId(runtime.reviewer),
              mode: reviewerMode(runtime.reviewer),
              phase: runtime.phase,
              elapsed_ms: Math.max(
                0,
                now.getTime() - runtime.startedAt.getTime(),
              ),
              stale_ms: Math.max(
                0,
                now.getTime() - runtime.lastActivityAt.getTime(),
              ),
              deadline_remaining_ms: Math.max(
                0,
                runtime.deadlineAt - now.getTime(),
              ),
              ...(runtime.lastActivityMessage === undefined
                ? {}
                : { last_activity_message: runtime.lastActivityMessage }),
            })),
            ...probing.map((item) => ({
              reviewer_id: item.reviewer.id,
              lens_id: lensId(item.reviewer),
              mode: reviewerMode(item.reviewer),
              phase: "probing" as const,
              elapsed_ms: Math.max(
                0,
                now.getTime() - (item.startedAt ?? item.queuedAt).getTime(),
              ),
              stale_ms: Math.max(
                0,
                now.getTime() -
                  (
                    item.lastActivity?.at ??
                    item.startedAt ??
                    item.queuedAt
                  ).getTime(),
              ),
              deadline_remaining_ms: item.reviewer.timeoutMs,
              ...(item.lastActivity === undefined
                ? {}
                : { last_activity_message: item.lastActivity.message }),
            })),
          ].slice(0, 64),
        },
      });
    }, config.execution.heartbeat_interval_ms);

    const runnableChains: ReviewerJob[][] = [];
    const onlyLenses =
      onlyLensIds === undefined ? undefined : new Set(onlyLensIds);
    for (const chain of chains.values()) {
      const first = chain[0]!;
      if (onlyLenses !== undefined && !onlyLenses.has(lensId(first.reviewer))) {
        for (const job of chain)
          await skipReviewer(job.reviewer, "not_selected_for_retry");
        continue;
      }
      const policy = policyFor(first.reviewer, chain.length);
      const changedPaths = context.git.is_repository
        ? context.git.changed_files
        : [];
      const applicability = evaluateLensPolicy(policy, {
        reviewScopeMode:
          context.git.is_repository && context.git.truncated.changed_files
            ? "full"
            : context.review_scope.mode,
        changedPaths,
        callerContext: context.caller_context,
      });
      if (applicability.status === "not_applicable") {
        for (const job of chain)
          await skipReviewer(job.reviewer, "not_applicable");
        continue;
      }
      if (applicability.status === "not_evaluated_missing_input") {
        for (const job of chain) {
          await skipReviewer(
            job.reviewer,
            "not_evaluated_missing_input",
            undefined,
            applicability.missingCallerContext,
          );
        }
        continue;
      }
      runnableChains.push(chain);
    }

    let nextChain = 0;
    const workers = Array.from(
      {
        length: Math.min(
          config.execution.max_concurrency,
          runnableChains.length,
        ),
      },
      () =>
        (async () => {
          while (!interrupted) {
            const chain = runnableChains[nextChain++];
            if (chain === undefined) return;
            const lensDeadlineAt =
              clock.now().getTime() +
              chain.reduce((total, job) => total + job.reviewer.timeoutMs, 0);
            const cleanPasses: Array<{ providerGroup: string }> = [];
            const policy = policyFor(chain[0]!.reviewer, chain.length);
            let lastFailedReviewer: string | undefined;
            let pendingAdjudication:
              | {
                  sourceReviewerId: string;
                  sourceResult: JsonValue;
                  sourceProviderGroup: string;
                }
              | undefined;
            for (
              let index = 0;
              index < chain.length && !interrupted;
              index += 1
            ) {
              const job = chain[index]!;
              const reviewer = job.reviewer;
              if (
                pendingAdjudication !== undefined &&
                providerGroup(reviewer) !==
                  pendingAdjudication.sourceProviderGroup
              ) {
                reviewer.policy = {
                  ...(reviewer.policy ?? {
                    passQuorum: policy.pass.passQuorum,
                    minimumProviderGroups: policy.pass.minimumProviderGroups,
                    adjudication: "required",
                    gateMinimumSeverity: policy.gate.minimumSeverity,
                    gateMinimumConfidence: policy.gate.minimumConfidence,
                  }),
                  mode: "adjudication",
                  adjudicatesReviewerId: pendingAdjudication.sourceReviewerId,
                  candidateFindings: pendingAdjudication.sourceResult,
                };
                state.setAdjudication(
                  reviewer.id,
                  pendingAdjudication.sourceReviewerId,
                );
              }
              if (index > 0) state.transition(reviewer.id, "queued");
              if (clock.now().getTime() >= lensDeadlineAt) {
                await finalizeIncomplete(
                  reviewer,
                  adapterFailure.timeout("The logical lens deadline expired."),
                );
                lastFailedReviewer = reviewer.id;
                continue;
              }
              const admission = circuitAdmission(reviewer);
              if (!admission.allowed) {
                await skipReviewer(
                  reviewer,
                  "circuit_open",
                  admission.causedByReviewerId ?? lastFailedReviewer,
                );
                continue;
              }
              state.transition(reviewer.id, "probing");
              let capabilities: AdapterCapabilities | undefined;
              let failure = job.creationFailure;
              if (failure === undefined) {
                const controller = new AbortController();
                const unlink = linkAbort(signal, controller);
                let probeTimedOut = false;
                const timeout = clock.setTimeout(
                  () => {
                    probeTimedOut = true;
                    controller.abort(new Error("Probe deadline expired."));
                  },
                  Math.min(
                    reviewer.attemptTimeoutMs ?? reviewer.timeoutMs,
                    MAX_PROBE_TIMEOUT_MS,
                  ),
                );
                try {
                  const operation = Promise.resolve(
                    job.adapter!.probe(reviewer, controller.signal),
                  );
                  const probeAbort = abortPromise(controller.signal);
                  const outcome = await Promise.race([
                    operation.then(
                      (value) => ({ type: "result" as const, value }),
                      (error: unknown) => ({ type: "error" as const, error }),
                    ),
                    probeAbort.promise.then(() => ({ type: "abort" as const })),
                  ]);
                  probeAbort.dispose();
                  if (outcome.type === "result") {
                    capabilities = outcome.value;
                    failure = probeFailure(capabilities);
                  } else if (outcome.type === "error") {
                    failure = adapterFailure.unavailable(
                      outcome.error instanceof Error
                        ? outcome.error.message
                        : outcome.error,
                      true,
                    );
                  } else {
                    void operation.catch(() => undefined);
                    failure = probeTimedOut
                      ? adapterFailure.timeout(
                          "The adapter capability probe exceeded its deadline.",
                        )
                      : adapterFailure.cancelled();
                    await job.adapter!.forceCleanup?.().catch(() => undefined);
                  }
                } catch (error) {
                  failure = controller.signal.aborted
                    ? adapterFailure.timeout(
                        "The adapter capability probe exceeded its deadline.",
                      )
                    : adapterFailure.unavailable(
                        error instanceof Error ? error.message : error,
                        true,
                      );
                } finally {
                  clock.clearTimeout(timeout);
                  unlink();
                }
              }
              if (failure !== undefined) {
                await finalizeIncomplete(reviewer, failure);
                lastFailedReviewer = reviewer.id;
                recordCircuitFailure(reviewer, failure);
                if (failure.fallback_eligible === true) {
                  continue;
                }
                for (const remaining of chain.slice(index + 1)) {
                  await skipReviewer(
                    remaining.reviewer,
                    "blocked_by_infrastructure_failure",
                    reviewer.id,
                  );
                }
                break;
              }
              if (capabilities !== undefined)
                state.setCapabilities(reviewer.id, capabilities);
              state.transition(reviewer.id, "queued");
              const result = await execute(job, lensDeadlineAt);
              if (result.outcome === "pass") {
                recordCircuitSuccess(reviewer);
                if (reviewerMode(reviewer) === "adjudication") {
                  pendingAdjudication = undefined;
                  for (const remaining of chain.slice(index + 1)) {
                    await skipReviewer(
                      remaining.reviewer,
                      "short_circuited_after_finding",
                      reviewer.id,
                    );
                  }
                  break;
                }
                cleanPasses.push({ providerGroup: providerGroup(reviewer) });
                if (evaluatePassQuorum(policy.pass, cleanPasses).satisfied) {
                  for (const remaining of chain.slice(index + 1)) {
                    await skipReviewer(
                      remaining.reviewer,
                      "not_needed_after_quorum",
                      reviewer.id,
                    );
                  }
                  break;
                }
                continue;
              }
              if (result.outcome === "findings") {
                recordCircuitSuccess(reviewer);
                const needsAdjudication =
                  reviewerMode(reviewer) === "full_review" &&
                  reviewer.policy?.adjudication === "required";
                if (needsAdjudication) {
                  pendingAdjudication = {
                    sourceReviewerId: reviewer.id,
                    sourceResult: structuredClone(
                      state.reviewer(reviewer.id).result?.actionable_findings ??
                        [],
                    ) as JsonValue,
                    sourceProviderGroup: providerGroup(reviewer),
                  };
                  const candidateIndex = chain
                    .slice(index + 1)
                    .findIndex(
                      (candidate) =>
                        providerGroup(candidate.reviewer) !==
                        providerGroup(reviewer),
                    );
                  const absoluteIndex =
                    candidateIndex < 0 ? -1 : index + 1 + candidateIndex;
                  if (absoluteIndex >= 0) {
                    const adjudicator = chain[absoluteIndex]!.reviewer;
                    const sourceResult = state.reviewer(reviewer.id).result;
                    adjudicator.policy = {
                      ...(adjudicator.policy ?? {
                        passQuorum: policy.pass.passQuorum,
                        minimumProviderGroups:
                          policy.pass.minimumProviderGroups,
                        adjudication: "required",
                        gateMinimumSeverity: policy.gate.minimumSeverity,
                        gateMinimumConfidence: policy.gate.minimumConfidence,
                      }),
                      mode: "adjudication",
                      adjudicatesReviewerId: reviewer.id,
                      candidateFindings: structuredClone(
                        sourceResult?.actionable_findings ?? [],
                      ) as JsonValue,
                    };
                    state.setAdjudication(adjudicator.id, reviewer.id);
                    for (
                      let skipped = index + 1;
                      skipped < absoluteIndex;
                      skipped += 1
                    ) {
                      await skipReviewer(
                        chain[skipped]!.reviewer,
                        "short_circuited_after_finding",
                        reviewer.id,
                      );
                    }
                    // A focused second-provider adjudicator reuses the bounded
                    // reviewer contract; its result confirms/rejects by finding
                    // versus clean pass, without introducing a new full sweep.
                    index = absoluteIndex - 1;
                    continue;
                  }
                }
                for (const remaining of chain.slice(index + 1)) {
                  await skipReviewer(
                    remaining.reviewer,
                    "short_circuited_after_finding",
                    reviewer.id,
                  );
                }
                break;
              }
              lastFailedReviewer = reviewer.id;
              if (result.failure !== undefined)
                recordCircuitFailure(reviewer, result.failure);
              if (result.failure?.fallback_eligible === true) {
                continue;
              }
              for (const remaining of chain.slice(index + 1)) {
                await skipReviewer(
                  remaining.reviewer,
                  "blocked_by_infrastructure_failure",
                  reviewer.id,
                );
              }
              break;
            }
          }
        })(),
    );
    await Promise.all(workers);

    if (interrupted) {
      for (const runtime of active.values()) {
        runtime.controller.abort(signal.reason);
        await settleWithin(
          cleanup(runtime),
          config.execution.shutdown_grace_period_ms,
        );
      }
      for (const reviewer of state.reviewers) {
        if (!["completed", "incomplete", "skipped"].includes(reviewer.status)) {
          await finalizeIncomplete(
            reviewer.reviewer,
            adapterFailure.cancelled(),
          );
        }
      }
    }
    const aggregate = aggregateRun(state);
    const totalElapsedMs = Math.max(
      0,
      clock.now().getTime() - startedAt.getTime(),
    );
    const exitCode = interrupted
      ? 4
      : exitCodeFor(aggregate.gateOutcome, aggregate.coverageOutcome);
    await emit({
      event: "run.completed",
      data: {
        gate_outcome: aggregate.gateOutcome,
        coverage_outcome: aggregate.coverageOutcome,
        exit_code: exitCode,
        consistency_mode: "live_worktree",
        total_elapsed_ms: totalElapsedMs,
        logical_lenses: aggregate.logicalLenses,
        model_runs: aggregate.modelRuns,
        unique_findings: aggregate.uniqueFindings,
        advisory_findings: aggregate.advisoryFindings,
        incomplete_lenses: aggregate.incompleteLenses,
        not_evaluated_lenses: aggregate.notEvaluatedLenses,
        ...(reportPath === undefined ? {} : { report_path: reportPath }),
        status: aggregate.status,
        suite: aggregate.modelRuns,
      },
    });
    return {
      status: aggregate.status,
      gateOutcome: aggregate.gateOutcome,
      coverageOutcome: aggregate.coverageOutcome,
      exitCode,
      reviewers: aggregate.reviewers,
      totalElapsedMs,
    };
  } finally {
    signal.removeEventListener("abort", abort);
    if (heartbeat !== undefined) clock.clearInterval(heartbeat);
    for (const runtime of active.values()) {
      runtime.controller.abort();
      await settleWithin(
        cleanup(runtime),
        config.execution.shutdown_grace_period_ms,
      );
    }
    await writer.close().catch(() => {
      writerUsable = false;
    });
    if (!writerUsable)
      throw new Error("The public event stream became unavailable.");
  }
}
