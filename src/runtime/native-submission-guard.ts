import type { ResolvedReviewer } from "../config/schemas.js";
import type { ResolvedContext } from "../context/resolve.js";
import type {
  ProviderReviewerResultV4,
  AdjudicationResultV2,
} from "../protocol/v9.js";
import { validateNativeSubmission } from "../protocol/native-review.js";

export type NativeSubmissionResult =
  ProviderReviewerResultV4 | AdjudicationResultV2;
export type NativeSubmissionValidation =
  { accepted: true } | { accepted: false; message: string };
export interface NativeSubmissionGuardOptions {
  reviewer: ResolvedReviewer;
  context: ResolvedContext;
  signal: AbortSignal;
}

/** Validate each submission independently so native agents can revise their assessment. */
export function createNativeSubmissionGuard(
  options: NativeSubmissionGuardOptions,
) {
  return {
    async validate(
      result: NativeSubmissionResult,
    ): Promise<NativeSubmissionValidation> {
      options.signal.throwIfAborted();
      return validateNativeSubmission(
        options.reviewer,
        options.context,
        result,
      );
    },
  };
}
