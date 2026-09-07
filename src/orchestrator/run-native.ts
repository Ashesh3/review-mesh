import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";
import type { V9RunInput } from "./run-v9.js";
import type { ResolvedReviewer } from "../config/schemas.js";
import type { AdapterEvent, ReviewAdapter } from "../adapters/types.js";
import {
  sanitizeAdapterFailure,
  sanitizePublicText,
  type AdapterFailure,
} from "../adapters/errors.js";
import {
  buildNativeReviewPrompt,
  nativeResultJsonSchema,
  createNativeChangeCoverage,
  validateNativeEvidence,
  nativeRequiredPaths,
} from "../protocol/native-review.js";
import {
  providerReviewerResultV4Schema,
  reviewerResultV4Schema,
  adjudicationResultV2Schema,
  type ReviewerResultV4,
  type AdjudicationResultV2,
  type V9IncompleteReason,
} from "../protocol/v9.js";
import {
  buildCanonicalRawFindings,
  buildAdjudicationCandidates,
  canonicalizeFindings,
  type CanonicalRawFinding,
  type CanonicalFindingCoreProof,
} from "../findings/canonical.js";
import { validateAdjudication } from "../findings/adjudication.js";
import { verifyAdjudicationEvidence } from "../findings/evidence-verifier.js";
import { evaluateRequiredInput } from "../context/required-input.js";
import { changedPathMatchesGlob, evaluatePassQuorum } from "./lens-policy.js";
import { selectRunDeadline } from "./deadlines.js";
import { boundedList, runOutcome } from "../protocol/concise.js";
import { reviewerResultDigest } from "../results/digest.js";
import {
  sanitizeReviewerOutput,
  sanitizeRunMetadata,
} from "../results/sanitize.js";
import { reviewerConfigFingerprint } from "../diagnostics/retry-v9.js";
import {
  PublicDeliveryError,
  type V9EventDraft,
} from "../protocol/v9-event-writer.js";
import type { JsonValue } from "../protocol/schemas.js";
import {
  createNativeProgressWatchdog,
  NativeNoProgressError,
} from "./native-progress.js";

type NativeJob = {
  reviewer: ResolvedReviewer;
  status: "queued" | "running" | "completed" | "incomplete" | "skipped";
  phase:
    | "probing"
    | "queued"
    | "reviewing"
    | "validating"
    | "finalizing"
    | "terminal";
  mode: "full_review" | "adjudication";
  startedAt: number;
  attemptDeadline: number;
  lensDeadline: number;
  lastProgressAt: number;
  activityCount: number;
  result?: ReviewerResultV4 | AdjudicationResultV2;
  reason?: string;
  adapter?: ReviewAdapter;
};
const lens = (reviewer: ResolvedReviewer) => reviewer.agentId ?? reviewer.id;
const group = (reviewer: ResolvedReviewer) =>
  reviewer.providerGroup ?? reviewer.adapterId;

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error("Cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort))
      .catch(() => undefined);
  });
}

/** Detect live-worktree mutations without retaining or feeding a custom source snapshot. */
async function workspaceIdentity(
  workspace: string,
  signal: AbortSignal,
  scopePaths?: readonly string[],
) {
  const hash = createHash("sha256");
  let files = 0,
    complete = true;
  async function visit(relative: string): Promise<void> {
    if (signal.aborted) {
      complete = false;
      return;
    }
    let entries;
    try {
      entries = await readdir(join(workspace, relative), {
        withFileTypes: true,
      });
    } catch {
      complete = false;
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (signal.aborted) {
        complete = false;
        return;
      }
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (
        [
          ".git",
          ".git-recovered",
          ".worktrees",
          ".superpowers",
          "node_modules",
          "dist",
          "coverage",
        ].includes(entry.name) &&
        !scopePaths?.some(
          (scope) =>
            scope === path ||
            scope.startsWith(`${path}/`) ||
            path.startsWith(`${scope}/`),
        )
      )
        continue;
      if (files >= 100000) {
        complete = false;
        return;
      }
      if (entry.isDirectory()) await visit(path);
      else {
        try {
          const absolute = join(workspace, path),
            before = await lstat(absolute, { bigint: true });
          if (before.isSymbolicLink()) {
            hash.update(
              JSON.stringify([path, "symlink", await readlink(absolute)]) +
                "\n",
            );
            complete = false; // A link target's bytes are outside this traversal's proof.
          } else if (before.isFile()) {
            const handle = await open(
              absolute,
              constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
            );
            try {
              const opened = await handle.stat({ bigint: true });
              if (
                !opened.isFile() ||
                opened.dev !== before.dev ||
                opened.ino !== before.ino
              )
                throw new Error(
                  "Workspace file changed during provenance collection.",
                );
              const fileHash = createHash("sha256"),
                buffer = Buffer.allocUnsafe(64 * 1024);
              let bytes = 0;
              for (;;) {
                signal.throwIfAborted();
                const read = await handle.read(buffer, 0, buffer.length, bytes);
                if (read.bytesRead === 0) break;
                fileHash.update(buffer.subarray(0, read.bytesRead));
                bytes += read.bytesRead;
              }
              const after = await handle.stat({ bigint: true }),
                final = await lstat(absolute, { bigint: true });
              if (
                !final.isFile() ||
                final.isSymbolicLink() ||
                final.dev !== opened.dev ||
                final.ino !== opened.ino ||
                after.size !== opened.size ||
                BigInt(bytes) !== after.size ||
                after.mtimeNs !== opened.mtimeNs
              )
                complete = false;
              hash.update(
                JSON.stringify([path, "file", bytes, fileHash.digest("hex")]) +
                  "\n",
              );
            } finally {
              await handle.close();
            }
          } else {
            complete = false;
            hash.update(JSON.stringify([path, "unsupported"]) + "\n");
          }
          files++;
        } catch {
          complete = false;
        }
      }
    }
  }
  await visit("");
  return { sha256: hash.digest("hex"), file_count: files, complete };
}

