import { randomUUID } from "node:crypto";
import type { ResolvedConfig, ResolvedReviewer } from "../config/schemas.js";
import { describeTopology } from "../config/topology.js";
import type { ResolvedContext } from "../context/resolve.js";
import {
  createChangeCoverageLedger,
  releaseRunSnapshot,
  type ChangeCoverageLedger,
} from "../context/change-coverage.js";
import { evaluateRequiredInput } from "../context/required-input.js";
import {
  buildCanonicalRawFindings,
  buildAdjudicationCandidates,
  canonicalizeFindings,
  type CanonicalFindingCoreProof,
  type CanonicalRawFinding,
} from "../findings/canonical.js";
import { validateAdjudication } from "../findings/adjudication.js";
import { verifyAdjudicationEvidence } from "../findings/evidence-verifier.js";
import type { AdapterRegistry } from "../adapters/registry.js";
import type { AdapterEvent, ReviewAdapter } from "../adapters/types.js";
import {
  sanitizeAdapterFailure,
  sanitizePublicText,
  type AdapterFailure,
} from "../adapters/errors.js";
import {
  reviewerResultV4Schema,
  providerReviewerResultV4Schema,
  adjudicationResultV2Schema,
  type ReviewerResultV4,
  type AdjudicationResultV2,
  type V9IncompleteReason,
} from "../protocol/v9.js";
import { buildReviewerPrompt } from "../protocol/prompt.js";
import { resultPageJsonSchema } from "../protocol/json-schema.js";
import type { JsonValue } from "../protocol/schemas.js";
import {
  boundedList,
  createHeartbeatBudget,
  runOutcome,
} from "../protocol/concise.js";
import type {
  V9EventWriter,
  V9EventDraft,
} from "../protocol/v9-event-writer.js";
import { reviewerResultDigest } from "../results/digest.js";
import { sanitizedResultPages } from "../results/sanitized-pages.js";
import {
  ResultSanitizationError,
  sanitizeReviewerOutput,
} from "../results/sanitize.js";
import { selectRunDeadline, deadlineCause } from "./deadlines.js";
import { createActivityTracker } from "./activity.js";
import { changedPathMatchesGlob, evaluatePassQuorum } from "./lens-policy.js";

export interface V9RunInput {
  runId: string;
  config: ResolvedConfig;
  context: ResolvedContext;
  registry: AdapterRegistry;
  signal: AbortSignal;
  writer: V9EventWriter;
  record(record: Record<string, unknown>): Promise<void>;
  recordResult(
    reviewerId: string,
    result: ReviewerResultV4 | AdjudicationResultV2,
  ): Promise<void>;
  outputMode?: "concise-jsonl" | "compact-jsonl" | "full-jsonl";
  retry?: {
    parentRunId: string;
    runLensIds: readonly string[];
    inherited: ReadonlyArray<{
      reviewerId: string;
      lensId: string;
      result: ReviewerResultV4 | AdjudicationResultV2;
      resultDigest: string;
      resultByteCount: number;
      coverageEntries: readonly Record<string, unknown>[];
      terminal: Record<string, unknown>;
    }>;
    inheritance: "exact" | "rerun_all";
    rawFindings: readonly CanonicalRawFinding[];
    proofBySourceRef: Readonly<Record<string, CanonicalFindingCoreProof>>;
    adjudicationOutcomes: readonly Record<string, unknown>[];
  };
  now?: () => number;
}
interface Job {
  reviewer: ResolvedReviewer;
  status: "queued" | "running" | "completed" | "incomplete" | "skipped";
  phase: string;
  mode: "full_review" | "adjudication";
  attempt: number;
  startedAt: number;
  attemptStartedAt: number;
  attemptDeadline: number;
  lensDeadline: number;
  reason?: string;
  result?: ReviewerResultV4 | AdjudicationResultV2;
  ledger?: ChangeCoverageLedger;
  controller?: AbortController;
  adapter?: ReviewAdapter;
  progressObservable?: boolean;
  fallbackEligible?: boolean;
}
const lensId = (reviewer: ResolvedReviewer) => reviewer.agentId ?? reviewer.id;
const provider = (reviewer: ResolvedReviewer) =>
  reviewer.providerGroup ?? reviewer.adapterId;
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, Math.max(0, ms));
    signal?.addEventListener("abort", finish, { once: true });
  });
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("Aborted"));
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort))
      .catch(() => undefined);
  });
}

