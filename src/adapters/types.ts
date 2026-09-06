import type {
  AdapterRegistration,
  ResolvedReviewer,
} from "../config/schemas.js";
import type { ResolvedContext } from "../context/resolve.js";
import type {
  IsolationLevel,
  IsolationPolicy,
  ReviewerOutput,
  ProviderReviewerResultV4,
  AdjudicationResultV2,
} from "../protocol/schemas.js";
import type { ReviewerPromptBundle } from "../protocol/prompt.js";
import type { ChangeCoverageLedger } from "../context/change-coverage.js";
import type {
  ResultPageCollector,
  ResultPageCollectorOptions,
} from "../results/result-pages.js";
import type { AdapterFailure, AdapterFailureDiagnostics } from "./errors.js";

export interface InspectionProgress {
  turn: number;
  maximum_turns: number;
  remaining_turns: number;
  inspected_count: number;
  deficit_count: number;
  remaining_bytes: number;
}
export interface ReviewerDraftDiagnostic {
  kind: "unverified_result_draft";
  checkpoint_id: string;
  page_index?: number;
  accepted_page_count: number;
  candidate_ids: string[];
  unresolved_obligations: string[];
  candidate?: Record<string, unknown>;
  validation_issues?: AdapterFailureDiagnostics["validation_issues"];
  raw_excerpt?: string;
  diagnostics?: AdapterFailureDiagnostics;
  candidate_mutations?: Array<{
    candidate_id: string;
    original_sha256: string;
    returned_sha256: string;
    changed_fields: string[];
  }>;
  result_kind?: "reviewer" | "adjudication";
  assigned_candidate_ids?: string[];
  accepted_decision_ids?: string[];
  missing_decision_ids?: string[];
  decision?: Record<string, unknown>;
}
export interface AdapterExceptionDiagnostic {
  kind: "adapter_exception";
  diagnostics: AdapterFailureDiagnostics;
}
export interface SegmentDiagnostic {
  kind: "review_segment";
  segment_id: string;
  index: number;
  phase: "evidence" | "synthesis";
  data: Record<string, unknown>;
}
export type AdapterDiagnostic =
  ReviewerDraftDiagnostic | AdapterExceptionDiagnostic | SegmentDiagnostic;

export interface AdapterCapabilities {
  available: boolean;
  authenticated: boolean | "unknown";
  model_available: boolean | "unknown";
  streaming: boolean;
  cancellation: boolean;
  /** A preflight capability claim; run events report actual achieved isolation. */
  maximumIsolation: IsolationLevel | "unknown";
  runtime_version?: string;
  message?: string;
  /** Readiness failed transiently and may be probed once more. */
  retryable?: boolean;
  observed_file_access?: boolean;
  progress_observable?: boolean;
}

export interface AdapterReviewInput {
  runId: string;
  reviewer: ResolvedReviewer;
  context: ResolvedContext;
  prompt: ReviewerPromptBundle;
  resultJsonSchema: Record<string, unknown>;
  isolationPolicy: IsolationPolicy;
  signal: AbortSignal;
  coverage?: ChangeCoverageLedger;
  resultPages?: ResultPageCollector | ResultPageCollectorOptions;
  recordDiagnostic?(diagnostic: AdapterDiagnostic): Promise<void>;
}

export type AdapterEvent =
  | {
      type: "progress";
      phase: string;
      message?: string;
      identity?: string;
      byteCount?: number;
      inspection?: InspectionProgress;
      segment?: SegmentProgress;
    }
  | { type: "activity"; message: string; identity?: string; byteCount?: number }
  | {
      type: "result";
      result: ReviewerOutput | ProviderReviewerResultV4 | AdjudicationResultV2;
      isolation: IsolationLevel;
      /** Adapter-owned exact-result storage lifecycle. */
      resultStorage?: {
        serializationBoundary?: "provider_raw" | "sdk_canonical_json";
        pages?(): AsyncIterable<{ raw: string; sha256: string }>;
        persisted(): void | Promise<void>;
        abandoned(): void | Promise<void>;
      };
    }
  | { type: "failure"; failure: AdapterFailure; isolation?: IsolationLevel };

export interface SegmentProgress {
  index: number;
  phase: "evidence" | "synthesis";
  input_budget_tokens: number;
  estimated_input_tokens: number;
  completed_segments?: number;
  last_completed_checkpoint?: string;
  delivered_bytes?: number;
  remaining_bytes?: number;
  unresolved_questions?: number;
}

export interface ReviewAdapter {
  readonly id: string;
  probe(
    reviewer: ResolvedReviewer,
    signal: AbortSignal,
  ): Promise<AdapterCapabilities>;
  run(input: AdapterReviewInput): AsyncIterable<AdapterEvent>;
  forceCleanup?(): Promise<void>;
}

export type AdapterFactory = (
  registration: AdapterRegistration,
  options?: { continuationAttempts?: number },
) => ReviewAdapter;

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const platformLaunchNames =
  process.platform === "win32"
    ? [
        "PATH",
        "Path",
        "PATHEXT",
        "SystemRoot",
        "SYSTEMROOT",
        "ComSpec",
        "COMSPEC",
        "WINDIR",
      ]
    : ["PATH"];

/**
 * Builds a child-process environment from launch essentials and names approved
 * by trusted configuration. It never exposes the parent object for mutation.
 */
export function buildAllowlistedEnvironment(
  names: readonly string[] | undefined,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const requested = [...platformLaunchNames, ...(names ?? [])];
  const environment: NodeJS.ProcessEnv = {};

  for (const name of requested) {
    if (!ENVIRONMENT_NAME.test(name)) {
      throw new Error(`invalid environment variable name: ${name}`);
    }
    const value = Object.hasOwn(source, name) ? source[name] : undefined;
    if (typeof value === "string") environment[name] = value;
  }
  return environment;
}