/** Coordinates complete vendor SDK sessions; owns no model turn, transport, or retry loop. */
export async function runNativeReview(input: V9RunInput) {
  const now = input.now ?? Date.now,
    start = now(),
    execution = input.config.execution;
  const deadline = selectRunDeadline(
    input.context,
    execution.deadline_mode === "fixed"
      ? { deadline_mode: "fixed", run_deadline_ms: execution.run_deadline_ms! }
      : { deadline_mode: "adaptive" },
    new Date(start),
  );
  const deadlineAt = Date.parse(deadline.deadline_at),
    controller = new AbortController();
  const onAbort = () => controller.abort(input.signal.reason);
  input.signal.addEventListener("abort", onAbort, { once: true });
  if (input.signal.aborted) onAbort();
  const timer = setTimeout(
    () => controller.abort(new Error("Run deadline exceeded")),
    Math.max(0, deadlineAt - now()),
  );
  const jobs: NativeJob[] = input.config.reviewers.map((reviewer) => ({
    reviewer,
    status: "queued",
    phase: "queued",
    mode: "full_review",
    startedAt: start,
    attemptDeadline: deadlineAt,
    lensDeadline: deadlineAt,
    lastProgressAt: start,
    activityCount: 0,
  }));
  const lensStates = new Map<
    string,
    "passed" | "findings" | "incomplete" | "not_applicable" | "not_evaluated"
  >();
  const strictEvaluation = execution.review_profile === "strict-evaluation";
  const disagreementLenses = new Set<string>();
  const raw: CanonicalRawFinding[] = [],
    proofs: Record<string, CanonicalFindingCoreProof> = {},
    adjudicationOutcomes: Record<string, unknown>[] = [];
  let completedResults = 0,
    active = 0,
    heartbeat: ReturnType<typeof setInterval> | undefined,
    pendingHeartbeat: Promise<void> | undefined,
    outputFailure: unknown,
    persistenceFailure: unknown;
  const activeGroups = new Map<string, number>();
  const queued: Array<() => void> = [];
  const wake = () => {
    for (const entry of [...queued]) entry();
  };
  const counts = () => ({
    total: jobs.length,
    completed: jobs.filter((j) => j.status === "completed").length,
    incomplete: jobs.filter((j) => j.status === "incomplete").length,
    skipped: jobs.filter((j) => j.status === "skipped").length,
    running: jobs.filter((j) => j.status === "running").length,
    queued: jobs.filter((j) => j.status === "queued").length,
  });
  const emit = async (event: V9EventDraft) => {
    try {
      await input.writer.emit(event);
    } catch (error) {
      if (
        error instanceof PublicDeliveryError &&
        error.details.stage === "event_persistence"
      ) {
        persistenceFailure = error;
        controller.abort(error);
        throw error;
      }
      if (!outputFailure) {
        outputFailure = error;
        await input.record({
          record: "run.error",
          data: {
            reason: "output_failed",
            scope: "public_delivery",
            cancellation_initiator: "none",
            ...(error instanceof PublicDeliveryError
              ? error.details
              : {
                  stage: "output_write",
                  event: event.event,
                  attempted_seq: 1,
                  message: "Public output failed.",
                }),
          },
        });
      }
    }
  };
  async function acquire(
    reviewer: ResolvedReviewer,
    signal: AbortSignal,
  ): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const provider = group(reviewer),
        limit =
          execution.provider_limits[provider] ??
          execution.default_provider_concurrency;
      const remove = () => {
        const i = queued.indexOf(check);
        if (i >= 0) queued.splice(i, 1);
        signal.removeEventListener("abort", abort);
      };
      const abort = () => {
        remove();
        reject(signal.reason ?? new Error("Cancelled"));
      };
      const check = () => {
        if (signal.aborted) {
          abort();
          return;
        }
        if (
          active >= execution.max_concurrency ||
          (activeGroups.get(provider) ?? 0) >= limit
        )
          return;
        remove();
        active++;
        activeGroups.set(provider, (activeGroups.get(provider) ?? 0) + 1);
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          active--;
          activeGroups.set(provider, (activeGroups.get(provider) ?? 1) - 1);
          wake();
        });
      };
      queued.push(check);
      signal.addEventListener("abort", abort, { once: true });
      check();
    });
  }
  const disposition = async (
    job: NativeJob,
    status: "incomplete" | "skipped",
    reason: string,
    message?: string,
    failure?: AdapterFailure,
  ) => {
    const phase = job.phase;
    job.status = status;
    job.phase = "terminal";
    job.reason = reason;
    if (status === "incomplete") {
      const safeFailure = sanitizeAdapterFailure(
        reason as V9IncompleteReason,
        failure?.message ?? message ?? "Native review incomplete.",
        failure?.retryable ?? false,
        failure ?? {},
      );
      await input.record({
        record: "reviewer.attempt",
        reviewer_id: job.reviewer.id,
        data: {
          attempt: 1,
          started_at: new Date(job.startedAt).toISOString(),
          elapsed_ms: Math.max(0, now() - job.startedAt),
          failure: safeFailure,
        },
      });
    }
    await input.record({
      record: "reviewer.terminal",
      reviewer_id: job.reviewer.id,
      data: {
        status,
        lens_id: lens(job.reviewer),
        mode: job.mode,
        reason,
        ...(status === "incomplete" ? { failure_stage: phase } : {}),
      },
    });
    if (status === "skipped")
      await emit({
        event: "reviewer.skipped",
        reviewer_id: job.reviewer.id,
        data: {
          lens_id: lens(job.reviewer),
          mode: job.mode,
          reason,
          detail_ref: "reviewer.terminal",
        },
      });
    else
      await emit({
        event: "reviewer.incomplete",
        reviewer_id: job.reviewer.id,
        data: {
          lens_id: lens(job.reviewer),
          mode: job.mode,
          reason: reason as V9IncompleteReason,
          failure_stage: phase,
          attempt_count: 1,
          retryable: false,
          fallback_eligible: true,
          message: sanitizePublicText(message) ?? "Native review incomplete.",
          elapsed_ms: Math.max(0, now() - job.startedAt),
          detail_ref: "reviewer.terminal",
        },
      });
  };
  async function execute(
    job: NativeJob,
    source?: { reviewer: ResolvedReviewer; result: ReviewerResultV4 },
  ): Promise<"pass" | "findings" | "incomplete"> {
    const reviewer = job.reviewer;
    job.mode = source ? "adjudication" : "full_review";
    const child = new AbortController(),
      abort = () => child.abort(controller.signal.reason);
    controller.signal.addEventListener("abort", abort, { once: true });
    if (controller.signal.aborted) abort();
    const lensDeadline = Math.min(
      deadlineAt,
      start + (reviewer.policy?.lensDeadlineMs ?? deadline.duration_ms),
    );
    job.lensDeadline = lensDeadline;
    let expiry = setTimeout(
      () => child.abort(new Error("Lens deadline exceeded")),
      Math.max(0, lensDeadline - now()),
    );
    let release: (() => void) | undefined,
      progress: ReturnType<typeof createNativeProgressWatchdog> | undefined,
      terminal:
        Extract<AdapterEvent, { type: "result" | "failure" }> | undefined;
    let capabilities: Awaited<ReturnType<ReviewAdapter["probe"]>> | undefined;
    try {
      job.phase = "queued";
      const queuedAt = now();
      release = await acquire(reviewer, child.signal);
      child.signal.throwIfAborted();
      const admittedAt = now(),
        queueWaitMs = Math.max(0, admittedAt - queuedAt);
      job.status = "running";
      job.phase = "probing";
      const probeStartedAt = now();
      clearTimeout(expiry);
      const probeDeadline = Math.min(
        lensDeadline,
        probeStartedAt + (reviewer.attemptTimeoutMs ?? reviewer.timeoutMs),
      );
      job.attemptDeadline = probeDeadline;
      job.lastProgressAt = now();
      expiry = setTimeout(
        () => child.abort(new Error("Probe deadline exceeded")),
        Math.max(0, probeDeadline - now()),
      );
      job.adapter = input.registry.create(reviewer.adapterId, reviewer.adapter);
      await emit({
        event: "reviewer.progress",
        reviewer_id: reviewer.id,
        data: {
          lens_id: lens(reviewer),
          mode: job.mode,
          phase: "probing",
          attempt: 1,
        },
      });
      capabilities = await abortable(
        job.adapter.probe(reviewer, child.signal),
        child.signal,
      );
      child.signal.throwIfAborted();
      const probeElapsedMs = Math.max(0, now() - probeStartedAt);
      if (
        !capabilities.available ||
        capabilities.authenticated === false ||
        capabilities.model_available === false
      ) {
        await disposition(
          job,
          "incomplete",
          !capabilities.available
            ? "adapter_unavailable"
            : capabilities.authenticated === false
              ? "authentication_failed"
              : "model_unavailable",
          capabilities.message,
        );
        return "incomplete";
      }
      job.startedAt = now();
      job.status = "running";
      job.phase = "reviewing";
      progress = createNativeProgressWatchdog({
        timeoutMs: execution.no_progress_timeout_ms ?? 300_000,
        signal: child.signal,
        onTimeout: (error) => child.abort(error),
      });
      clearTimeout(expiry);
      const attemptDeadline = Math.min(
        lensDeadline,
        now() + (reviewer.attemptTimeoutMs ?? reviewer.timeoutMs),
      );
      job.attemptDeadline = attemptDeadline;
      job.lastProgressAt = now();
      expiry = setTimeout(
        () => child.abort(new Error("Reviewer deadline exceeded")),
        Math.max(0, attemptDeadline - now()),
      );
      await emit({
        event: "reviewer.started",
        reviewer_id: reviewer.id,
        data: {
          lens_id: lens(reviewer),
          mode: job.mode,
          adapter: reviewer.adapterId,
          model: reviewer.model,
          provider_group: group(reviewer),
          attempt: 1,
          maximum_attempts: 1,
          timeout_ms: Math.max(0, attemptDeadline - now()),
          admitted_at: new Date(admittedAt).toISOString(),
          queue_wait_ms: queueWaitMs,
          probe_elapsed_ms: probeElapsedMs,
          run_deadline_remaining_ms: Math.max(0, deadlineAt - now()),
          lens_deadline_remaining_ms: Math.max(0, lensDeadline - now()),
          progress_observable: capabilities.progress_observable === true,
          proof: "native_attested",
        },
      });
      const candidates = source
        ? buildAdjudicationCandidates(
            buildCanonicalRawFindings({
              reviewer_id: source.reviewer.id,
              lens_id: lens(source.reviewer),
              result: source.result,
            }),
          )
        : undefined;
      const candidateFindings = candidates?.candidates.map(
        ({ candidate_id, finding }) => ({
          id: candidate_id,
          severity: finding.severity,
          title: finding.title,
          description: finding.description,
          evidence: finding.evidence,
          suggested_direction: finding.suggested_direction,
          confidence: finding.confidence,
          classification: finding.classification,
          external_assumptions: finding.external_assumptions,
          category: finding.category,
          verification: finding.verification ?? "Verify the cited candidate.",
          ...(finding.change_impact === undefined
            ? {}
            : { change_impact: finding.change_impact }),
          claim: finding.claim,
        }),
      );
      const effectiveReviewer = source
        ? {
            ...reviewer,
            policy: {
              ...reviewer.policy!,
              mode: "adjudication" as const,
              adjudicatesReviewerId: source.reviewer.id,
              candidateFindings: candidateFindings as unknown as JsonValue,
            },
          }
        : reviewer;
      const iterator = job.adapter
        .run({
          runId: input.runId,
          reviewer: effectiveReviewer,
          context: input.context,
          prompt: buildNativeReviewPrompt(
            effectiveReviewer,
            input.context,
            input.config.project_context,
          ),
          resultJsonSchema: nativeResultJsonSchema(effectiveReviewer),
          isolationPolicy: reviewer.isolationPolicy,
          signal: child.signal,
          recordDiagnostic: async (diagnostic) => {
            const safe = sanitizeRunMetadata(diagnostic) as Record<
              string,
              unknown
            >;
            if (
              diagnostic.kind === "adapter_exception" ||
              diagnostic.kind === "provider_response"
            ) {
              await input.record({
                record:
                  diagnostic.kind === "adapter_exception"
                    ? "reviewer.exception"
                    : "reviewer.response",
                reviewer_id: reviewer.id,
                data: { attempt: 1, diagnostics: safe.diagnostics },
              });
              return;
            }
            if (diagnostic.kind === "unverified_result_draft") {
              // Native adapters supply bounded, parsed drafts, not raw model transcripts.
              if (Buffer.byteLength(JSON.stringify(safe), "utf8") > 256 * 1024)
                throw new Error(
                  "Native diagnostic exceeds the persistence bound; chunk the complete rejected submission.",
                );
              await input.record({
                record: "reviewer.draft",
                reviewer_id: reviewer.id,
                data: { ...safe, attempt: 1, verified: false },
              });
            }
          },
        })
        [Symbol.asyncIterator]();
      let lifecycleFailure: unknown;
      try {
        for (;;) {
          let next: IteratorResult<AdapterEvent>;
          try {
            next = await abortable(iterator.next(), child.signal);
          } catch (error) {
            if (terminal?.type !== "result") throw error;
            lifecycleFailure =
              error ??
              new Error("Native SDK cleanup failed after the terminal result.");
            break;
          }
          if (next.done) break;
          const event = next.value;
          const meaningful = progress.record(event);
          if (event.type === "result" || event.type === "failure") {
            if (terminal) throw new Error("Duplicate SDK terminal result");
            terminal = event;
            continue;
          }
          const message = sanitizePublicText(event.message);
          if (meaningful) job.lastProgressAt = now();
          job.activityCount++;
          if (message)
            await input.record({
              record: "reviewer.activity",
              reviewer_id: reviewer.id,
              data: {
                reviewer_id: reviewer.id,
                phase: "reviewing",
                at: now(),
                message,
                meaningful_progress: meaningful,
              },
            });
        }
      } finally {
        if (child.signal.aborted)
          void iterator.return?.().catch(() => undefined);
      }
      if (terminal?.type === "failure") {
        await disposition(
          job,
          "incomplete",
          child.signal.reason instanceof NativeNoProgressError
            ? "no_progress_timeout"
            : terminal.failure.reason === "timeout"
              ? "provider_timeout"
              : terminal.failure.reason,
          terminal.failure.message,
          terminal.failure,
        );
        return "incomplete";
      }
      if (terminal?.type !== "result")
        throw new Error("SDK ended without a terminal result");
      job.phase = "validating";
      const result = source
        ? adjudicationResultV2Schema.parse(
            sanitizeReviewerOutput(terminal.result),
          )
        : providerReviewerResultV4Schema.parse(
            sanitizeReviewerOutput(terminal.result),
          );
      let final: ReviewerResultV4 | AdjudicationResultV2;
      let incompleteAdjudication = false;
      const localProofs: Record<string, CanonicalFindingCoreProof> = {};
      if (result.schema_version === "4") {
        const attestation = result.native_scope_attestation;
        const relevant = nativeRequiredPaths(reviewer, input.context);
        final = reviewerResultV4Schema.parse({
          ...result,
          change_coverage: createNativeChangeCoverage(input.context, {
            scopeAttested: attestation?.complete === true,
            inspectedPaths: attestation?.reviewed_paths ?? [],
            relevantPaths: relevant,
          }),
        });
        Object.assign(
          localProofs,
          await validateNativeEvidence(
            input.context.workspace,
            final,
            input.context,
          ),
        );
        const sourceRaw = buildCanonicalRawFindings({
          reviewer_id: reviewer.id,
          lens_id: lens(reviewer),
          result: final,
        });
        raw.push(...sourceRaw);
        for (const finding of sourceRaw)
          proofs[finding.source_ref] = {
            ...localProofs[finding.finding_id],
            adjudication_required: reviewer.policy?.adjudication === "required",
          };
      } else {
        final = result;
        const sourceResult = reviewerResultV4Schema.parse({
          ...source!.result,
          actionable_findings: candidateFindings,
        });
        const outcome = validateAdjudication(sourceResult, final, {
          reviewScope: input.context.review_scope.mode,
          evidenceVerification: await verifyAdjudicationEvidence({
            workspace: input.context.workspace,
            adjudicationResult: final,
            ...(input.context.git.is_repository && input.context.git.merge_base
              ? { baseRevision: input.context.git.merge_base }
              : {}),
            signal: child.signal,
          }),
          ...(input.context.git.is_repository
            ? {
                git: {
                  changedFiles: input.context.git.changed_files,
                  diff: input.context.git.diff,
                },
              }
            : {}),
        });
        adjudicationOutcomes.push({
          adjudicator_reviewer_id: reviewer.id,
          source_reviewer_id: source!.reviewer.id,
          complete: outcome.complete,
          decisions: outcome.decisions,
          unknown_source_finding_ids: outcome.unknown_source_finding_ids,
        });
        for (const decision of outcome.decisions) {
          for (const ref of candidates!.candidates.find(
            (c) => c.candidate_id === decision.source_finding_id,
          )?.source_refs ?? []) {
            const finding = raw.find((f) => f.source_ref === ref);
            if (
              strictEvaluation &&
              finding &&
              finding.adjudication !== "unadjudicated" &&
              finding.adjudication !== "needs_verification"
            ) {
              const priorAccepted =
                finding.adjudication === "confirmed" ||
                finding.adjudication === "adjusted";
              const nextAccepted =
                decision.effective_decision === "confirmed" ||
                decision.effective_decision === "adjusted";
              const priorFinding = finding.effective_finding ?? finding;
              const nextFinding = decision.effective_finding ?? finding;
              const materiallyDifferent =
                priorAccepted &&
                nextAccepted &&
                (priorFinding.severity !== nextFinding.severity ||
                  priorFinding.confidence !== nextFinding.confidence ||
                  priorFinding.classification !== nextFinding.classification);
              if (
                decision.issues.length === 0 &&
                (priorAccepted !== nextAccepted || materiallyDifferent)
              ) {
                disagreementLenses.add(lens(reviewer));
                // Preserve verified defects instead of allowing a later vote to erase
                // them. The disagreement remains explicit and the run inconclusive.
                if (priorAccepted) continue;
              }
              if (
                decision.issues.length > 0 ||
                decision.effective_decision === "needs_verification"
              )
                continue;
            }
            if (finding) {
              finding.adjudication = decision.effective_decision;
              if (
                decision.effective_decision === "adjusted" &&
                decision.effective_finding
              ) {
                const effective = decision.effective_finding;
                finding.effective_finding = {
                  severity: effective.severity,
                  title: effective.title,
                  description: effective.description,
                  evidence: effective.evidence.map((e) => ({
                    detail: e.detail,
                    ...(e.path === undefined ? {} : { path: e.path }),
                    ...(e.start_line === undefined
                      ? {}
                      : { start_line: e.start_line }),
                    ...(e.end_line === undefined
                      ? {}
                      : { end_line: e.end_line }),
                  })),
                  suggested_direction: effective.suggested_direction,
                  confidence: effective.confidence,
                  classification: effective.classification,
                  external_assumptions: effective.external_assumptions,
                  ...(effective.root_issue_id === undefined
                    ? {}
                    : { root_issue_id: effective.root_issue_id }),
                  ...(effective.category === undefined
                    ? {}
                    : { category: effective.category }),
                  ...(effective.verification === undefined
                    ? {}
                    : { verification: effective.verification }),
                  ...(effective.change_impact === undefined
                    ? {}
                    : { change_impact: effective.change_impact }),
                  ...(!("claim" in effective) || effective.claim === undefined
                    ? {}
                    : { claim: effective.claim }),
                };
              }
            }
            const validDecision =
              decision.issues.length === 0 &&
              (decision.effective_decision === "confirmed" ||
                decision.effective_decision === "adjusted");
            proofs[ref] = {
              ...proofs[ref],
              adjudication_required: !outcome.complete,
              policy_non_gating: !decision.gate_eligible,
              ...(validDecision && decision.decision?.ordered_execution_proof
                ? { ordered_proof_verified: true }
                : {}),
              ...(validDecision && decision.decision?.base_head_comparison
                ? { change_impact_verified: true }
                : {}),
            };
          }
        }
        incompleteAdjudication =
          !outcome.complete ||
          (strictEvaluation &&
            outcome.decisions.some((decision) => decision.issues.length > 0));
      }
      await input.recordResult(reviewer.id, final);
      completedResults++;
      job.result = final;
      await input.record({
        record: "reviewer.native_execution",
        reviewer_id: reviewer.id,
        data: {
          contract: "native_review_v1",
          harness: reviewer.adapter.type,
          model: reviewer.model,
          sdk_version: capabilities.sdk_version ?? "unknown",
          ...(capabilities.runtime_version
            ? { runtime_version: capabilities.runtime_version }
            : {}),
          execution_mode: "managed_process",
          consistency_mode: "live_worktree",
          coverage_basis:
            result.schema_version === "4" && result.native_scope_attestation
              ? "model_attested"
              : "unknown",
          sdk_completed: true,
          execution_fingerprint: reviewerConfigFingerprint(reviewer),
        },
      });
      if (input.outputMode === "full-jsonl")
        await emit({
          event: "reviewer.result",
          reviewer_id: reviewer.id,
          data: {
            lens_id: lens(reviewer),
            mode: job.mode,
            digest: reviewerResultDigest(final),
            byte_count: Buffer.byteLength(JSON.stringify(final)),
            detail_ref: "reviewer.result",
            result: final,
          },
        });
      if (lifecycleFailure !== undefined) {
        job.phase = "finalizing";
        await disposition(
          job,
          "incomplete",
          child.signal.aborted
            ? input.signal.aborted
              ? "cancelled"
              : now() >= deadlineAt
                ? "run_deadline_exceeded"
                : "provider_timeout"
            : "process_crashed",
          lifecycleFailure instanceof Error
            ? lifecycleFailure.message
            : "Native SDK cleanup failed after the terminal result.",
        );
        return "incomplete";
      }
      if (incompleteAdjudication) {
        await disposition(
          job,
          "incomplete",
          "invalid_result",
          "Required adjudication is incomplete.",
        );
        return "incomplete";
      }
      if (
        final.schema_version === "4" &&
        final.change_coverage.status !== "complete" &&
        final.change_coverage.status !== "not_applicable"
      ) {
        await disposition(
          job,
          "incomplete",
          "change_coverage_incomplete",
          "The SDK did not attest complete review of the requested scope.",
        );
        return "incomplete";
      }
      job.status = "completed";
      job.phase = "terminal";
      await input.record({
        record: "reviewer.terminal",
        reviewer_id: reviewer.id,
        data: {
          status: "completed",
          lens_id: lens(reviewer),
          mode: job.mode,
          finding_proofs: localProofs,
        },
      });
      await emit({
        event: "reviewer.completed",
        reviewer_id: reviewer.id,
        data: {
          lens_id: lens(reviewer),
          mode: job.mode,
          verdict: final.verdict,
          elapsed_ms: Math.max(0, now() - job.startedAt),
          actionable_findings: final.actionable_findings.length,
          summary: final.summary,
          ...(final.schema_version === "4"
            ? { change_coverage: final.change_coverage }
            : {}),
          detail_ref: "reviewer.result",
        },
      });
      return final.verdict === "pass" ? "pass" : "findings";
    } catch (error) {
      if (persistenceFailure) throw persistenceFailure;
      const failure = sanitizeAdapterFailure(
        child.signal.aborted
          ? input.signal.aborted
            ? "cancelled"
            : child.signal.reason instanceof NativeNoProgressError
              ? "no_progress_timeout"
              : now() >= deadlineAt
                ? "run_deadline_exceeded"
                : now() >= lensDeadline
                  ? "lens_deadline_exceeded"
                  : job.phase === "probing"
                    ? "probe_deadline_exceeded"
                    : job.phase === "queued"
                      ? "queue_deadline_exceeded"
                      : "provider_timeout"
          : "invalid_result",
        error instanceof Error ? error.message : "SDK review failed",
        false,
      );
      await disposition(job, "incomplete", failure.reason, failure.message);
      return "incomplete";
    } finally {
      progress?.close();
      clearTimeout(expiry);
      controller.signal.removeEventListener("abort", abort);
      child.abort();
      if (job.adapter?.forceCleanup)
        await Promise.race([
          job.adapter.forceCleanup().catch(() => undefined),
          new Promise<void>((r) => {
            const t = setTimeout(r, execution.shutdown_grace_period_ms);
            t.unref();
          }),
        ]);
      release?.();
    }
  }
  try {
    await emit({
      event: "run.started",
      data: {
        consistency_mode: "live_worktree",
        ...(input.retry ? { parent_run_id: input.retry.parentRunId } : {}),
      },
    });
    heartbeat = setInterval(() => {
      if (pendingHeartbeat || outputFailure) return;
      pendingHeartbeat = emit({
        event: "suite.heartbeat",
        data: {
          elapsed_ms: Math.max(0, now() - start),
          active: jobs
            .filter((job) => job.status === "running")
            .slice(0, 8)
            .map((job) => ({
              reviewer_id: job.reviewer.id,
              lens_id: lens(job.reviewer),
              mode: job.mode,
              attempt: 1,
              maximum_attempts: 1,
              phase: job.phase,
              attempt_elapsed_ms: Math.max(0, now() - job.startedAt),
              lens_elapsed_ms: Math.max(0, now() - start),
              run_deadline_remaining_ms: Math.max(0, deadlineAt - now()),
              lens_deadline_remaining_ms: Math.max(0, job.lensDeadline - now()),
              attempt_deadline_remaining_ms: Math.max(
                0,
                job.attemptDeadline - now(),
              ),
              last_progress_age_ms: Math.max(0, now() - job.lastProgressAt),
              coalesced_activity_count: job.activityCount,
            })),
          active_count: active,
          model_runs: counts(),

          run_deadline_remaining_ms: Math.max(0, deadlineAt - now()),
        },
      })
        .catch(() => undefined)
        .finally(() => {
          pendingHeartbeat = undefined;
        });
    }, execution.heartbeat_interval_ms);
    const initial = await workspaceIdentity(
      input.context.workspace,
      controller.signal,
      input.context.review_scope.paths,
    );
    await input.record({ record: "context", context: input.context });
    const { source: _scopeSource, ...reviewScope } = input.context.review_scope;
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
        reviewers: jobs.map(({ reviewer: r }) => ({
          id: r.id,
          agent_id: lens(r),
          adapter: r.adapterId,
          model: r.model,
          ...(r.effort ? { effort: r.effort } : {}),
          provider_group: group(r),
          purpose: r.purpose,
          model_index: r.modelIndex ?? 0,
          configured_model_index: r.configuredModelIndex ?? 0,
          model_count: r.modelCount ?? 1,
          isolation: r.isolationPolicy,
          timeout_ms: r.timeoutMs,
          config_fingerprint: reviewerConfigFingerprint(r),
          policy: r.policy,
        })),
        warnings: [],
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
          ? Buffer.byteLength(input.context.git.diff)
          : 0,
        truncated:
          input.context.git.is_repository &&
          (input.context.git.truncated.diff ||
            input.context.git.truncated.changed_files),
        detail_ref: "context",
      },
    });
    const chains = new Map<string, NativeJob[]>();
    for (const job of jobs)
      chains.set(lens(job.reviewer), [
        ...(chains.get(lens(job.reviewer)) ?? []),
        job,
      ]);
    await emit({
      event: "suite.resolved",
      data: {
        logical_lenses: chains.size,
        model_runs: jobs.length,
        deadline,
        warnings: [],
        detail_ref: "resolution",
      },
    });

    await Promise.all(
      [...chains].map(async ([id, members]) => {
        const reviewer = members[0]!.reviewer;
        const missing = evaluateRequiredInput(
          request,
          reviewer.policy?.requiredInput ?? [],
        );
        if (missing.length) {
          lensStates.set(id, "not_evaluated");
          for (const job of members)
            await disposition(job, "skipped", "not_evaluated_missing_input");
          return;
        }
        const relevant =
          input.context.review_scope.mode === "full" ||
          !input.context.git.is_repository ||
          input.context.git.truncated.changed_files ||
          input.context.git.changed_files.some((path) =>
            (reviewer.policy?.changeCoverage?.relevantPaths ?? ["**"]).some(
              (pattern) => changedPathMatchesGlob(pattern, path),
            ),
          );
        if (!relevant) {
          lensStates.set(id, "not_applicable");
          for (const job of members)
            await disposition(job, "skipped", "not_applicable");
          return;
        }
        lensStates.set(id, "incomplete");
        const passes: Array<{ providerGroup: string }> = [];
        let source:
          { reviewer: ResolvedReviewer; result: ReviewerResultV4 } | undefined;
        for (let i = 0; i < members.length; i++) {
          const job = members[i]!;
          if (controller.signal.aborted) {
            await disposition(
              job,
              "skipped",
              input.signal.aborted ? "cancelled" : "run_deadline_exceeded",
            );
            continue;
          }
          const outcome = await execute(job, source);
          if (outcome === "incomplete") continue;
          let done = false;
          if (source && job.result?.schema_version === "2") {
            lensStates.set(
              id,
              job.result.verdict === "fail" ? "findings" : "passed",
            );
            done = true;
          } else if (outcome === "findings") {
            if (
              reviewer.policy?.adjudication === "required" &&
              job.result?.schema_version === "4"
            ) {
              source = { reviewer: job.reviewer, result: job.result };
              continue;
            }
            lensStates.set(id, "findings");
            done = true;
          } else {
            passes.push({ providerGroup: group(job.reviewer) });
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
              done = true;
            }
          }
          if (done && !strictEvaluation) {
            for (const rest of members.slice(i + 1))
              await disposition(
                rest,
                "skipped",
                outcome === "findings" || source
                  ? "short_circuited_after_finding"
                  : "not_needed_after_quorum",
              );
            break;
          }
        }
        if (
          strictEvaluation &&
          (members.some((job) => job.status !== "completed") ||
            disagreementLenses.has(id))
        )
          lensStates.set(id, "incomplete");
      }),
    );
    if (persistenceFailure) throw persistenceFailure;
    const final = await workspaceIdentity(
        input.context.workspace,
        new AbortController().signal,
        input.context.review_scope.paths,
      ),
      changed = initial.sha256 !== final.sha256;
    await input.record({
      record: "run.native_consistency",
      data: {
        contract: "native_review_v1",
        consistency_mode: "live_worktree",
        initial,
        final,
        changed,
      },
    });
    const gatePolicies = Object.fromEntries(
      jobs.map(({ reviewer: r }) => [
        lens(r),
        {
          minimumSeverity: r.policy?.gateMinimumSeverity ?? "medium",
          minimumConfidence: r.policy?.gateMinimumConfidence ?? "medium",
        },
      ]),
    );
    const canonical = canonicalizeFindings(raw, {
      proofBySourceRef: proofs,
      gatePolicies,
    });
    const unresolved = canonical.atomics.some((f) =>
      f.gate_eligibility.reasons.some((r) =>
        [
          "evidence_unverified",
          "source_coverage_unverified",
          "ordered_proof_missing",
          "change_impact_unverified",
          "adjudication_required",
        ].includes(r),
      ),
    );
    const partial =
      Boolean(outputFailure) ||
      changed ||
      !initial.complete ||
      !final.complete ||
      unresolved ||
      [...lensStates.values()].some(
        (s) => s === "incomplete" || s === "not_evaluated",
      );
    const coverage = partial ? "partial" : "complete",
      cancelled = input.signal.aborted;
    const outcome = runOutcome({
      cancelled,
      coverage,
      gateFindings: canonical.counts.gate_eligible_subfindings,
    });
    const {
      raw: _raw,
      unique: _unique,
      gate: _gate,
      advisory: _advisory,
      ...findingCounts
    } = canonical.counts;
    const samples = boundedList(
        [...lensStates].map(([lens_id, outcome]) => ({ lens_id, outcome })),
        (x) => x.lens_id,
      ),
      exclusions = boundedList(
        jobs.filter((j) => j.status === "skipped").map((j) => j.reviewer.id),
        (x) => x,
      );
    const summary = {
      run_outcome: outcome,
      gate_outcome:
        findingCounts.gate_eligible_subfindings > 0
          ? "gate_findings"
          : "no_gate_findings",
      coverage_outcome: coverage,
      exit_code: cancelled
        ? 4
        : partial
          ? 3
          : findingCounts.gate_eligible_subfindings > 0
            ? 1
            : 0,
      ...findingCounts,
      ...(execution.review_profile
        ? { review_profile: execution.review_profile }
        : {}),
      model_runs: counts(),
      incomplete_lenses: [...lensStates.values()].filter(
        (s) => s === "incomplete" || s === "not_evaluated",
      ).length,
      execution_coverage: { status: partial ? "partial" : "complete" },
      change_coverage: { status: partial ? "incomplete" : "complete" },
      deadline,
      total_elapsed_ms: Math.max(0, now() - start),
      result_delivery: {
        completed_results: completedResults,
        artifact: "complete",
        planned_public_stream:
          input.outputMode === "full-jsonl" ? "complete" : "references_only",
      },
      lens_summaries: samples.items,
      total_lens_summaries: samples.total,
      omitted_lens_summaries_count: samples.omitted,
      lens_summaries_digest: samples.sha256,
      exclusions: exclusions.items,
      total_exclusions: exclusions.total,
      omitted_exclusions_count: exclusions.omitted,
      exclusions_digest: exclusions.sha256,
      warnings: [
        ...(changed ? ["workspace_changed_during_review"] : []),
        ...(disagreementLenses.size ? ["adjudication_disagreement"] : []),
      ],
      deficit_samples: [],
    };
    await input.record({
      record: "run.findings",
      data: {
        raw,
        proof_by_source_ref: proofs,
        adjudication_outcomes: adjudicationOutcomes,
        gate_policies: gatePolicies,
        canonical_counts: findingCounts,
      },
    });
    if (heartbeat) clearInterval(heartbeat);
    await pendingHeartbeat;
    await input.writer.finish(summary);
    return {
      exitCode: summary.exit_code,
      runOutcome: outcome,
      summary,
      canonical,
      jobs,
    };
  } finally {
    clearTimeout(timer);
    if (heartbeat) clearInterval(heartbeat);
    input.signal.removeEventListener("abort", onAbort);
    controller.abort();
    wake();
    await pendingHeartbeat;
  }
}
