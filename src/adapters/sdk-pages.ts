import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createResultPageCollector,
  MAX_RESULT_PAGE_BYTES,
  ResultPageError,
  type ResultPageCollector,
} from "../results/result-pages.js";
import type { AdapterReviewInput } from "./types.js";
import { sanitizeAdapterFailure, type AdapterFailure } from "./errors.js";
import {
  resultPageRequestMessage,
  resultPageSchemaFor,
} from "./openai-pages.js";
import {
  createResultSpool,
  recordInvalidResultSpool,
  ResultSpoolError,
  type ResultSpool,
} from "./result-spool.js";

export function pageCollectorFor(
  input: AdapterReviewInput,
):
  | { collector: ResultPageCollector; resultKind: "reviewer" | "adjudication" }
  | undefined {
  if (input.resultPages === undefined) return undefined;
  const resultKind =
    "resultKind" in input.resultPages
      ? input.resultPages.resultKind
      : input.reviewer.policy?.mode === "adjudication"
        ? "adjudication"
        : "reviewer";
  return {
    collector:
      "nextRequest" in input.resultPages
        ? input.resultPages
        : createResultPageCollector(input.resultPages),
    resultKind,
  };
}

export function nextPageAssignment(
  collector: ResultPageCollector,
  resultKind: "reviewer" | "adjudication",
) {
  const request = collector.nextRequest();
  return {
    request,
    prompt: resultPageRequestMessage(request, resultKind),
    schema: resultPageSchemaFor(request, resultKind),
  };
}

export function pageFailure(error: unknown, provider: string): AdapterFailure {
  const reason =
    error instanceof ResultPageError
      ? error.reason
      : error instanceof ResultSpoolError && error.code === "result_too_large"
        ? "result_page_too_large"
        : "invalid_result";
  const failureCode =
    reason === "result_page_too_large" ||
    reason === "structured_page_limit_exceeded"
      ? reason
      : "provider_response_invalid";
  return sanitizeAdapterFailure(
    reason,
    error instanceof Error
      ? `${provider} returned an invalid structured result page: ${error.message}`
      : `${provider} returned an invalid structured result page.`,
    false,
    {
      fallback_eligible: true,
      circuit_qualifying: false,
      diagnostics: {
        failure_code: failureCode,
        failure_stage: "structured_result_page",
        scope: "model",
        ...(error instanceof ResultPageError
          ? {
              validation_issues: error.validationIssues,
              ...(error.artifactRef === undefined
                ? {}
                : { artifact_ref: error.artifactRef }),
            }
          : {}),
        ...(error instanceof ResultPageError &&
        error.receivedBytes !== undefined
          ? { response_bytes: error.receivedBytes }
          : {}),
      },
    },
  );
}

export const MAX_PAGE_SCHEMA_REPAIRS = 2;

export function coverageRepairMessage(
  input: AdapterReviewInput,
  assignment: string,
): string | undefined {
  const status = input.coverage?.status();
  if (
    status?.proof_kind !== "observed" ||
    status.complete ||
    !status.deficits.some((entry) => entry.missing_byte_ranges.length > 0)
  )
    return undefined;
  return [
    "Before finalization, use targeted read_file calls to inspect only the missing snapshot byte ranges listed below. Keep all existing analysis and candidate findings. Call coverage_status to verify progress, then return the current assigned header again with all substantive findings preserved.",
    `Core coverage status: ${JSON.stringify(status)}`,
    assignment,
  ].join("\n\n");
}

export function isRepairablePageError(
  error: unknown,
): error is ResultPageError {
  return (
    error instanceof ResultPageError &&
    (error.reason === "provider_response_invalid" ||
      error.reason === "protocol_violation")
  );
}

export function pageRepairMessage(
  error: ResultPageError,
  assignment: string,
): string {
  const failure = pageFailure(error, "Reviewer");
  return [
    "Repair only the rejected result page in this existing review conversation. Do not repeat repository inspection.",
    "Preserve every candidate finding, finding ID, evidence, declared finding count, and substantive conclusion. Never omit findings or weaken the verdict to satisfy the schema. Correct only the reported format/envelope violations; summaries and notes may be rewritten concisely.",
    `Validation failure: ${failure.message}`,
    `Schema issues: ${JSON.stringify(failure.diagnostics?.validation_issues ?? [])}`,
    assignment,
  ].join("\n\n");
}

export function failedPageRepair(
  error: unknown,
  provider: string,
  attempts: number,
  checkpointId: string,
): AdapterFailure {
  const failure = pageFailure(error, provider);
  return sanitizeAdapterFailure(failure.reason, failure.message, false, {
    fallback_eligible: true,
    circuit_qualifying: false,
    diagnostics: {
      ...failure.diagnostics,
      repair_attempted: attempts > 0,
      repair_outcome: attempts > 0 ? "failed" : "not_attempted",
      attempt_count: attempts + 1,
      checkpoint_id: checkpointId,
      recommended_action:
        "Inspect the private diagnostic artifact; retry this incomplete model with the current trusted configuration.",
    },
  });
}

