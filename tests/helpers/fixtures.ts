import type {
  ReviewRequest,
  ReviewerResult,
  ReviewerOutput,
  ReviewerResultV3,
} from "../../src/protocol/schemas.js";
import type {
  ResolvedConfig,
  ResolvedReviewer,
  TrustedConfigV1,
} from "../../src/config/schemas.js";
import type { ResolvedContext } from "../../src/context/resolve.js";
import type { AdapterFailure } from "../../src/adapters/errors.js";
import type { SuiteState } from "../../src/orchestrator/state.js";
import { createSuiteState } from "../../src/orchestrator/state.js";
import type {
  IncompleteReason,
  PublicEvent,
  ReviewerTerminalRecord,
} from "../../src/protocol/schemas.js";
import { PassThrough } from "node:stream";
import { AdapterRegistry } from "../../src/adapters/registry.js";
import type { ReviewAdapter } from "../../src/adapters/types.js";
import { createEventWriter } from "../../src/protocol/event-writer.js";
import type { RunReviewRoundInput } from "../../src/orchestrator/run-review.js";
import { FakeAdapter } from "./fake-adapter.js";

type CompletedTerminalRecord = Extract<
  ReviewerTerminalRecord,
  { status: "completed" }
>;
type IncompleteTerminalRecord = Extract<
  ReviewerTerminalRecord,
  { status: "incomplete" }
>;

export type DeepPartial<T> = T extends (infer Item)[]
  ? DeepPartial<Item>[]
  : T extends object
    ? { [Key in keyof T]?: DeepPartial<T[Key]> }
    : T;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge<T>(base: T, override: DeepPartial<T> | undefined): T {
  if (override === undefined) return base;
  if (!isRecord(base) || !isRecord(override)) return override as T;
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    result[key] =
      isRecord(value) && isRecord(result[key])
        ? deepMerge(result[key], value)
        : value;
  }
  return result as T;
}

export function request(overrides?: Partial<ReviewRequest>): ReviewRequest {
  return {
    schema_version: "2",
    project_name: "demo",
    workspace: "F:\\Projects\\demo",
    instructions: "Review the changes.",
    review_scope: { mode: "changes" },
    ...overrides,
  };
}

export function resolvedContext(
  overrides?: Partial<ResolvedContext>,
): ResolvedContext {
  const base: ResolvedContext = {
    consistency_mode: "live_worktree",
    workspace: "F:\\Projects\\demo",
    project_name: "demo",
    instructions: "Review the changes.",
    review_scope: { mode: "changes", source: "request" },
    git: { is_repository: false },
  };
  return {
    ...base,
    ...overrides,
    ...(overrides?.git === undefined
      ? {}
      : { git: { ...base.git, ...overrides.git } as ResolvedContext["git"] }),
  };
}

export function trustedConfig(
  overrides?: DeepPartial<TrustedConfigV1>,
): TrustedConfigV1 {
  const base: TrustedConfigV1 = {
    schema_version: "1",
    execution: {
      max_concurrency: 1,
      heartbeat_interval_ms: 1_000,
      shutdown_grace_period_ms: 1_000,
    },
    diagnostics: { persist_runs: false, max_runs: 10 },
    adapters: {
      "claude-main": {
        type: "command",
        command: "reviewer",
        protocol: "review-mesh-command-v1",
      },
    },
    reviewer_profiles: {
      "security-profile": {
        adapter: "claude-main",
        model: "test-model",
        purpose: "Find security defects",
        instructions: "Find security bugs.",
        isolation: "prefer_enforced",
        timeout_ms: 900_000,
        runtime: {},
      },
    },
    reviewers: [{ id: "baseline", profile: "security-profile" }],
  };
  return deepMerge(base, overrides);
}

export function resolvedReviewer(
  overrides?: Partial<ResolvedReviewer>,
): ResolvedReviewer {
  return {
    id: "baseline",
    purpose: "Find security defects",
    adapterId: "claude-main",
    adapter: {
      type: "command",
      command: "reviewer",
      protocol: "review-mesh-command-v1",
    },
    model: "test-model",
    instruction_layers: [{ source: "trusted", content: "Find security bugs." }],
    isolationPolicy: "prefer_enforced",
    timeoutMs: 900_000,
    runtime: {},
    ...overrides,
  };
}

export function passResult(
  summary = "No actionable findings.",
): ReviewerResultV3 {
  return {
    schema_version: "3",
    verdict: "pass",
    review_markdown: `# Review\n\n${summary}`,
    summary,
    actionable_findings: [],
    informational_notes: [],
  };
}

export function failResult(id = "f-1"): ReviewerResultV3 {
  return {
    schema_version: "3",
    verdict: "fail",
    review_markdown: "# Review\n\nOne actionable finding was found.",
    summary: "An actionable finding was found.",
    actionable_findings: [
      {
        id,
        severity: "high",
        title: "Bug",
        description: "Broken invariant",
        evidence: [{ detail: "Evidence." }],
        suggested_direction: "Restore the invariant.",
        confidence: "high",
        classification: "confirmed_defect",
        external_assumptions: [],
        category: "correctness",
        verification: "Evidence directly demonstrates the broken invariant.",
      },
    ],
    informational_notes: [],
  };
}

