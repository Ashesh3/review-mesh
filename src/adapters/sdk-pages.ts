import {
  createResultPageCollector,
  ResultPageError,
  type ResultPageCollector,
} from "../results/result-pages.js";
import type { AdapterReviewInput } from "./types.js";
import { adapterFailure, type AdapterFailure } from "./errors.js";
import {
  resultPageRequestMessage,
  resultPageSchemaFor,
} from "./openai-pages.js";

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
  return adapterFailure.invalidResult(
    error instanceof ResultPageError
      ? `${provider} returned an invalid structured result page: ${error.message}`
      : `${provider} returned an invalid structured result page.`,
  );
}
