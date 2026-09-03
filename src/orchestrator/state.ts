import type { AdapterFailure } from "../adapters/errors.js";
import type { AdapterCapabilities } from "../adapters/types.js";
import type { ResolvedReviewer } from "../config/schemas.js";
import type {
  CoverageOutcome,
  GateOutcome,
  IsolationLevel,
  ReviewerMode,
  ReviewerResult,
  ReviewerSkipReason,
  ReviewerTerminalRecord,
  RunStatus,
} from "../protocol/schemas.js";
import { meetsGateThresholds } from "./lens-policy.js";

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

export interface ReviewerActivity {
  at: Date;
  message: string;
}

export interface ReviewerState {
  readonly reviewer: ResolvedReviewer;
  readonly status: ReviewerLifecycleStatus;
  readonly mode: ReviewerMode;
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
  readonly missingInputs?: readonly string[];
  readonly elapsedMs?: number;
  readonly attemptCount: number;
}

interface InternalReviewerState extends ReviewerState {
  reviewer: ResolvedReviewer;
  status: ReviewerLifecycleStatus;
  mode: ReviewerMode;
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
  missingInputs?: string[];
  elapsedMs?: number;
  attemptCount: number;
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
  setAdjudication(id: string, sourceReviewerId: string): ReviewerState;
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
    blockedByReviewerId?: string,
    missingInputs?: readonly string[],
  ): ReviewerState;
}

export interface ModelRunSummary {
  total: number;
  deferred: number;
  queued: number;
  running: number;
  completed: number;
  incomplete: number;
  skipped: number;
  skip_reasons?: Partial<Record<ReviewerSkipReason, number>> | undefined;
}

export interface LogicalLensSummary {
  total: number;
  pending: number;
  findings: number;
  passed: number;
  incomplete: number;
  not_applicable: number;
  not_evaluated: number;
  not_selected?: number | undefined;
}

export interface RunAggregate {
  status: RunStatus;
  gateOutcome: GateOutcome;
  coverageOutcome: CoverageOutcome;
  logicalLenses: LogicalLensSummary;
  modelRuns: ModelRunSummary;
  incompleteLenses: string[];
  notEvaluatedLenses: string[];
  reviewers: ReviewerTerminalRecord[];
  uniqueFindings: number;
  advisoryFindings: number;
}

export interface LogicalLensAnalysis {
  summary: LogicalLensSummary;
  incompleteLenses: string[];
  notEvaluatedLenses: string[];
  uniqueFindings: number;
  advisoryFindings: number;
}

const transitions: Record<ReviewerLifecycleStatus, ReviewerLifecycleStatus[]> =
  {
    deferred: ["queued"],
    queued: ["probing", "starting"],
    probing: ["queued", "starting"],
    starting: ["starting", "reviewing"],
    reviewing: ["validating", "starting"],
    validating: ["starting"],
    completed: [],
    incomplete: [],
    skipped: [],
  };

function clone<T>(value: T): T {
  return structuredClone(value);
}

function lensId(reviewer: ResolvedReviewer): string {
  return reviewer.agentId ?? reviewer.id;
}

function providerGroup(reviewer: ResolvedReviewer): string {
  return reviewer.providerGroup ?? reviewer.adapterId;
}

function elapsedMs(state: InternalReviewerState, now: Date): number {
  return Math.max(
    0,
    now.getTime() - (state.startedAt ?? state.queuedAt).getTime(),
  );
}

