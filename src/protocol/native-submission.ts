import type { ResolvedReviewer } from "../config/schemas.js";
import type { ResolvedContext } from "../context/resolve.js";
import type { AdjudicationResultV2 } from "./v9.js";
import { validateNativeSubmission } from "./native-review.js";

/** Adjudication requires assigned IDs, while the native reviewer owns evidence assessment. */
export async function validateNativeAdjudicationSubmission(
  reviewer: ResolvedReviewer,
  context: ResolvedContext,
  result: AdjudicationResultV2,
  signal: AbortSignal,
): Promise<{ accepted: true } | { accepted: false; message: string }> {
  signal.throwIfAborted();
  return validateNativeSubmission(reviewer, context, result);
}
