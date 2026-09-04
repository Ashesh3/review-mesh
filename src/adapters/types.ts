import type {
  AdapterRegistration,
  ResolvedReviewer,
} from "../config/schemas.js";
import type { ResolvedContext } from "../context/resolve.js";
import type {
  IsolationLevel,
  IsolationPolicy,
  ReviewerOutput,
} from "../protocol/schemas.js";
import type { ReviewerPromptBundle } from "../protocol/prompt.js";
import type { AdapterFailure } from "./errors.js";

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
}

export interface AdapterReviewInput {
  runId: string;
  reviewer: ResolvedReviewer;
  context: ResolvedContext;
  prompt: ReviewerPromptBundle;
  resultJsonSchema: Record<string, unknown>;
  isolationPolicy: IsolationPolicy;
  signal: AbortSignal;
}

export type AdapterEvent =
  | { type: "progress"; phase: string; message?: string }
  | { type: "activity"; message: string }
  | { type: "result"; result: ReviewerOutput; isolation: IsolationLevel }
  | { type: "failure"; failure: AdapterFailure; isolation?: IsolationLevel };

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