function terminalRecord(state: ReviewerState): ReviewerTerminalRecord {
  const common = {
    reviewer_id: state.reviewer.id,
    lens_id: lensId(state.reviewer),
    mode: state.mode,
    adapter: state.reviewer.adapterId,
    model: state.reviewer.model,
    provider_group: providerGroup(state.reviewer),
    elapsed_ms: state.elapsedMs ?? 0,
  };
  if (
    state.status === "completed" &&
    state.result !== undefined &&
    state.isolation !== undefined
  ) {
    return {
      ...common,
      status: "completed",
      isolation: state.isolation,
      result: clone(state.result),
    };
  }
  if (state.status === "incomplete" && state.failure !== undefined) {
    return {
      ...common,
      status: "incomplete",
      ...(state.isolation === undefined ? {} : { isolation: state.isolation }),
      reason: state.failure.reason,
      message: state.failure.message,
      retryable: state.failure.retryable,
      fallback_eligible: state.failure.fallback_eligible === true,
      ...(state.failure.circuit_qualifying === undefined
        ? {}
        : { circuit_qualifying: state.failure.circuit_qualifying }),
      ...(state.failure.diagnostics === undefined
        ? {}
        : { diagnostics: clone(state.failure.diagnostics) }),
    };
  }
  if (state.status === "skipped" && state.skipReason !== undefined) {
    return {
      ...common,
      status: "skipped",
      reason: state.skipReason,
      ...(state.blockedByReviewerId === undefined
        ? {}
        : { blocked_by_reviewer_id: state.blockedByReviewerId }),
      ...(state.missingInputs === undefined
        ? {}
        : { missing_inputs: [...state.missingInputs] }),
    };
  }
  throw new Error(`reviewer "${state.reviewer.id}" is not terminal`);
}

function snapshot(state: InternalReviewerState): ReviewerState {
  return clone(state);
}