export function fakeAdapterReturning(
  result: ReviewerOutput,
  delayMs = 0,
): FakeAdapter {
  return new FakeAdapter({
    onRun: (queue, input) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          queue.push({
            type: "result",
            result,
            isolation: "enforced_read_only",
          });
          resolve();
        }, delayMs);
        input.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      }),
  });
}

export function roundInput(
  overrides?: DeepPartial<RunReviewRoundInput> & {
    adapters?: Record<string, ReviewAdapter>;
    onEvent?: (event: PublicEvent) => void;
  },
): RunReviewRoundInput {
  const suppliedAdapters: Record<string, ReviewAdapter> =
    overrides?.adapters ?? {
      baseline: fakeAdapterReturning(passResult()),
    };
  const reviewers = Object.keys(suppliedAdapters).map((id) =>
    resolvedReviewer({
      id,
      adapterId: id,
      adapter: {
        type: "command",
        command: id,
        protocol: "review-mesh-command-v1",
      },
    }),
  );
  const config: ResolvedConfig = {
    execution: {
      max_concurrency: 2,
      heartbeat_interval_ms: 100,
      shutdown_grace_period_ms: 50,
      distribute_primaries: false,
      allow_provider_concentration: false,
      default_provider_concurrency: 2,
      provider_limits: {},
      circuit_breaker_threshold: 2,
      circuit_breaker_cooldown_ms: 30_000,
      retry_attempts: 2,
      continuation_attempts: 2,
      retry_backoff_ms: 1_000,
    },
    diagnostics: { persist_runs: false, max_runs: 10 },
    selection: { source: "defaults" },
    project_context: { source: "project" },
    reviewers,
  };
  const registry = new AdapterRegistry();
  registry.register("command", (registration) => {
    if (registration.type !== "command") {
      throw new Error("expected command registration");
    }
    const adapter = suppliedAdapters[registration.command];
    if (adapter === undefined) {
      throw new Error(`missing fake adapter: ${registration.command}`);
    }
    return adapter;
  });
  const output = new PassThrough();
  output.setEncoding("utf8");
  let buffered = "";
  output.on("data", (chunk: string) => {
    buffered += chunk;
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line.length > 0)
        overrides?.onEvent?.(JSON.parse(line) as PublicEvent);
    }
  });
  const clock = {
    now: () => new Date(),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
  };
  const base: RunReviewRoundInput = {
    runId: "run-1",
    requestId: "request-1",
    config,
    context: resolvedContext(),
    registry,
    writer: createEventWriter({
      output,
      runId: "run-1",
      requestId: "request-1",
      now: clock.now,
    }),
    signal: new AbortController().signal,
    clock,
  };
  const {
    adapters: _adapters,
    onEvent: _onEvent,
    ...inputOverrides
  } = overrides ?? {};
  const merged = deepMerge(base, inputOverrides);
  if (overrides?.config?.reviewers !== undefined) {
    merged.config.reviewers = reviewers.map((reviewer, index) =>
      deepMerge(reviewer, overrides.config?.reviewers?.[index]),
    );
  }
  if (overrides?.signal !== undefined) {
    merged.signal = overrides.signal as AbortSignal;
  }
  if (overrides?.registry !== undefined) {
    merged.registry = overrides.registry as AdapterRegistry;
  }
  if (overrides?.writer !== undefined) {
    merged.writer = overrides.writer as RunReviewRoundInput["writer"];
  }
  if (overrides?.clock !== undefined) {
    merged.clock = overrides.clock as RunReviewRoundInput["clock"];
  }
  return merged;
}

export function completedPass(id: string): CompletedTerminalRecord {
  return {
    reviewer_id: id,
    status: "completed",
    adapter: "claude-main",
    model: "test-model",
    isolation: "enforced_read_only",
    elapsed_ms: 0,
    result: passResult(),
  };
}

export function completedFail(id: string): CompletedTerminalRecord {
  return {
    ...completedPass(id),
    result: failResult(`${id}-finding`),
  };
}

export function incomplete(
  id: string,
  reason: IncompleteReason,
): IncompleteTerminalRecord {
  const failure: AdapterFailure = {
    reason,
    message: `Reviewer ${id} did not complete.`,
    retryable: reason === "timeout",
  };
  return {
    reviewer_id: id,
    status: "incomplete",
    adapter: "claude-main",
    model: "test-model",
    elapsed_ms: 0,
    reason,
    message: failure.message,
    retryable: failure.retryable,
  };
}

export function suiteState(reviewers: ReviewerTerminalRecord[]): SuiteState {
  const state = createSuiteState(
    reviewers.map((terminal) =>
      resolvedReviewer({
        id: terminal.reviewer_id,
        adapterId: terminal.adapter,
        model: terminal.model,
      }),
    ),
  );
  for (const terminal of reviewers) {
    if (terminal.status === "completed") {
      state.transition(terminal.reviewer_id, "probing");
      state.transition(terminal.reviewer_id, "starting");
      state.transition(terminal.reviewer_id, "reviewing");
      state.complete(terminal.reviewer_id, terminal.result, terminal.isolation);
    } else if (terminal.status === "incomplete") {
      state.incomplete(
        terminal.reviewer_id,
        {
          reason: terminal.reason,
          message: terminal.message,
          retryable: terminal.retryable,
        },
        terminal.isolation,
      );
    } else {
      state.skip(
        terminal.reviewer_id,
        terminal.reason,
        terminal.blocked_by_reviewer_id,
      );
    }
  }
  return state;
}
