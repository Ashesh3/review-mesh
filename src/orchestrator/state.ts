import type { AdapterFailure } from "../adapters/errors.js";
import type { AdapterCapabilities } from "../adapters/types.js";
import type { ResolvedReviewer } from "../config/schemas.js";
import type {
  IsolationLevel,
  ReviewerResult,
  ReviewerTerminalRecord,
  RunStatus,
} from "../protocol/schemas.js";

export type ReviewerLifecycleStatus =
  | "deferred"
  | "queued"
  | "probing"
  | "starting"
  | "reviewing"
  | "validating"
  | "completed"
  | "incomplete"
  | "skipped";

export type ReviewerSkipReason = "prior_findings" | "prior_incomplete";

export interface ReviewerActivity {
  at: Date;
  message: string;
}

export interface ReviewerState {
  readonly reviewer: ResolvedReviewer;
  readonly status: ReviewerLifecycleStatus;
  readonly queuedAt: Date;
  readonly startedAt?: Date;
  readonly completedAt?: Date;
  readonly lastActivity?: ReviewerActivity;
  readonly capabilities?: AdapterCapabilities;
  readonly isolation?: IsolationLevel;
  readonly result?: ReviewerResult;
  readonly failure?: AdapterFailure;
  readonly skipReason?: ReviewerSkipReason;
  readonly blockedByReviewerId?: string;
  readonly elapsedMs?: number;
}

interface InternalReviewerState extends ReviewerState {
  reviewer: ResolvedReviewer;
  status: ReviewerLifecycleStatus;
  queuedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  lastActivity?: ReviewerActivity;
  capabilities?: AdapterCapabilities;
  isolation?: IsolationLevel;
  result?: ReviewerResult;
  failure?: AdapterFailure;
  skipReason?: ReviewerSkipReason;
  blockedByReviewerId?: string;
  elapsedMs?: number;
}

export interface SuiteState {
  readonly reviewers: readonly ReviewerState[];
  reviewer(id: string): ReviewerState;
  transition(
    id: string,
    next: "queued" | "probing" | "starting" | "reviewing" | "validating",
  ): ReviewerState;
  recordActivity(id: string, message: string): ReviewerState;
  setCapabilities(id: string, capabilities: AdapterCapabilities): ReviewerState;
  setIsolation(id: string, isolation: IsolationLevel): ReviewerState;
  complete(
    id: string,
    result: ReviewerResult,
    isolation: IsolationLevel,
  ): ReviewerState;
  incomplete(
    id: string,
    failure: AdapterFailure,
    isolation?: IsolationLevel,
  ): ReviewerState;
  skip(
    id: string,
    reason: ReviewerSkipReason,
    blockedByReviewerId: string,
  ): ReviewerState;
}

export interface SuiteSummary {
  total: number;
  deferred: number;
  queued: number;
  running: number;
  completed: number;
  incomplete: number;
  skipped: number;
}

export interface RunAggregate {
  status: RunStatus;
  reviewers: ReviewerTerminalRecord[];
}

const transitions: Readonly<
  Record<ReviewerLifecycleStatus, readonly ReviewerLifecycleStatus[]>
> = {
  deferred: ["queued"],
  queued: ["probing", "starting"],
  probing: ["queued", "starting"],
  starting: ["reviewing"],
  reviewing: ["validating"],
  validating: [],
  completed: [],
  incomplete: [],
  skipped: [],
};