export interface ResultPageStorageBridge {
  addPage(
    collector: ResultPageCollector,
    raw: string,
    pageIndex: number,
  ): Promise<void>;
  abandon(): Promise<void>;
  resultStorage(): {
    serializationBoundary?: "provider_raw" | "sdk_canonical_json";
    pages(): AsyncIterable<{ raw: string; sha256: string }>;
    persisted(): Promise<void>;
    abandoned(): Promise<void>;
  };
}

export async function assembleResultPages(
  collector: ResultPageCollector,
  storage: ResultPageStorageBridge,
  provider: string,
): Promise<
  | { ok: true; result: ReturnType<ResultPageCollector["assemble"]> }
  | { ok: false; failure: AdapterFailure }
> {
  try {
    return { ok: true, result: collector.assemble() };
  } catch (error) {
    await storage.abandon();
    return { ok: false, failure: pageFailure(error, provider) };
  }
}

/** Stores each serialized page before validation and retains rejected bytes. */
export function createResultPageStorageBridge(
  input: AdapterReviewInput,
  options: {
    serializationBoundary?: "provider_raw" | "sdk_canonical_json";
  } = {},
): ResultPageStorageBridge {
  const accepted: ResultSpool[] = [];
  const pageIndices = new WeakMap<ResultSpool, number>();
  const recorded = new WeakSet<ResultSpool>();
  let checkpointId = "result-production";
  const retain = async (spool: ResultSpool) => {
    try {
      if (!recorded.has(spool)) {
        await recordInvalidResultSpool({
          spool,
          runId: input.runId,
          reviewerId: input.reviewer.id,
          pageIndex: pageIndices.get(spool) ?? 0,
          checkpointId,
          reason: "result_production_abandoned",
        });
        recorded.add(spool);
      }
    } finally {
      await spool.lifecycle().abandoned();
    }
  };
  let active: ResultSpool | undefined;
  const spoolId = (pageIndex: number) =>
    `${input.runId}-${input.reviewer.id}-${pageIndex}-${randomUUID()}`.replace(
      /[^A-Za-z0-9_-]/gu,
      "-",
    );
  return {
    async addPage(collector, raw, pageIndex) {
      const spool = await createResultSpool({
        directory: join(tmpdir(), "review-mesh-result-spools"),
        id: spoolId(pageIndex),
        reviewedWorkspace: input.context.workspace,
        maximumBytes: MAX_RESULT_PAGE_BYTES,
      });
      active = spool;
      checkpointId = collector.nextRequest().resultId;
      pageIndices.set(spool, pageIndex);
      try {
        await spool.append(raw);
        collector.addPage(raw);
        accepted.push(spool);
        active = undefined;
      } catch (error) {
        if (error instanceof ResultPageError) {
          error.artifactRef = await recordInvalidResultSpool({
            spool,
            runId: input.runId,
            reviewerId: input.reviewer.id,
            pageIndex,
            checkpointId: collector.nextRequest().resultId,
            reason: error.reason,
            validationIssues: error.validationIssues,
          });
          recorded.add(spool);
        }
        await retain(spool).catch(() => undefined);
        active = undefined;
        throw error;
      }
    },
    async abandon() {
      if (active !== undefined) await retain(active).catch(() => undefined);
      active = undefined;
      await Promise.all(
        accepted.map((spool) => retain(spool).catch(() => undefined)),
      );
      accepted.length = 0;
    },
    resultStorage() {
      const spools = accepted.splice(0);
      return {
        ...(options.serializationBoundary === undefined
          ? {}
          : { serializationBoundary: options.serializationBoundary }),
        async *pages() {
          for (const spool of spools) {
            const raw = await spool.readText();
            yield {
              raw,
              sha256: createHash("sha256").update(raw, "utf8").digest("hex"),
            };
          }
        },
        async persisted() {
          await Promise.all(
            spools.map((spool) => spool.lifecycle().persisted()),
          );
        },
        async abandoned() {
          await Promise.all(spools.map((spool) => retain(spool)));
        },
      };
    },
  };
}

/** Credits a captured diff only after the provider has returned an admitted reply. */
export function acknowledgeInitialDiffDelivery(
  input: AdapterReviewInput,
): void {
  const git = input.context.git;
  const delivery = input.prompt.delivery;
  if (
    input.coverage === undefined ||
    !git.is_repository ||
    git.raw_diff === undefined ||
    git.truncated.diff ||
    delivery === undefined ||
    delivery.userSha256 !==
      createHash("sha256").update(input.prompt.user, "utf8").digest("hex") ||
    delivery.diff.byteCount !== git.raw_diff.byte_count ||
    delivery.diff.sha256 !== git.raw_diff.sha256
  ) {
    return;
  }
  input.coverage.recordDiffDelivery(delivery.diff.paths, {
    byteCount: delivery.diff.byteCount,
    sha256: delivery.diff.sha256,
  });
}

export function outputTruncatedFailure(provider: string): AdapterFailure {
  return sanitizeAdapterFailure(
    "output_truncated",
    `${provider} truncated the structured result at its output limit.`,
    true,
    {
      fallback_eligible: true,
      circuit_qualifying: false,
      diagnostics: {
        failure_code: "output_truncated",
        failure_stage: "structured_result_truncation",
        scope: "model",
        finish_reason: "length",
        truncated: true,
      },
    },
  );
}
