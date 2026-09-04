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
        ...(error instanceof ResultPageError &&
        error.receivedBytes !== undefined
          ? { response_bytes: error.receivedBytes }
          : {}),
      },
    },
  );
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

/** Stores each serialized page before validation and retains rejected bytes. */
export function createResultPageStorageBridge(
  input: AdapterReviewInput,
  options: {
    serializationBoundary?: "provider_raw" | "sdk_canonical_json";
  } = {},
): ResultPageStorageBridge {
  const accepted: ResultSpool[] = [];
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
      try {
        await spool.append(raw);
        collector.addPage(raw);
        accepted.push(spool);
        active = undefined;
      } catch (error) {
        await spool
          .lifecycle()
          .abandoned()
          .catch(() => undefined);
        active = undefined;
        throw error;
      }
    },
    async abandon() {
      await active
        ?.lifecycle()
        .abandoned()
        .catch(() => undefined);
      active = undefined;
      await Promise.all(
        accepted.map((spool) =>
          spool
            .lifecycle()
            .abandoned()
            .catch(() => undefined),
        ),
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
          await Promise.all(
            spools.map((spool) => spool.lifecycle().abandoned()),
          );
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
  if (
    input.coverage === undefined ||
    !git.is_repository ||
    git.raw_diff === undefined ||
    git.truncated.diff ||
    !input.prompt.user.includes(git.diff)
  ) {
    return;
  }
  input.coverage.recordDiffDelivery(
    git.changed_paths?.map((entry) => entry.path) ?? git.changed_files,
    { byteCount: git.raw_diff.byte_count, sha256: git.raw_diff.sha256 },
  );
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