function elapsedMs(state: InternalReviewerState, now: Date): number {
  return Math.max(
    0,
    now.getTime() - (state.startedAt ?? state.queuedAt).getTime(),
  );
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function terminalRecord(state: ReviewerState): ReviewerTerminalRecord {
  if (
    state.status === "completed" &&
    state.result !== undefined &&
    state.isolation !== undefined
  ) {
    return {
      reviewer_id: state.reviewer.id,
      status: "completed",
      adapter: state.reviewer.adapterId,
      model: state.reviewer.model,
      isolation: state.isolation,
      elapsed_ms: state.elapsedMs ?? 0,
      result: clone(state.result),
    };
  }
  if (state.status === "incomplete" && state.failure !== undefined) {
    return {
      reviewer_id: state.reviewer.id,
      status: "incomplete",
      adapter: state.reviewer.adapterId,
      model: state.reviewer.model,
      ...(state.isolation === undefined ? {} : { isolation: state.isolation }),
      elapsed_ms: state.elapsedMs ?? 0,
      reason: state.failure.reason,
      message: state.failure.message,
      retryable: state.failure.retryable,
    };
  }
  if (
    state.status === "skipped" &&
    state.skipReason !== undefined &&
    state.blockedByReviewerId !== undefined
  ) {
    return {
      reviewer_id: state.reviewer.id,
      status: "skipped",
      adapter: state.reviewer.adapterId,
      model: state.reviewer.model,
      elapsed_ms: state.elapsedMs ?? 0,
      reason: state.skipReason,
      blocked_by_reviewer_id: state.blockedByReviewerId,
    };
  }
  throw new Error(`reviewer "${state.reviewer.id}" is not terminal`);
}

function snapshot(state: InternalReviewerState): ReviewerState {
  return {
    ...state,
    reviewer: clone(state.reviewer),
    queuedAt: new Date(state.queuedAt),
    ...(state.startedAt === undefined
      ? {}
      : { startedAt: new Date(state.startedAt) }),
    ...(state.completedAt === undefined
      ? {}
      : { completedAt: new Date(state.completedAt) }),
    ...(state.lastActivity === undefined
      ? {}
      : {
          lastActivity: {
            at: new Date(state.lastActivity.at),
            message: state.lastActivity.message,
          },
        }),
    ...(state.capabilities === undefined
      ? {}
      : { capabilities: clone(state.capabilities) }),
    ...(state.result === undefined ? {} : { result: clone(state.result) }),
    ...(state.failure === undefined ? {} : { failure: clone(state.failure) }),
    ...(state.skipReason === undefined ? {} : { skipReason: state.skipReason }),
    ...(state.blockedByReviewerId === undefined
      ? {}
      : { blockedByReviewerId: state.blockedByReviewerId }),
  };
}

export function createSuiteState(
  reviewers: readonly ResolvedReviewer[],
  now: () => Date = () => new Date(),
): SuiteState {
  const queuedAt = now();
  const states = reviewers.map<InternalReviewerState>((reviewer) => ({
    reviewer: clone(reviewer),
    status: (reviewer.modelIndex ?? 0) === 0 ? "queued" : "deferred",
    queuedAt,
  }));
  const byId = new Map(states.map((state) => [state.reviewer.id, state]));
  if (byId.size !== states.length)
    throw new Error("resolved reviewer roster contains duplicate ids");

  const lookup = (id: string): InternalReviewerState => {
    const state = byId.get(id);
    if (state === undefined) throw new Error(`unknown reviewer id: "${id}"`);
    return state;
  };
  const ensureActive = (state: InternalReviewerState): void => {
    if (
      state.status === "completed" ||
      state.status === "incomplete" ||
      state.status === "skipped"
    ) {
      throw new Error(`reviewer "${state.reviewer.id}" is already terminal`);
    }
  };
  const transition = (
    id: string,
    next: ReviewerLifecycleStatus,
  ): InternalReviewerState => {
    const state = lookup(id);
    if (!transitions[state.status].includes(next)) {
      throw new Error(
        `illegal reviewer transition: ${state.status} -> ${next}`,
      );
    }
    const at = now();
    if (next === "probing" && state.startedAt === undefined) {
      state.startedAt = at;
    }
    state.status = next;
    return state;
  };

  return {
    get reviewers() {
      return states.map(snapshot);
    },
    reviewer(id) {
      return snapshot(lookup(id));
    },
    transition(id, next) {
      return snapshot(transition(id, next));
    },
    recordActivity(id, message) {
      const state = lookup(id);
      ensureActive(state);
      state.lastActivity = { at: now(), message };
      return snapshot(state);
    },
    setCapabilities(id, capabilities) {
      const state = lookup(id);
      ensureActive(state);
      state.capabilities = clone(capabilities);
      return snapshot(state);
    },
    setIsolation(id, isolation) {
      const state = lookup(id);
      ensureActive(state);
      state.isolation = isolation;
      return snapshot(state);
    },
    complete(id, result, isolation) {
      const state = lookup(id);
      ensureActive(state);
      if (state.status !== "reviewing" && state.status !== "validating") {
        throw new Error(
          `illegal reviewer transition: ${state.status} -> completed`,
        );
      }
      state.status = "completed";
      state.result = clone(result);
      state.isolation = isolation;
      state.completedAt = now();
      state.elapsedMs = elapsedMs(state, state.completedAt);
      return snapshot(state);
    },
    incomplete(id, failure, isolation) {
      const state = lookup(id);
      ensureActive(state);
      state.status = "incomplete";
      state.failure = clone(failure);
      if (isolation !== undefined) state.isolation = isolation;
      state.completedAt = now();
      state.elapsedMs = elapsedMs(state, state.completedAt);
      return snapshot(state);
    },
    skip(id, reason, blockedByReviewerId) {
      const state = lookup(id);
      ensureActive(state);
      state.status = "skipped";
      state.skipReason = reason;
      state.blockedByReviewerId = blockedByReviewerId;
      state.completedAt = now();
      state.elapsedMs = 0;
      return snapshot(state);
    },
  };
}

export function summarizeSuite(state: SuiteState): SuiteSummary {
  const summary: SuiteSummary = {
    total: state.reviewers.length,
    deferred: 0,
    queued: 0,
    running: 0,
    completed: 0,
    incomplete: 0,
    skipped: 0,
  };
  for (const reviewer of state.reviewers) {
    if (reviewer.status === "deferred") summary.deferred += 1;
    else if (reviewer.status === "queued") summary.queued += 1;
    else if (reviewer.status === "completed") summary.completed += 1;
    else if (reviewer.status === "incomplete") summary.incomplete += 1;
    else if (reviewer.status === "skipped") summary.skipped += 1;
    else summary.running += 1;
  }
  return summary;
}

export function reviewerTerminalRecord(
  state: SuiteState,
  reviewerId: string,
): ReviewerTerminalRecord {
  return terminalRecord(state.reviewer(reviewerId));
}

export function aggregateRun(state: SuiteState): RunAggregate {
  const reviewers = state.reviewers.map(terminalRecord);
  const status: RunStatus = reviewers.some(
    (reviewer) => reviewer.status === "incomplete",
  )
    ? "incomplete"
    : reviewers.some(
          (reviewer) =>
            reviewer.status === "completed" &&
            reviewer.result.actionable_findings.length > 0,
        )
      ? "findings"
      : "passed";
  return { status, reviewers };
}

export function exitCodeFor(
  status: RunStatus,
  interrupted: boolean,
): 0 | 1 | 3 | 4 {
  if (interrupted) return 4;
  if (status === "passed") return 0;
  if (status === "findings") return 1;
  return 3;
}