export async function runV9Review(input: V9RunInput) {
  const now = input.now ?? Date.now;
  const start = now();
  const execution = input.config.execution;
  const deadline = selectRunDeadline(
    input.context,
    execution.deadline_mode === "fixed"
      ? { deadline_mode: "fixed", run_deadline_ms: execution.run_deadline_ms! }
      : { deadline_mode: "adaptive" },
    new Date(start),
  );
  const runDeadline = Date.parse(deadline.deadline_at);
  const grace = execution.shutdown_grace_period_ms;
  const interval = Math.max(
    1000,
    Math.min(300000, execution.heartbeat_interval_ms),
  );
  const activity = createActivityTracker({
    startedAt: start,
    detail: input.config.diagnostics.activity_detail ?? "condensed",
  });
  const heartbeatBudget = createHeartbeatBudget({ intervalMs: interval });
  const controller = new AbortController();
  let callerCancelled = input.signal.aborted;
  const onCallerAbort = () => {
    callerCancelled = true;
    controller.abort(input.signal.reason);
  };
  if (input.signal.aborted) controller.abort(input.signal.reason);
  else input.signal.addEventListener("abort", onCallerAbort, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new Error("Run deadline exceeded.")),
    Math.max(0, runDeadline - now()),
  );
  const runLensIds =
    input.retry === undefined ? undefined : new Set(input.retry.runLensIds);
  const jobs: Job[] = input.config.reviewers
    .filter(
      (reviewer) =>
        runLensIds === undefined || runLensIds.has(lensId(reviewer)),
    )
    .map((reviewer) => ({
      reviewer,
      status: "queued",
      phase: "queued",
      mode: "full_review",
      attempt: 0,
      startedAt: start,
      attemptStartedAt: start,
      attemptDeadline: runDeadline,
      lensDeadline: Math.min(
        runDeadline,
        start + (reviewer.policy?.lensDeadlineMs ?? deadline.duration_ms),
      ),
    }));
  const chains = new Map<string, Job[]>();
  for (const job of jobs)
    chains.set(lensId(job.reviewer), [
      ...(chains.get(lensId(job.reviewer)) ?? []),
      job,
    ]);
  const warnings = [
    ...describeTopology(input.config),
    ...(input.config.migrationWarnings ?? []),
  ];
  const raw: CanonicalRawFinding[] = structuredClone([
    ...(input.retry?.rawFindings ?? []),
  ]);
  const proofBySourceRef: Record<string, CanonicalFindingCoreProof> =
    structuredClone(input.retry?.proofBySourceRef ?? {});
  const adjudicationOutcomes: Array<Record<string, unknown>> = structuredClone([
    ...(input.retry?.adjudicationOutcomes ?? []),
  ]);
  const lensStates = new Map<
    string,
    "passed" | "findings" | "incomplete" | "not_applicable" | "not_evaluated"
  >();
  const providerActive = new Map<string, number>();
  const capabilities = new Map<
    string,
    Awaited<ReturnType<ReviewAdapter["probe"]>>
  >();
  interface ProviderCircuit {
    failures: number;
    state: "closed" | "open" | "half_open";
    openedAt?: number;
    causedByReviewerId?: string;
    halfOpenReviewerId?: string;
  }
  const circuits = new Map<string, ProviderCircuit>();
  const cleanupTasks = new Set<Promise<void>>();
  const cleanupScheduled = new Set<ReviewAdapter>();
  let cleanupDeadline: number | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let pendingHeartbeat: Promise<void> | undefined;
  let completedResults = input.retry?.inherited.length ?? 0;
  let outputFailure = false;
  const mode = input.outputMode ?? "concise-jsonl";
  const circuitAdmission = (reviewer: ResolvedReviewer) => {
    const key = provider(reviewer);
    const circuit = circuits.get(key);
    if (circuit === undefined || circuit.state === "closed")
      return { allowed: true } as const;
    if (circuit.state === "half_open")
      return circuit.halfOpenReviewerId === reviewer.id
        ? ({ allowed: true } as const)
        : ({
            allowed: false,
            causedByReviewerId: circuit.causedByReviewerId,
          } as const);
    if (now() - (circuit.openedAt ?? 0) < execution.circuit_breaker_cooldown_ms)
      return {
        allowed: false,
        causedByReviewerId: circuit.causedByReviewerId,
      } as const;
    circuit.state = "half_open";
    circuit.halfOpenReviewerId = reviewer.id;
    return { allowed: true } as const;
  };
  const circuitQualifying = (failure: AdapterFailure) => {
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
      failure.retryable ||
      failure.reason === "process_crashed"
    );
  };
  const recordCircuitSuccess = (reviewer: ResolvedReviewer) => {
    circuits.delete(provider(reviewer));
  };
  const recordCircuitFailure = (
    reviewer: ResolvedReviewer,
    failure: AdapterFailure,
  ) => {
    const key = provider(reviewer);
    const previous = circuits.get(key);
    if (!circuitQualifying(failure)) {
      if (previous?.state === "half_open") circuits.delete(key);
      return;
    }
    const failures = (previous?.failures ?? 0) + 1;
    const opens =
      previous?.state === "half_open" ||
      failures >= execution.circuit_breaker_threshold;
    circuits.set(key, {
      failures,
      state: opens ? "open" : "closed",
      ...(opens ? { openedAt: now() } : {}),
      causedByReviewerId: reviewer.id,
    });
  };
  const scheduleCleanup = (adapter: ReviewAdapter | undefined) => {
    if (adapter?.forceCleanup === undefined || cleanupScheduled.has(adapter))
      return undefined;
    cleanupScheduled.add(adapter);
    const cleanup = Promise.resolve()
      .then(() => adapter.forceCleanup!())
      .catch(() => undefined)
      .finally(() => cleanupTasks.delete(cleanup));
    cleanupTasks.add(cleanup);
    return cleanup;
  };
  const awaitCleanup = async () => {
    if (cleanupTasks.size === 0 || grace <= 0) return;
    cleanupDeadline ??= now() + grace;
    const remaining = Math.max(0, cleanupDeadline - now());
    if (remaining === 0) return;
    await Promise.race([
      Promise.allSettled([...cleanupTasks]),
      delay(remaining),
    ]);
  };
  const emit = async (draft: V9EventDraft) => {
    try {
      await input.writer.emit(draft);
    } catch {
      outputFailure = true;
      controller.abort(new Error("Public output failed."));
    }
  };
  const modelCounts = () => ({
    total: jobs.length,
    completed: jobs.filter((job) => job.status === "completed").length,
    incomplete: jobs.filter((job) => job.status === "incomplete").length,
    skipped: jobs.filter((job) => job.status === "skipped").length,
    running: jobs.filter((job) => job.status === "running").length,
    queued: jobs.filter((job) => job.status === "queued").length,
  });
  const skip = async (
    job: Job,
    reason: string,
    missing?: ReturnType<typeof evaluateRequiredInput>,
  ) => {
    job.status = "skipped";
    job.phase = "terminal";
    job.reason = reason;
    await input.record({
      record: "reviewer.terminal",
      reviewer_id: job.reviewer.id,
      data: {
        status: "skipped",
        lens_id: lensId(job.reviewer),
        reason,
        ...(missing === undefined ? {} : { missing_inputs: missing }),
      },
    });
    await emit({
      event: "reviewer.skipped",
      reviewer_id: job.reviewer.id,
      data: {
        lens_id: lensId(job.reviewer),
        mode: job.mode,
        reason,
        detail_ref: "reviewer.terminal",
        ...(missing === undefined
          ? {}
          : {
              missing_inputs: missing.slice(0, 8),
              omitted_missing_inputs_count: Math.max(0, missing.length - 8),
            }),
      },
    });
  };
  const fail = async (job: Job, reason: string, message: string) => {
    const failurePhase = job.phase;
    job.status = "incomplete";
    job.phase = "terminal";
    job.reason = reason;
    await input.record({
      record: "reviewer.terminal",
      reviewer_id: job.reviewer.id,
      data: {
        status: "incomplete",
        lens_id: lensId(job.reviewer),
        reason,
        mode: job.mode,
      },
    });
    await emit({
      event: "reviewer.incomplete",
      reviewer_id: job.reviewer.id,
      data: {
        lens_id: lensId(job.reviewer),
        mode: job.mode,
        reason: reason as V9IncompleteReason,
        message: sanitizePublicText(message) ?? "Reviewer incomplete.",
        failure_stage: failurePhase,
        attempt_count: Math.max(1, job.attempt),
        retryable: false,
        fallback_eligible:
          reason !== "run_deadline_exceeded" && reason !== "cancelled",
        detail_ref: "reviewer.terminal",
        elapsed_ms: Math.max(0, now() - job.startedAt),
      },
    });
  };
  const changePolicy = (reviewer: ResolvedReviewer) =>
    reviewer.policy?.changeCoverage ?? {
      relevantPaths: ["**"],
      minimumInspection: "full_file" as const,
      proof:
        reviewer.adapter.type === "codex" || reviewer.adapter.type === "command"
          ? ("attested" as const)
          : ("observed" as const),
    };
  async function execute(
    job: Job,
    source?: { reviewer: ResolvedReviewer; result: ReviewerResultV4 },
  ): Promise<"pass" | "findings" | "incomplete"> {
    const reviewer = job.reviewer;
    job.mode = source ? "adjudication" : "full_review";
    job.adapter = input.registry.create(reviewer.adapterId, reviewer.adapter, {
      continuationAttempts: execution.continuation_attempts,
    });
    const candidateDeadline = Math.min(
      job.lensDeadline,
      start + reviewer.timeoutMs,
    );
    job.ledger = await createChangeCoverageLedger({
      context: input.context,
      policy: changePolicy(reviewer),
      signal: controller.signal,
    });
    const group = provider(reviewer);
    let adjudicationResult: ReviewerResultV4 | undefined;
    let candidates: ReturnType<typeof buildAdjudicationCandidates> | undefined;
    const limit =
      execution.provider_limits[group] ??
      execution.default_provider_concurrency;
    for (let attempt = 1; attempt <= execution.retry_attempts; attempt++) {
      job.attempt = attempt;
      job.phase = "probing";
      const boundary = Math.min(
        runDeadline,
        job.lensDeadline,
        candidateDeadline,
      );
      if (now() >= boundary || controller.signal.aborted) break;
      const child = new AbortController();
      job.controller = child;
      const onAbort = () => child.abort(controller.signal.reason);
      controller.signal.addEventListener("abort", onAbort, { once: true });
      const attemptDeadline = Math.min(
        boundary,
        now() + (reviewer.attemptTimeoutMs ?? reviewer.timeoutMs),
      );
      const timer = setTimeout(
        () => child.abort(new Error("Attempt deadline exceeded.")),
        Math.max(0, attemptDeadline - now()),
      );
      let progressTimer: ReturnType<typeof setInterval> | undefined;
      let admitted = false;
      let terminal:
        Extract<AdapterEvent, { type: "result" | "failure" }> | undefined;
      let resultStoragePersisted = false;
      let failure: AdapterFailure | undefined;
      const attemptId = String(attempt);
      try {
        let adapterCapabilities = capabilities.get(reviewer.id);
        if (adapterCapabilities === undefined) {
          adapterCapabilities = await abortable(
            job.adapter.probe(reviewer, child.signal),
            child.signal,
          );
          capabilities.set(reviewer.id, adapterCapabilities);
        }
        if (
          !adapterCapabilities.available ||
          adapterCapabilities.authenticated === false ||
          adapterCapabilities.model_available === false
        )
          failure = sanitizeAdapterFailure(
            !adapterCapabilities.available
              ? "adapter_unavailable"
              : adapterCapabilities.authenticated === false
                ? "authentication_failed"
                : "model_unavailable",
            adapterCapabilities.message ?? "Adapter is unavailable",
            adapterCapabilities.retryable === true,
          );
        if (
          !failure &&
          changePolicy(reviewer).proof === "observed" &&
          adapterCapabilities.observed_file_access !== true
        )
          failure = sanitizeAdapterFailure(
            "adapter_unavailable",
            "Adapter does not provide configured observed reads.",
            false,
          );
        if (!failure) {
          job.phase = "queued";
          while (
            (providerActive.get(group) ?? 0) >= limit &&
            !child.signal.aborted
          )
            await delay(10, child.signal);
          if (child.signal.aborted)
            throw new Error("Provider queue deadline exceeded");
          const admission = circuitAdmission(reviewer);
          if (!admission.allowed) {
            failure = sanitizeAdapterFailure(
              "adapter_unavailable",
              "The provider circuit opened before this queued review could start.",
              false,
              {
                fallback_eligible: true,
                circuit_qualifying: false,
                diagnostics: {
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
        }
        if (!failure) {
          providerActive.set(group, (providerActive.get(group) ?? 0) + 1);
          admitted = true;
          job.status = "running";
          job.attemptStartedAt = now();
          job.attemptDeadline = attemptDeadline;
          job.phase = "reviewing";
          job.progressObservable =
            adapterCapabilities.progress_observable === true;
          activity.admitAttempt(reviewer.id, attemptId, now());
          activity.record({
            reviewerId: reviewer.id,
            attemptId,
            phase: job.phase,
            at: now(),
          });
          if (job.progressObservable)
            progressTimer = setInterval(
              () => {
                if (
                  activity.snapshot(reviewer.id, now()).lastProgressAgeMs >=
                  (execution.no_progress_timeout_ms ?? 300000)
                )
                  child.abort(new Error("No progress timeout"));
              },
              Math.min(1000, execution.no_progress_timeout_ms ?? 300000),
            );
          await emit({
            event: "reviewer.started",
            reviewer_id: reviewer.id,
            data: {
              lens_id: lensId(reviewer),
              mode: job.mode,
              adapter: reviewer.adapterId,
              model: reviewer.model,
              provider_group: group,
              attempt,
              maximum_attempts: execution.retry_attempts,
              timeout_ms: Math.max(0, attemptDeadline - now()),
              run_deadline_remaining_ms: Math.max(0, runDeadline - now()),
              lens_deadline_remaining_ms: Math.max(0, job.lensDeadline - now()),
              progress_observable: job.progressObservable,
              proof: changePolicy(reviewer).proof,
            },
          });
          const sourceRaw = source
            ? buildCanonicalRawFindings({
                reviewer_id: source.reviewer.id,
                lens_id: lensId(source.reviewer),
                result: source.result,
              })
            : undefined;
          candidates =
            sourceRaw === undefined
              ? undefined
              : buildAdjudicationCandidates(sourceRaw);
          adjudicationResult =
            source === undefined || candidates === undefined
              ? undefined
              : reviewerResultV4Schema.parse({
                  ...source.result,
                  actionable_findings: candidates.candidates.map(
                    (candidate) => ({
                      id: candidate.candidate_id,
                      severity: candidate.finding.severity,
                      title: candidate.finding.title,
                      description: candidate.finding.description,
                      evidence: candidate.finding.evidence,
                      suggested_direction:
                        candidate.finding.suggested_direction,
                      confidence: candidate.finding.confidence,
                      classification: candidate.finding.classification,
                      external_assumptions:
                        candidate.finding.external_assumptions,
                      category: candidate.finding.category,
                      verification:
                        candidate.finding.verification ??
                        "Verify the canonical candidate evidence.",
                      ...(candidate.finding.change_impact === undefined
                        ? {}
                        : { change_impact: candidate.finding.change_impact }),
                      claim: candidate.finding.claim,
                    }),
                  ),
                });
          const resultPages = {
            resultId: randomUUID(),
            resultKind: source
              ? ("adjudication" as const)
              : ("reviewer" as const),
            ...(source
              ? {
                  candidateIds:
                    candidates?.candidates.map(
                      (candidate) => candidate.candidate_id,
                    ) ?? [],
                }
              : {}),
          };
          const effectiveReviewer = source
            ? {
                ...reviewer,
                policy: {
                  ...reviewer.policy!,
                  mode: "adjudication" as const,
                  adjudicatesReviewerId: source.reviewer.id,
                  candidateFindings: JSON.parse(
                    JSON.stringify(adjudicationResult!.actionable_findings),
                  ) as JsonValue,
                },
              }
            : reviewer;
          const prompt = buildReviewerPrompt({
            reviewer: effectiveReviewer,
            context: input.context,
            resultJsonSchema: resultPageJsonSchema,
            resultPage: {
              resultId: resultPages.resultId,
              pageIndex: 0,
              previousPageDigest: null,
              candidateIds: [],
            },
            coverage: {
              scopeDigest: job.ledger.scopeDigest,
              relevantPaths: job.ledger
                .entries()
                .filter((entry) => entry.relevant)
                .map((entry) => entry.path),
            },
          });
          const iterator = job.adapter
            .run({
              runId: input.runId,
              reviewer: effectiveReviewer,
              context: input.context,
              prompt,
              resultJsonSchema: resultPageJsonSchema,
              signal: child.signal,
              isolationPolicy: reviewer.isolationPolicy,
              coverage: job.ledger,
              resultPages,
            })
            [Symbol.asyncIterator]();
          try {
            for (;;) {
              const next = await abortable(iterator.next(), child.signal);
              if (next.done) break;
              const event = next.value;
              if (event.type === "result" || event.type === "failure") {
                if (terminal) throw new Error("Duplicate adapter terminal");
                terminal = event;
                continue;
              }
              const phase =
                event.type === "progress" &&
                [
                  "reviewing",
                  "validating",
                  "continuing",
                  "retry_backoff",
                  "finalizing",
                ].includes(event.phase)
                  ? event.phase
                  : job.phase;
              const changed = phase !== job.phase;
              job.phase = phase;
              activity.record({
                reviewerId: reviewer.id,
                attemptId,
                phase,
                at: now(),
                ...(event.message === undefined
                  ? {}
                  : { message: event.message }),
                ...(event.identity === undefined
                  ? {}
                  : {
                      progress: {
                        kind: event.byteCount === undefined ? "tool" : "bytes",
                        identity: event.identity,
                        ...(event.byteCount === undefined
                          ? {}
                          : { bytes: event.byteCount }),
                      },
                    }),
              });
              if (changed)
                await emit({
                  event: "reviewer.progress",
                  reviewer_id: reviewer.id,
                  data: {
                    lens_id: lensId(reviewer),
                    mode: job.mode,
                    phase: phase as "reviewing",
                    attempt,
                    maximum_attempts: execution.retry_attempts,
                  },
                });
            }
          } finally {
            if (child.signal.aborted)
              void iterator.return?.().catch(() => undefined);
          }
        }
        if (child.signal.aborted) {
          const reason =
            deadlineCause({
              now: now(),
              cancelled: input.signal.aborted,
              run: runDeadline,
              lens: job.lensDeadline,
              candidate: candidateDeadline,
              attempt: attemptDeadline,
              ...(job.progressObservable
                ? {
                    progress:
                      now() -
                      activity.snapshot(reviewer.id, now()).lastProgressAgeMs +
                      (execution.no_progress_timeout_ms ?? 300000),
                  }
                : {}),
            }) ??
            (admitted
              ? "attempt_deadline_exceeded"
              : "queue_deadline_exceeded");
          failure = sanitizeAdapterFailure(
            reason,
            "Reviewer exhausted its execution budget.",
            reason === "attempt_deadline_exceeded" ||
              reason === "no_progress_timeout",
          );
        } else if (terminal?.type === "failure")
          failure = sanitizeAdapterFailure(
            terminal.failure.reason,
            terminal.failure.message,
            terminal.failure.retryable,
            {
              ...(terminal.failure.fallback_eligible === undefined
                ? {}
                : {
                    fallback_eligible: terminal.failure.fallback_eligible,
                  }),
              ...(terminal.failure.circuit_qualifying === undefined
                ? {}
                : {
                    circuit_qualifying: terminal.failure.circuit_qualifying,
                  }),
              ...(terminal.failure.diagnostics === undefined
                ? {}
                : { diagnostics: terminal.failure.diagnostics }),
            },
          );
        else if (!failure && terminal?.type !== "result")
          failure = sanitizeAdapterFailure(
            "protocol_violation",
            "Adapter ended without a result.",
            false,
          );
        else if (!failure && terminal?.type === "result") {
          const sanitized = sanitizeReviewerOutput(terminal.result);
          const result = source
            ? adjudicationResultV2Schema.parse(sanitized)
            : providerReviewerResultV4Schema.parse(sanitized);
          let final: ReviewerResultV4 | AdjudicationResultV2;
          if (result.schema_version === "4") {
            if (result.coverage_attestation)
              job.ledger.reconcileAttestation(result.coverage_attestation);
            else if (
              changePolicy(reviewer).proof === "attested" &&
              job.ledger.summary().status !== "not_applicable"
            )
              throw new Error("Required coverage attestation missing.");
            final = reviewerResultV4Schema.parse({
              ...result,
              change_coverage: job.ledger.summary(),
            });
          } else final = result;
          await input.recordResult(reviewer.id, final);
          completedResults++;
          job.result = final;
          const entries = job.ledger.entries();
          for (let index = 0; index < entries.length; index += 256)
            await input.record({
              record: "reviewer.coverage",
              reviewer_id: reviewer.id,
              data: {
                index: index / 256,
                entries: entries.slice(index, index + 256),
              },
            });
          if (final.schema_version === "4") {
            const sourceRaw = buildCanonicalRawFindings({
              reviewer_id: reviewer.id,
              lens_id: lensId(reviewer),
              result: final,
            });
            raw.push(...sourceRaw);
            for (const finding of sourceRaw) {
              const evidencePaths = finding.evidence.flatMap((evidence) =>
                evidence.path ? [evidence.path] : [],
              );
              const evidence =
                evidencePaths.length > 0 &&
                evidencePaths.every((path) => job.ledger!.observedFile(path));
              const related =
                input.context.review_scope.mode === "full" ||
                evidencePaths.some((path) =>
                  entries.some(
                    (entry) => entry.path === path && entry.relevant,
                  ),
                );
              proofBySourceRef[finding.source_ref] = {
                evidence_verified: evidence,
                source_coverage_verified: evidence,
                change_impact_required:
                  input.context.review_scope.mode === "changes",
                change_impact_verified:
                  input.context.review_scope.mode === "full" || related,
                out_of_scope: !related,
                adjudication_required:
                  reviewer.policy?.adjudication === "required",
              };
            }
          } else if (source) {
            const verification = await verifyAdjudicationEvidence({
              workspace: input.context.workspace,
              adjudicationResult: final,
            });
            const outcome = validateAdjudication(adjudicationResult!, final, {
              reviewScope: input.context.review_scope.mode,
              evidenceVerification: verification,
              ...(input.context.git.is_repository
                ? {
                    git: {
                      changedFiles: input.context.git.changed_files,
                      diff: input.context.git.diff,
                    },
                  }
                : {}),
            });
            for (const decision of outcome.decisions) {
              const candidate = candidates!.candidates.find(
                (value) => value.candidate_id === decision.source_finding_id,
              );
              for (const sourceRef of candidate?.source_refs ?? []) {
                const finding = raw.find(
                  (item) => item.source_ref === sourceRef,
                );
                if (finding) finding.adjudication = decision.effective_decision;
                proofBySourceRef[sourceRef] = {
                  ...proofBySourceRef[sourceRef],
                  adjudication_required: !outcome.complete,
                  policy_non_gating: !decision.gate_eligible,
                };
              }
            }
            adjudicationOutcomes.push({
              adjudicator_reviewer_id: reviewer.id,
              source_reviewer_id: source.reviewer.id,
              complete: outcome.complete,
              decisions: structuredClone(outcome.decisions),
              unknown_source_finding_ids: structuredClone(
                outcome.unknown_source_finding_ids,
              ),
            });
            if (!outcome.complete)
              failure = sanitizeAdapterFailure(
                "invalid_result",
                "Required adjudication is incomplete.",
                false,
              );
          }
          if (mode === "full-jsonl")
            await emit({
              event: "reviewer.result",
              reviewer_id: reviewer.id,
              data: {
                lens_id: lensId(reviewer),
                mode: job.mode,
                digest: reviewerResultDigest(final),
                byte_count: Buffer.byteLength(JSON.stringify(final)),
                detail_ref: "reviewer.result",
                result: final,
              },
            });
          if (terminal.resultStorage?.pages !== undefined) {
            let index = 0;
            const pageResult =
              final.schema_version === "4"
                ? (({ change_coverage: _coverage, ...provider }) => provider)(
                    final,
                  )
                : final;
            for (const page of await sanitizedResultPages(
              terminal.resultStorage.pages(),
              pageResult,
            )) {
              await input.record({
                record: "reviewer.result_page",
                reviewer_id: reviewer.id,
                data: {
                  index,
                  raw: page.raw,
                  sha256: page.sha256,
                  serialization_boundary:
                    terminal.resultStorage.serializationBoundary ??
                    "provider_raw",
                },
              });
              index += 1;
            }
          }
          await terminal.resultStorage?.persisted();
          resultStoragePersisted = true;
          if (
            final.schema_version === "4" &&
            final.change_coverage.status === "incomplete"
          )
            failure = sanitizeAdapterFailure(
              "change_coverage_incomplete",
              "Relevant changed files were not fully inspected.",
              false,
            );
          if (!failure) {
            job.status = "completed";
            recordCircuitSuccess(reviewer);
            job.phase = "terminal";
            const proofs = Object.fromEntries(
              Object.entries(proofBySourceRef)
                .filter(([key]) => key.startsWith(`${reviewer.id}#`))
                .map(([key, value]) => [
                  key.slice(reviewer.id.length + 1),
                  value,
                ]),
            );
            await input.record({
              record: "reviewer.terminal",
              reviewer_id: reviewer.id,
              data: {
                status: "completed",
                lens_id: lensId(reviewer),
                mode: job.mode,
                finding_proofs: proofs,
              },
            });
            await emit({
              event: "reviewer.completed",
              reviewer_id: reviewer.id,
              data: {
                lens_id: lensId(reviewer),
                mode: job.mode,
                verdict: final.verdict,
                summary: final.summary,
                elapsed_ms: now() - job.attemptStartedAt,
                actionable_findings: final.actionable_findings.length,
                ...(final.schema_version === "4"
                  ? { change_coverage: final.change_coverage }
                  : {}),
                detail_ref: "reviewer.result",
              },
            });
            return final.verdict === "fail" ? "findings" : "pass";
          }
        }
      } catch (error) {
        const reason = child.signal.aborted
          ? (deadlineCause({
              now: now(),
              cancelled: input.signal.aborted,
              run: runDeadline,
              lens: job.lensDeadline,
              candidate: candidateDeadline,
              attempt: attemptDeadline,
              ...(job.progressObservable
                ? {
                    progress:
                      now() -
                      activity.snapshot(reviewer.id, now()).lastProgressAgeMs +
                      (execution.no_progress_timeout_ms ?? 300000),
                  }
                : {}),
            }) ?? "probe_deadline_exceeded")
          : error instanceof ResultSanitizationError
            ? "result_too_large"
            : "invalid_result";
        failure = sanitizeAdapterFailure(
          reason,
          error instanceof Error ? error.message : "Reviewer result failed",
          false,
        );
      } finally {
        clearTimeout(timer);
        if (progressTimer) clearInterval(progressTimer);
        controller.signal.removeEventListener("abort", onAbort);
        if (admitted)
          providerActive.set(
            group,
            Math.max(0, (providerActive.get(group) ?? 1) - 1),
          );
        if (child.signal.aborted) scheduleCleanup(job.adapter);
        if (terminal?.type === "result" && !resultStoragePersisted)
          void Promise.resolve(terminal.resultStorage?.abandoned()).catch(
            () => undefined,
          );
      }
      await input.record({
        record: "reviewer.attempt",
        reviewer_id: reviewer.id,
        data: {
          attempt,
          started_at: new Date(job.startedAt).toISOString(),
          elapsed_ms: now() - job.attemptStartedAt,
          failure,
        },
      });
      if (failure !== undefined) recordCircuitFailure(reviewer, failure);
      job.fallbackEligible = failure?.fallback_eligible === true;
      if (
        !failure?.retryable ||
        attempt === execution.retry_attempts ||
        now() >= candidateDeadline ||
        controller.signal.aborted
      ) {
        await fail(
          job,
          failure?.reason ?? "unknown",
          failure?.message ?? "Reviewer incomplete",
        );
        return "incomplete";
      }
      job.phase = "retry_backoff";
      await delay(
        Math.min(
          execution.retry_backoff_ms * attempt,
          Math.max(0, candidateDeadline - now()),
        ),
        controller.signal,
      );
    }
    await fail(
      job,
      input.signal.aborted
        ? "cancelled"
        : now() >= runDeadline
          ? "run_deadline_exceeded"
          : "lens_deadline_exceeded",
      "Reviewer execution budget expired.",
    );
    return "incomplete";
  }
  try {
    await emit({
      event: "run.started",
      data: {
        consistency_mode: "live_worktree",
        ...(input.retry === undefined
          ? {}
          : { parent_run_id: input.retry.parentRunId }),
      },
    });
    await input.record({ record: "context", context: input.context });
    const { source: _source, ...reviewScope } = input.context.review_scope;
    const request = {
      schema_version: "3" as const,
      project_name: input.context.project_name,
      workspace: input.context.workspace,
      instructions: input.context.instructions,
      review_scope: reviewScope,
      ...(input.context.caller_context === undefined
        ? {}
        : { context: input.context.caller_context }),
      ...(input.context.request?.pull_request
        ? { pull_request: input.context.request.pull_request }
        : {}),
    };
    await input.record({ record: "request", request });
    await input.record({
      record: "resolution",
      resolution: {
        execution,
        reviewers: input.config.reviewers.map((reviewer) => ({
          id: reviewer.id,
          agent_id: lensId(reviewer),
          policy: reviewer.policy,
        })),
        warnings,
        deadline,
      },
    });
    await emit({
      event: "context.resolved",
      data: {
        project_name: input.context.project_name,
        review_scope: input.context.review_scope.mode,
        changed_files_count: input.context.git.is_repository
          ? input.context.git.changed_files.length
          : 0,
        diff_byte_count: input.context.git.is_repository
          ? (input.context.git.raw_diff?.byte_count ??
            Buffer.byteLength(input.context.git.diff))
          : 0,
        truncated:
          input.context.git.is_repository &&
          (input.context.git.truncated.diff ||
            input.context.git.truncated.changed_files),
        detail_ref: "context",
      },
    });
    const warningSample = boundedList(
      warnings.map((warning) => warning.code),
      (value) => value,
    );
    await emit({
      event: "suite.resolved",
      data: {
        logical_lenses: chains.size,
        model_runs: jobs.length,
        deadline,
        warnings: warningSample.items,
        omitted_warnings_count: warningSample.omitted,
        warnings_digest: warningSample.sha256,
        detail_ref: "resolution",
      },
    });
    for (const inherited of input.retry?.inherited ?? []) {
      await input.recordResult(inherited.reviewerId, inherited.result);
      for (
        let index = 0;
        index < inherited.coverageEntries.length;
        index += 256
      )
        await input.record({
          record: "reviewer.coverage",
          reviewer_id: inherited.reviewerId,
          data: {
            index: index / 256,
            entries: inherited.coverageEntries.slice(index, index + 256),
          },
        });
      await input.record({
        record: "reviewer.terminal",
        reviewer_id: inherited.reviewerId,
        data: structuredClone(inherited.terminal),
      });
      lensStates.set(
        inherited.lensId,
        inherited.result.verdict === "fail" ? "findings" : "passed",
      );
    }
    heartbeat = setInterval(() => {
      if (pendingHeartbeat || outputFailure) return;
      const active = jobs.filter(
        (job) => job.status === "running" || job.phase === "probing",
      );
      const ordered = [...active].sort((a, b) =>
        a.reviewer.id.localeCompare(b.reviewer.id),
      );
      const sample = boundedList(
        ordered.map((job) => job.reviewer.id),
        (id) => id,
      );
      const detailed = {
        elapsed_ms: now() - start,
        active_count: active.length,
        model_runs: modelCounts(),
        run_deadline_remaining_ms: Math.max(0, runDeadline - now()),
        active: ordered.slice(0, 8).map((job) => ({
          reviewer_id: job.reviewer.id,
          lens_id: lensId(job.reviewer),
          mode: job.mode,
          attempt: Math.max(1, job.attempt),
          maximum_attempts: execution.retry_attempts,
          phase: job.phase as "reviewing",
          attempt_elapsed_ms: now() - job.startedAt,
          lens_elapsed_ms: now() - start,
          run_deadline_remaining_ms: Math.max(0, runDeadline - now()),
          lens_deadline_remaining_ms: Math.max(0, job.lensDeadline - now()),
          attempt_deadline_remaining_ms: Math.max(
            0,
            job.attemptDeadline - now(),
          ),
          last_progress_age_ms: activity.snapshot(job.reviewer.id, now())
            .lastProgressAgeMs,
          coalesced_activity_count: activity.snapshot(
            job.reviewer.id,
            now(),
            true,
          ).coalescedCount,
        })),
        omitted_active_count: sample.omitted,
        active_digest: sample.sha256,
      };
      const selected = heartbeatBudget.select(now(), detailed, {
        elapsed_ms: now() - start,
        active: [],
        active_count: active.length,
        minimal: true,
        detail_ref: "resolution",
      });
      if (selected)
        pendingHeartbeat = emit({
          event: "suite.heartbeat",
          data: selected.data,
        }).finally(() => {
          pendingHeartbeat = undefined;
        });
    }, interval);
    const queue = [...chains.entries()];
    let next = 0;
    await Promise.all(
      Array.from(
        { length: Math.min(execution.max_concurrency, queue.length) },
        async () => {
          for (;;) {
            const chain = queue[next++];
            if (!chain) return;
            const [id, members] = chain;
            const reviewer = members[0]!.reviewer;
            const missing = evaluateRequiredInput(
              request,
              reviewer.policy?.requiredInput ?? [],
            );
            if (missing.length) {
              lensStates.set(id, "not_evaluated");
              for (const job of members)
                await skip(job, "not_evaluated_missing_input", missing);
              continue;
            }
            const relevant =
              input.context.review_scope.mode === "full" ||
              !input.context.git.is_repository ||
              input.context.git.truncated.changed_files ||
              input.context.git.changed_files.some((path) =>
                changePolicy(reviewer).relevantPaths.some((pattern) =>
                  changedPathMatchesGlob(pattern, path),
                ),
              );
            if (!relevant) {
              lensStates.set(id, "not_applicable");
              for (const job of members) await skip(job, "not_applicable");
              continue;
            }
            const passes: Array<{ providerGroup: string }> = [];
            let source:
              | { reviewer: ResolvedReviewer; result: ReviewerResultV4 }
              | undefined;
            lensStates.set(id, "incomplete");
            for (let index = 0; index < members.length; index++) {
              const job = members[index]!;
              if (controller.signal.aborted || now() >= job.lensDeadline) {
                await skip(
                  job,
                  input.signal.aborted
                    ? "cancelled"
                    : now() >= runDeadline
                      ? "run_deadline_exceeded"
                      : "lens_deadline_exceeded",
                );
                continue;
              }
              const result = await execute(job, source);
              if (result === "incomplete") {
                if (!job.fallbackEligible) {
                  for (const rest of members.slice(index + 1))
                    await skip(rest, "blocked_by_infrastructure_failure");
                  break;
                }
                continue;
              }
              if (source && job.result?.schema_version === "2") {
                lensStates.set(
                  id,
                  job.result.verdict === "fail" ? "findings" : "passed",
                );
                for (const rest of members.slice(index + 1))
                  await skip(rest, "short_circuited_after_finding");
                break;
              }
              if (result === "findings") {
                if (
                  job.reviewer.policy?.adjudication === "required" &&
                  job.result?.schema_version === "4"
                ) {
                  source = { reviewer: job.reviewer, result: job.result };
                  continue;
                }
                lensStates.set(id, "findings");
                for (const rest of members.slice(index + 1))
                  await skip(rest, "short_circuited_after_finding");
                break;
              }
              passes.push({ providerGroup: provider(job.reviewer) });
              if (
                evaluatePassQuorum(
                  {
                    passQuorum: reviewer.policy?.passQuorum ?? members.length,
                    minimumProviderGroups:
                      reviewer.policy?.minimumProviderGroups ?? 1,
                  },
                  passes,
                ).satisfied
              ) {
                lensStates.set(id, "passed");
                for (const rest of members.slice(index + 1))
                  await skip(rest, "not_needed_after_quorum");
                break;
              }
            }
          }
        },
      ),
    );
    for (const record of activity.records())
      await input.record({
        record: "reviewer.activity",
        reviewer_id: record.reviewer_id,
        data: record,
      });
    for (const summary of activity.summaries())
      await input.record({
        record: "reviewer.activity_summary",
        reviewer_id: summary.reviewer_id,
        data: summary,
      });
    const gatePolicies = Object.fromEntries(
      input.config.reviewers.map((reviewer) => [
        lensId(reviewer),
        {
          minimumSeverity: reviewer.policy?.gateMinimumSeverity ?? "medium",
          minimumConfidence: reviewer.policy?.gateMinimumConfidence ?? "medium",
        },
      ]),
    );
    const canonical = canonicalizeFindings(raw, {
      proofBySourceRef,
      gatePolicies,
    });
    const executionPartial =
      [...lensStates.values()].some(
        (state) => state === "incomplete" || state === "not_evaluated",
      ) || outputFailure;
    const coverage = executionPartial
      ? ("partial" as const)
      : ("complete" as const);
    const changeCoverageStatus =
      input.context.review_scope.mode === "full"
        ? ("not_applicable" as const)
        : [...lensStates.values()].some((state) => state === "not_evaluated") ||
            jobs.some(
              (job) =>
                job.ledger !== undefined &&
                job.ledger.summary().status !== "complete" &&
                job.ledger.summary().status !== "not_applicable",
            )
          ? ("incomplete" as const)
          : jobs.some((job) => job.ledger?.summary().status === "complete")
            ? ("complete" as const)
            : ("not_applicable" as const);
    const outcome = runOutcome({
      cancelled:
        callerCancelled || jobs.some((job) => job.reason === "cancelled"),
      coverage,
      gateFindings: canonical.counts.gate_eligible_subfindings,
    });
    const lensSamples = boundedList(
      [...lensStates].map(([lens_id, outcome]) => ({ lens_id, outcome })),
      (item) => item.lens_id,
    );
    const exclusions = boundedList(
      jobs
        .filter((job) => job.status === "skipped")
        .map((job) => job.reviewer.id),
      (value) => value,
    );
    const {
      raw: _raw,
      unique: _unique,
      gate: _gate,
      advisory: _advisory,
      ...counts
    } = canonical.counts;
    const cancelled =
      callerCancelled || jobs.some((job) => job.reason === "cancelled");
    const exitCode = cancelled
      ? 4
      : executionPartial
        ? 3
        : counts.gate_eligible_subfindings > 0
          ? 1
          : 0;
    const summary = {
      run_outcome: outcome,
      gate_outcome:
        counts.gate_eligible_subfindings > 0
          ? "gate_findings"
          : "no_gate_findings",
      coverage_outcome: coverage,
      exit_code: exitCode,
      ...counts,
      incomplete_lenses: [...lensStates.values()].filter(
        (state) => state === "incomplete" || state === "not_evaluated",
      ).length,
      execution_coverage: {
        status: executionPartial ? "partial" : "complete",
      },
      change_coverage: {
        status: changeCoverageStatus,
      },
      deadline,
      total_elapsed_ms: now() - start,
      model_runs: modelCounts(),
      result_delivery: {
        completed_results: completedResults,
        artifact: "complete",
        planned_public_stream:
          mode === "full-jsonl" ? "complete" : "references_only",
      },
      lens_summaries: lensSamples.items,
      total_lens_summaries: lensSamples.total,
      omitted_lens_summaries_count: lensSamples.omitted,
      lens_summaries_digest: lensSamples.sha256,
      exclusions: exclusions.items,
      total_exclusions: exclusions.total,
      omitted_exclusions_count: exclusions.omitted,
      exclusions_digest: exclusions.sha256,
      warnings: warningSample.items,
      total_warnings: warningSample.total,
      omitted_warnings_count: warningSample.omitted,
      warnings_digest: warningSample.sha256,
      deficit_samples: [],
    };
    await input.record({
      record: "run.findings",
      data: {
        raw: structuredClone(raw),
        proof_by_source_ref: structuredClone(proofBySourceRef),
        adjudication_outcomes: structuredClone(adjudicationOutcomes),
        gate_policies: structuredClone(gatePolicies),
        canonical_counts: structuredClone(counts),
      },
    });
    await awaitCleanup();
    await pendingHeartbeat;
    try {
      await input.writer.finish(summary);
    } finally {
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
      await pendingHeartbeat;
    }
    return {
      runOutcome: outcome,
      gateOutcome: summary.gate_outcome,
      coverageOutcome: coverage,
      exitCode,
      canonical,
      jobs,
      summary,
    };
  } finally {
    clearTimeout(timeout);
    if (heartbeat) clearInterval(heartbeat);
    input.signal.removeEventListener("abort", onCallerAbort);
    controller.abort();
    for (const job of jobs) scheduleCleanup(job.adapter);
    await awaitCleanup();
    await Promise.allSettled(jobs.map((job) => job.ledger?.close()));
    releaseRunSnapshot(input.context);
  }
}