export function createSuiteState(
  reviewers: readonly ResolvedReviewer[],
  now: () => Date = () => new Date(),
): SuiteState {
  const queuedAt = now();
  const states = reviewers.map<InternalReviewerState>((reviewer) => ({
    reviewer: clone(reviewer),
    status: (reviewer.modelIndex ?? 0) === 0 ? "queued" : "deferred",
    mode: reviewer.policy?.mode ?? "full_review",
    queuedAt,
    attemptCount: 0,
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
    if (["completed", "incomplete", "skipped"].includes(state.status)) {
      throw new Error(`reviewer "${state.reviewer.id}" is already terminal`);
    }
  };
  return {
    get reviewers() {
      return states.map(snapshot);
    },
    reviewer(id) {
      return snapshot(lookup(id));
    },
    transition(id, next) {
      const state = lookup(id);
      if (!transitions[state.status].includes(next)) {
        throw new Error(
          `illegal reviewer transition: ${state.status} -> ${next}`,
        );
      }
      const at = now();
      if (next === "probing" && state.startedAt === undefined)
        state.startedAt = at;
      if (next === "starting") {
        state.attemptCount += 1;
        if (state.status === "reviewing" || state.status === "validating") {
          delete state.isolation;
        }
      }
      state.status = next;
      return snapshot(state);
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
    setAdjudication(id, sourceReviewerId) {
      const state = lookup(id);
      ensureActive(state);
      state.mode = "adjudication";
      state.reviewer.policy = {
        ...(state.reviewer.policy ?? {
          passQuorum: 1,
          minimumProviderGroups: 1,
          adjudication: "required",
          gateMinimumSeverity: "medium",
          gateMinimumConfidence: "medium",
        }),
        mode: "adjudication",
        adjudicatesReviewerId: sourceReviewerId,
      };
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
    skip(id, reason, blockedByReviewerId, missingInputs) {
      const state = lookup(id);
      ensureActive(state);
      state.status = "skipped";
      state.skipReason = reason;
      if (blockedByReviewerId !== undefined)
        state.blockedByReviewerId = blockedByReviewerId;
      if (missingInputs !== undefined) state.missingInputs = [...missingInputs];
      state.completedAt = now();
      state.elapsedMs = 0;
      return snapshot(state);
    },
  };
}

export function summarizeSuite(state: SuiteState): ModelRunSummary {
  const summary: ModelRunSummary = {
    total: state.reviewers.length,
    deferred: 0,
    queued: 0,
    running: 0,
    completed: 0,
    incomplete: 0,
    skipped: 0,
    skip_reasons: {},
  };
  for (const reviewer of state.reviewers) {
    if (reviewer.status === "deferred") summary.deferred += 1;
    else if (reviewer.status === "queued") summary.queued += 1;
    else if (reviewer.status === "completed") summary.completed += 1;
    else if (reviewer.status === "incomplete") summary.incomplete += 1;
    else if (reviewer.status === "skipped") {
      summary.skipped += 1;
      if (reviewer.skipReason !== undefined) {
        const reasons = (summary.skip_reasons ??= {});
        reasons[reviewer.skipReason] = (reasons[reviewer.skipReason] ?? 0) + 1;
      }
    } else summary.running += 1;
  }
  if (Object.keys(summary.skip_reasons ?? {}).length === 0) {
    delete summary.skip_reasons;
  }
  return summary;
}

export function reviewerTerminalRecord(
  state: SuiteState,
  reviewerId: string,
): ReviewerTerminalRecord {
  return terminalRecord(state.reviewer(reviewerId));
}

function gateFindingCount(state: ReviewerState): number {
  if (state.result === undefined) return 0;
  const policy = state.reviewer.policy;
  return state.result.actionable_findings.filter((finding) => {
    if (finding.severity === "low") return false;
    if ("classification" in finding && finding.classification === "advisory")
      return false;
    if (policy === undefined) return true;
    return meetsGateThresholds(
      {
        severity: finding.severity,
        confidence:
          "confidence" in finding &&
          (finding.confidence === "high" ||
            finding.confidence === "medium" ||
            finding.confidence === "low")
            ? finding.confidence
            : "medium",
      },
      {
        minimumSeverity: policy.gateMinimumSeverity,
        minimumConfidence: policy.gateMinimumConfidence,
      },
    );
  }).length;
}

export function summarizeLogicalLenses(state: SuiteState): LogicalLensSummary {
  const reviewers = state.reviewers;
  const groups = new Map<string, ReviewerState[]>();
  for (const reviewer of reviewers) {
    const id = lensId(reviewer.reviewer);
    const group = groups.get(id) ?? [];
    group.push(reviewer);
    groups.set(id, group);
  }
  const summary: LogicalLensSummary = {
    total: groups.size,
    pending: 0,
    findings: 0,
    passed: 0,
    incomplete: 0,
    not_applicable: 0,
    not_evaluated: 0,
    not_selected: 0,
  };
  for (const group of groups.values()) {
    const completed = group.filter((item) => item.status === "completed");
    const adjudicatedSources = new Set(
      completed.flatMap((item) =>
        item.reviewer.policy?.mode === "adjudication" &&
        item.reviewer.policy.adjudicatesReviewerId !== undefined
          ? [item.reviewer.policy.adjudicatesReviewerId]
          : [],
      ),
    );
    const gateFindings = completed
      .filter(
        (item) =>
          !adjudicatedSources.has(item.reviewer.id) ||
          item.reviewer.policy?.mode === "adjudication",
      )
      .reduce((total, item) => total + gateFindingCount(item), 0);
    const requiresAdjudication = completed.some(
      (item) =>
        item.reviewer.policy?.adjudication === "required" &&
        item.reviewer.policy?.mode !== "adjudication" &&
        gateFindingCount(item) > 0,
    );
    const hasAdjudicator = completed.some(
      (item) => item.reviewer.policy?.mode === "adjudication",
    );
    if (gateFindings > 0) {
      summary.findings += 1;
      if (requiresAdjudication && !hasAdjudicator) summary.incomplete += 1;
    } else if (group.every((item) => item.skipReason === "not_applicable")) {
      summary.not_applicable += 1;
    } else if (
      group.every((item) => item.skipReason === "not_selected_for_retry")
    ) {
      summary.not_selected = (summary.not_selected ?? 0) + 1;
    } else if (
      group.every((item) => item.skipReason === "not_evaluated_missing_input")
    ) {
      summary.not_evaluated += 1;
    } else if (
      group.some(
        (item) =>
          item.status !== "completed" &&
          item.status !== "incomplete" &&
          item.status !== "skipped",
      )
    ) {
      summary.pending += 1;
    } else {
      const policy = group[0]?.reviewer.policy;
      const passQuorum = policy?.passQuorum ?? group.length;
      const minimumProviderGroups = policy?.minimumProviderGroups ?? 1;
      const clean = completed.filter(
        (item) =>
          item.reviewer.policy?.mode !== "adjudication" &&
          item.result?.actionable_findings.length === 0,
      );
      const rejectedByAdjudication = completed.some(
        (item) =>
          item.reviewer.policy?.mode === "adjudication" &&
          item.result?.actionable_findings.length === 0,
      );
      const providers = new Set(
        clean.map((item) => providerGroup(item.reviewer)),
      );
      if (clean.length >= passQuorum && providers.size >= minimumProviderGroups)
        summary.passed += 1;
      else if (rejectedByAdjudication && gateFindings === 0)
        summary.passed += 1;
      else summary.incomplete += 1;
    }
  }
  return summary;
}

export function analyzeLogicalLenses(state: SuiteState): LogicalLensAnalysis {
  const aggregate = aggregateRun(state);
  return {
    summary: aggregate.logicalLenses,
    incompleteLenses: aggregate.incompleteLenses,
    notEvaluatedLenses: aggregate.notEvaluatedLenses,
    uniqueFindings: aggregate.uniqueFindings,
    advisoryFindings: aggregate.advisoryFindings,
  };
}

export function aggregateRun(state: SuiteState): RunAggregate {
  const reviewers = state.reviewers;
  const groups = new Map<string, ReviewerState[]>();
  for (const reviewer of reviewers) {
    const id = lensId(reviewer.reviewer);
    const group = groups.get(id) ?? [];
    group.push(reviewer);
    groups.set(id, group);
  }
  const logical: LogicalLensSummary = {
    total: groups.size,
    pending: 0,
    findings: 0,
    passed: 0,
    incomplete: 0,
    not_applicable: 0,
    not_evaluated: 0,
    not_selected: 0,
  };
  const incompleteLenses: string[] = [];
  const notEvaluatedLenses: string[] = [];
  const uniqueFindingKeys = new Set<string>();
  let advisoryFindings = 0;
  for (const [id, group] of groups) {
    const completed = group.filter((item) => item.status === "completed");
    const adjudicatedSources = new Set(
      completed.flatMap((item) =>
        item.reviewer.policy?.mode === "adjudication" &&
        item.reviewer.policy.adjudicatesReviewerId !== undefined
          ? [item.reviewer.policy.adjudicatesReviewerId]
          : [],
      ),
    );
    const effectiveCompleted = completed.filter(
      (item) =>
        !adjudicatedSources.has(item.reviewer.id) ||
        item.reviewer.policy?.mode === "adjudication",
    );
    const gateFindings = effectiveCompleted.reduce(
      (total, item) => total + gateFindingCount(item),
      0,
    );
    const requiredSourceFindings = completed.filter(
      (item) =>
        item.reviewer.policy?.adjudication === "required" &&
        item.reviewer.policy?.mode !== "adjudication" &&
        gateFindingCount(item) > 0,
    );
    const adjudicatedSourceIds = new Set(
      completed.flatMap((item) =>
        item.reviewer.policy?.mode === "adjudication" &&
        item.reviewer.policy.adjudicatesReviewerId !== undefined
          ? [item.reviewer.policy.adjudicatesReviewerId]
          : [],
      ),
    );
    const unadjudicatedRequired = requiredSourceFindings.some(
      (item) => !adjudicatedSourceIds.has(item.reviewer.id),
    );
    for (const item of effectiveCompleted) {
      const policy = item.reviewer.policy;
      for (const finding of item.result?.actionable_findings ?? []) {
        const confidence =
          "confidence" in finding &&
          (finding.confidence === "high" ||
            finding.confidence === "medium" ||
            finding.confidence === "low")
            ? finding.confidence
            : "medium";
        if (
          finding.severity === "low" ||
          ("classification" in finding &&
            finding.classification === "advisory") ||
          (policy !== undefined &&
            !meetsGateThresholds(
              { severity: finding.severity, confidence },
              {
                minimumSeverity: policy.gateMinimumSeverity,
                minimumConfidence: policy.gateMinimumConfidence,
              },
            ))
        )
          continue;
        const rootIssueId =
          "root_issue_id" in finding ? finding.root_issue_id : undefined;
        uniqueFindingKeys.add(
          typeof rootIssueId === "string" && rootIssueId.length > 0
            ? rootIssueId
            : `${finding.title.toLocaleLowerCase()}\u0000${finding.description.toLocaleLowerCase()}`,
        );
      }
    }
    advisoryFindings += effectiveCompleted.reduce(
      (total, item) =>
        total +
        (item.result?.actionable_findings.length ?? 0) -
        gateFindingCount(item),
      0,
    );
    if (gateFindings > 0) {
      logical.findings += 1;
      if (unadjudicatedRequired) {
        logical.incomplete += 1;
        incompleteLenses.push(id);
      }
      continue;
    }
    if (group.every((item) => item.skipReason === "not_applicable")) {
      logical.not_applicable += 1;
      continue;
    }
    if (
      group.every((item) => item.skipReason === "not_evaluated_missing_input")
    ) {
      logical.not_evaluated += 1;
      notEvaluatedLenses.push(id);
      continue;
    }
    const policy = group[0]?.reviewer.policy;
    const passQuorum = policy?.passQuorum ?? group.length;
    const minimumProviderGroups = policy?.minimumProviderGroups ?? 1;
    const clean = completed.filter(
      (item) =>
        item.reviewer.policy?.mode !== "adjudication" &&
        item.result?.actionable_findings.length === 0,
    );
    const rejectedByAdjudication = completed.some(
      (item) =>
        item.reviewer.policy?.mode === "adjudication" &&
        item.result?.actionable_findings.length === 0,
    );
    const providerGroups = new Set(
      clean.map((item) => providerGroup(item.reviewer)),
    );
    if (
      clean.length >= passQuorum &&
      providerGroups.size >= minimumProviderGroups
    ) {
      logical.passed += 1;
      continue;
    }
    if (rejectedByAdjudication && gateFindings === 0) {
      logical.passed += 1;
      continue;
    }
    if (
      group.every(
        (item) =>
          item.status === "skipped" &&
          item.skipReason === "not_selected_for_retry",
      )
    ) {
      logical.not_selected = (logical.not_selected ?? 0) + 1;
    } else if (
      group.every((item) =>
        ["completed", "incomplete", "skipped"].includes(item.status),
      )
    ) {
      logical.incomplete += 1;
      incompleteLenses.push(id);
    } else logical.pending += 1;
  }
  const gateOutcome: GateOutcome =
    logical.findings > 0 ? "findings" : "no_findings";
  const coverageOutcome: CoverageOutcome =
    logical.incomplete > 0 || logical.not_evaluated > 0
      ? "partial"
      : "complete";
  const status: RunStatus =
    coverageOutcome === "partial"
      ? "incomplete"
      : gateOutcome === "findings"
        ? "findings"
        : "passed";
  return {
    status,
    gateOutcome,
    coverageOutcome,
    logicalLenses: logical,
    modelRuns: summarizeSuite(state),
    incompleteLenses,
    notEvaluatedLenses,
    reviewers: reviewers.map(terminalRecord),
    uniqueFindings: uniqueFindingKeys.size,
    advisoryFindings,
  };
}

export function exitCodeFor(
  statusOrGate: RunStatus | GateOutcome,
  interruptedOrCoverage: boolean | CoverageOutcome,
): 0 | 1 | 3 | 4 {
  if (typeof interruptedOrCoverage === "boolean") {
    if (interruptedOrCoverage) return 4;
    return statusOrGate === "passed" || statusOrGate === "no_findings"
      ? 0
      : statusOrGate === "findings"
        ? 1
        : 3;
  }
  if (interruptedOrCoverage === "partial") return 3;
  return statusOrGate === "findings" ? 1 : 0;
}
