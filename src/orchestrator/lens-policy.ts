/**
 * Deterministic policy primitives for one logical review lens.
 *
 * This module deliberately depends on neither configuration nor public protocol
 * schemas. Config resolution can translate a versioned document into these
 * internal types, while the orchestrator can evaluate them without inference or
 * provider calls.
 */

export type ReviewScopeMode = "changes" | "full";

export type FindingSeverity = "critical" | "high" | "medium" | "low";
export type FindingConfidence = "high" | "medium" | "low";

export interface AlwaysApplicabilityPolicy {
  mode: "always";
}

export interface ChangedPathApplicabilityPolicy {
  mode: "changed_paths";
  /**
   * The lens applies when at least one changed workspace-relative path matches
   * at least one pattern. Full-scope reviews bypass this filter.
   */
  anyChangedPaths: readonly string[];
  /** Git path matching is case-sensitive unless trusted policy opts out. */
  caseSensitive?: boolean;
}

export type LensApplicabilityPolicy =
  AlwaysApplicabilityPolicy | ChangedPathApplicabilityPolicy;

export interface PassQuorumPolicy {
  /** Number of independently completed clean model runs required for a pass. */
  passQuorum: number;
  /** Minimum distinct provider groups represented by those clean runs. */
  minimumProviderGroups: number;
}

export interface GateThresholds {
  minimumSeverity: FindingSeverity;
  minimumConfidence: FindingConfidence;
}

export interface LensPolicy {
  applicability: LensApplicabilityPolicy;
  /**
   * Each entry is either a safe top-level caller-context key or an RFC 6901
   * JSON Pointer such as /pull_request/number.
   */
  requiredCallerContext: readonly string[];
  pass: PassQuorumPolicy;
  gate: GateThresholds;
}

export interface LensPolicyEvaluationInput {
  reviewScopeMode: ReviewScopeMode;
  changedPaths: readonly string[];
  callerContext?: unknown;
}

export type LensPolicyEvaluation =
  | {
      status: "applicable";
      matchedChangedPath?: string;
      matchedPattern?: string;
    }
  | {
      status: "not_applicable";
      reason: "no_changed_path_match";
    }
  | {
      status: "not_evaluated_missing_input";
      reason: "missing_required_caller_context";
      missingCallerContext: string[];
      matchedChangedPath?: string;
      matchedPattern?: string;
    };

export interface CleanModelPass {
  providerGroup: string;
}

export interface PassQuorumProgress {
  cleanPasses: number;
  distinctProviderGroups: number;
  satisfied: boolean;
  remainingPasses: number;
  remainingProviderGroups: number;
}

export const DEFAULT_PASS_QUORUM_POLICY: Readonly<PassQuorumPolicy> = {
  passQuorum: 2,
  minimumProviderGroups: 2,
};

export const DEFAULT_GATE_THRESHOLDS: Readonly<GateThresholds> = {
  minimumSeverity: "medium",
  minimumConfidence: "medium",
};

const MAX_GLOB_LENGTH = 4_096;
const MAX_GLOB_PATTERNS = 256;
const MAX_CONTEXT_REQUIREMENTS = 256;
const MAX_CONTEXT_REQUIREMENT_LENGTH = 1_024;
const MAX_QUORUM = 256;
const SAFE_CONTEXT_KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const SAFE_PROVIDER_GROUP = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const DRIVE_PREFIX = /^[A-Za-z]:/u;
const UNSUPPORTED_GLOB_SYNTAX = /[\\[\]{}!]/u;

interface CompiledGlob {
  source: string;
  segments: string[];
  caseSensitive: boolean;
}

function isControlCharacter(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

function validateRelativePathParts(
  value: string,
  label: "changed path" | "changed-path glob",
): string[] {
  if (value.length === 0 || value.length > MAX_GLOB_LENGTH) {
    throw new Error(`${label} must contain 1-${MAX_GLOB_LENGTH} characters`);
  }
  if (
    value.startsWith("/") ||
    DRIVE_PREFIX.test(value) ||
    value.includes("\\") ||
    isControlCharacter(value)
  ) {
    throw new Error(
      `${label} must be a forward-slash workspace-relative value without control characters`,
    );
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new Error(`${label} must not contain empty, '.' or '..' segments`);
  }
  return segments;
}

/** Fails closed for paths that are not literal workspace-relative Git paths. */
export function validateChangedPath(path: string): void {
  const segments = validateRelativePathParts(path, "changed path");
  if (segments.some((segment) => /[*?]/u.test(segment))) {
    throw new Error("changed path must be literal and contain no glob syntax");
  }
}

/**
 * Validates the intentionally small glob language supported by Review Mesh:
 * `*` and `?` within one segment, plus `**` as a complete path segment.
 */
export function validateChangedPathGlob(pattern: string): void {
  const segments = validateRelativePathParts(pattern, "changed-path glob");
  if (UNSUPPORTED_GLOB_SYNTAX.test(pattern)) {
    throw new Error(
      "changed-path glob supports only literal characters, '*', '?', and complete '**' segments",
    );
  }
  for (const segment of segments) {
    if (segment.includes("**") && segment !== "**") {
      throw new Error("'**' must be a complete changed-path glob segment");
    }
  }
}

function compileChangedPathGlob(
  pattern: string,
  caseSensitive: boolean,
): CompiledGlob {
  validateChangedPathGlob(pattern);
  return { source: pattern, segments: pattern.split("/"), caseSensitive };
}

function equalCharacter(
  left: string,
  right: string,
  caseSensitive: boolean,
): boolean {
  return caseSensitive
    ? left === right
    : left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US");
}

function segmentMatches(
  pattern: string,
  value: string,
  caseSensitive: boolean,
): boolean {
  // Wildcard matching via dynamic programming avoids regex injection and
  // pathological backtracking for trusted-but-user-edited configuration.
  const valueCharacters = [...value];
  let previous = new Array<boolean>(valueCharacters.length + 1).fill(false);
  previous[0] = true;
  for (const patternCharacter of pattern) {
    const current = new Array<boolean>(valueCharacters.length + 1).fill(false);
    if (patternCharacter === "*") current[0] = previous[0]!;
    for (let index = 1; index <= valueCharacters.length; index += 1) {
      if (patternCharacter === "*") {
        current[index] = previous[index]! || current[index - 1]!;
      } else if (
        patternCharacter === "?" ||
        equalCharacter(
          patternCharacter,
          valueCharacters[index - 1]!,
          caseSensitive,
        )
      ) {
        current[index] = previous[index - 1]!;
      }
    }
    previous = current;
  }
  return previous[valueCharacters.length]!;
}

function compiledGlobMatches(compiled: CompiledGlob, path: string): boolean {
  validateChangedPath(path);
  const pathSegments = path.split("/");
  const patternCount = compiled.segments.length;
  const pathCount = pathSegments.length;
  const reachable = Array.from({ length: patternCount + 1 }, () =>
    new Array<boolean>(pathCount + 1).fill(false),
  );
  reachable[0]![0] = true;

  for (let patternIndex = 0; patternIndex < patternCount; patternIndex += 1) {
    const patternSegment = compiled.segments[patternIndex]!;
    for (let pathIndex = 0; pathIndex <= pathCount; pathIndex += 1) {
      if (!reachable[patternIndex]![pathIndex]) continue;
      if (patternSegment === "**") {
        reachable[patternIndex + 1]![pathIndex] = true;
        if (pathIndex < pathCount) {
          reachable[patternIndex]![pathIndex + 1] = true;
        }
      } else if (
        pathIndex < pathCount &&
        segmentMatches(
          patternSegment,
          pathSegments[pathIndex]!,
          compiled.caseSensitive,
        )
      ) {
        reachable[patternIndex + 1]![pathIndex + 1] = true;
      }
    }
  }
  return reachable[patternCount]![pathCount]!;
}

export function changedPathMatchesGlob(
  pattern: string,
  path: string,
  options: { caseSensitive?: boolean } = {},
): boolean {
  return compiledGlobMatches(
    compileChangedPathGlob(pattern, options.caseSensitive ?? true),
    path,
  );
}

function validateApplicabilityPolicy(policy: LensApplicabilityPolicy): void {
  if (policy.mode === "always") return;
  if (
    policy.anyChangedPaths.length === 0 ||
    policy.anyChangedPaths.length > MAX_GLOB_PATTERNS
  ) {
    throw new Error(
      `changed-path applicability requires 1-${MAX_GLOB_PATTERNS} patterns`,
    );
  }
  const seen = new Set<string>();
  for (const pattern of policy.anyChangedPaths) {
    validateChangedPathGlob(pattern);
    const key = `${policy.caseSensitive ?? true}:${pattern}`;
    if (seen.has(key)) {
      throw new Error(`duplicate changed-path glob: ${pattern}`);
    }
    seen.add(key);
  }
}

function decodePointerToken(token: string, pointer: string): string {
  if (/~(?:[^01]|$)/u.test(token)) {
    throw new Error(
      `invalid JSON Pointer escape in caller-context requirement: ${pointer}`,
    );
  }
  return token.replaceAll("~1", "/").replaceAll("~0", "~");
}

function contextSelectorTokens(selector: string): string[] {
  if (
    selector.length === 0 ||
    selector.length > MAX_CONTEXT_REQUIREMENT_LENGTH ||
    isControlCharacter(selector)
  ) {
    throw new Error(
      `caller-context requirement must contain 1-${MAX_CONTEXT_REQUIREMENT_LENGTH} non-control characters`,
    );
  }
  if (!selector.startsWith("/")) {
    if (!SAFE_CONTEXT_KEY.test(selector)) {
      throw new Error(
        `caller-context key must be a safe top-level key or JSON Pointer: ${selector}`,
      );
    }
    return [selector];
  }
  return selector
    .slice(1)
    .split("/")
    .map((token) => decodePointerToken(token, selector));
}

export function validateCallerContextRequirement(selector: string): void {
  contextSelectorTokens(selector);
}

function selectedContextValue(
  callerContext: unknown,
  selector: string,
): { found: boolean; value?: unknown } {
  let current = callerContext;
  for (const token of contextSelectorTokens(selector)) {
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(token)) return { found: false };
      const index = Number(token);
      if (!Number.isSafeInteger(index) || index >= current.length) {
        return { found: false };
      }
      current = current[index];
      continue;
    }
    if (
      typeof current !== "object" ||
      current === null ||
      !Object.hasOwn(current, token)
    ) {
      return { found: false };
    }
    current = (current as Record<string, unknown>)[token];
  }
  return current === null || current === undefined
    ? { found: false }
    : { found: true, value: current };
}

export function hasRequiredCallerContext(
  callerContext: unknown,
  selector: string,
): boolean {
  return selectedContextValue(callerContext, selector).found;
}

function validateRequiredCallerContext(
  requirements: readonly string[] | undefined,
): void {
  if (requirements === undefined) return;
  if (requirements.length > MAX_CONTEXT_REQUIREMENTS) {
    throw new Error(
      `a lens may require at most ${MAX_CONTEXT_REQUIREMENTS} caller-context values`,
    );
  }
  const seen = new Set<string>();
  for (const selector of requirements) {
    validateCallerContextRequirement(selector);
    if (seen.has(selector)) {
      throw new Error(`duplicate caller-context requirement: ${selector}`);
    }
    seen.add(selector);
  }
}

export function validateProviderGroup(providerGroup: string): void {
  if (!SAFE_PROVIDER_GROUP.test(providerGroup)) {
    throw new Error(
      "provider group must contain 1-128 letters, numbers, dots, underscores, or hyphens",
    );
  }
}

export function validatePassQuorumPolicy(policy: PassQuorumPolicy): void {
  if (
    !Number.isSafeInteger(policy.passQuorum) ||
    policy.passQuorum < 1 ||
    policy.passQuorum > MAX_QUORUM
  ) {
    throw new Error(`pass quorum must be an integer from 1 to ${MAX_QUORUM}`);
  }
  if (
    !Number.isSafeInteger(policy.minimumProviderGroups) ||
    policy.minimumProviderGroups < 1 ||
    policy.minimumProviderGroups > policy.passQuorum
  ) {
    throw new Error(
      "minimum provider groups must be a positive integer no greater than pass quorum",
    );
  }
}

/** Validates that an eligible model roster can possibly satisfy the policy. */
export function validatePassQuorumFeasibility(
  policy: PassQuorumPolicy,
  eligibleProviderGroups: readonly string[],
): void {
  validatePassQuorumPolicy(policy);
  for (const providerGroup of eligibleProviderGroups) {
    validateProviderGroup(providerGroup);
  }
  if (eligibleProviderGroups.length < policy.passQuorum) {
    throw new Error(
      `pass quorum ${policy.passQuorum} exceeds ${eligibleProviderGroups.length} eligible model runs`,
    );
  }
  const distinct = new Set(eligibleProviderGroups).size;
  if (distinct < policy.minimumProviderGroups) {
    throw new Error(
      `minimum provider groups ${policy.minimumProviderGroups} exceeds ${distinct} eligible groups`,
    );
  }
}

/**
 * Returns the number of arbitrary provider-group outages the roster can
 * tolerate while still being capable of satisfying the configured quorum.
 */
export function providerOutageTolerance(
  policy: PassQuorumPolicy,
  eligibleProviderGroups: readonly string[],
): number {
  validatePassQuorumPolicy(policy);
  for (const providerGroup of eligibleProviderGroups) {
    validateProviderGroup(providerGroup);
  }
  if (
    eligibleProviderGroups.length < policy.passQuorum ||
    new Set(eligibleProviderGroups).size < policy.minimumProviderGroups
  ) {
    return 0;
  }
  const counts = new Map<string, number>();
  for (const providerGroup of eligibleProviderGroups) {
    counts.set(providerGroup, (counts.get(providerGroup) ?? 0) + 1);
  }
  const largestGroupsFirst = [...counts.values()].sort(
    (left, right) => right - left,
  );
  let remainingRuns = eligibleProviderGroups.length;
  let tolerance = 0;
  for (const groupRunCount of largestGroupsFirst) {
    const remainingGroups = counts.size - tolerance - 1;
    if (
      remainingRuns - groupRunCount < policy.passQuorum ||
      remainingGroups < policy.minimumProviderGroups
    ) {
      break;
    }
    remainingRuns -= groupRunCount;
    tolerance += 1;
  }
  return tolerance;
}

export function evaluatePassQuorum(
  policy: PassQuorumPolicy,
  cleanPasses: readonly CleanModelPass[],
): PassQuorumProgress {
  validatePassQuorumPolicy(policy);
  const providerGroups = new Set<string>();
  for (const pass of cleanPasses) {
    validateProviderGroup(pass.providerGroup);
    providerGroups.add(pass.providerGroup);
  }
  return {
    cleanPasses: cleanPasses.length,
    distinctProviderGroups: providerGroups.size,
    satisfied:
      cleanPasses.length >= policy.passQuorum &&
      providerGroups.size >= policy.minimumProviderGroups,
    remainingPasses: Math.max(0, policy.passQuorum - cleanPasses.length),
    remainingProviderGroups: Math.max(
      0,
      policy.minimumProviderGroups - providerGroups.size,
    ),
  };
}

const SEVERITY_RANK: Readonly<Record<FindingSeverity, number>> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

const CONFIDENCE_RANK: Readonly<Record<FindingConfidence, number>> = {
  low: 0,
  medium: 1,
  high: 2,
};

export function compareFindingSeverity(
  left: FindingSeverity,
  right: FindingSeverity,
): number {
  return SEVERITY_RANK[left] - SEVERITY_RANK[right];
}

export function compareFindingConfidence(
  left: FindingConfidence,
  right: FindingConfidence,
): number {
  return CONFIDENCE_RANK[left] - CONFIDENCE_RANK[right];
}

export function highestFindingSeverity(
  severities: readonly FindingSeverity[],
): FindingSeverity | undefined {
  return severities.reduce<FindingSeverity | undefined>(
    (highest, severity) =>
      highest === undefined || compareFindingSeverity(severity, highest) > 0
        ? severity
        : highest,
    undefined,
  );
}

export function highestFindingConfidence(
  confidences: readonly FindingConfidence[],
): FindingConfidence | undefined {
  return confidences.reduce<FindingConfidence | undefined>(
    (highest, confidence) =>
      highest === undefined || compareFindingConfidence(confidence, highest) > 0
        ? confidence
        : highest,
    undefined,
  );
}

export function meetsGateThresholds(
  finding: { severity: FindingSeverity; confidence: FindingConfidence },
  thresholds: GateThresholds,
): boolean {
  return (
    compareFindingSeverity(finding.severity, thresholds.minimumSeverity) >= 0 &&
    compareFindingConfidence(
      finding.confidence,
      thresholds.minimumConfidence,
    ) >= 0
  );
}

export function validateLensPolicy(policy: LensPolicy): void {
  validateApplicabilityPolicy(policy.applicability);
  validateRequiredCallerContext(policy.requiredCallerContext);
  validatePassQuorumPolicy(policy.pass);
  // Index access intentionally validates enum-like runtime input as well as
  // compile-time callers crossing a JSON/config boundary.
  if (SEVERITY_RANK[policy.gate.minimumSeverity] === undefined) {
    throw new Error("invalid minimum gate severity");
  }
  if (CONFIDENCE_RANK[policy.gate.minimumConfidence] === undefined) {
    throw new Error("invalid minimum gate confidence");
  }
}

/**
 * Evaluates cheap changed-surface applicability first. Missing caller inputs are
 * considered only for a lens that actually applies to the requested surface.
 */
export function evaluateLensPolicy(
  policy: LensPolicy,
  input: LensPolicyEvaluationInput,
): LensPolicyEvaluation {
  validateLensPolicy(policy);
  let matched:
    { matchedChangedPath: string; matchedPattern: string } | undefined;

  if (
    input.reviewScopeMode === "changes" &&
    policy.applicability.mode === "changed_paths"
  ) {
    const caseSensitive = policy.applicability.caseSensitive ?? true;
    const patterns = policy.applicability.anyChangedPaths.map((pattern) =>
      compileChangedPathGlob(pattern, caseSensitive),
    );
    // Validate the complete externally assembled path list before accepting a
    // match; an early valid entry must not hide a later unsafe entry.
    for (const path of input.changedPaths) validateChangedPath(path);
    for (const path of input.changedPaths) {
      const pattern = patterns.find((candidate) =>
        compiledGlobMatches(candidate, path),
      );
      if (pattern !== undefined) {
        matched = {
          matchedChangedPath: path,
          matchedPattern: pattern.source,
        };
        break;
      }
    }
    if (matched === undefined) {
      return {
        status: "not_applicable",
        reason: "no_changed_path_match",
      };
    }
  }

  const missing = policy.requiredCallerContext.filter(
    (selector) => !hasRequiredCallerContext(input.callerContext, selector),
  );
  if (missing.length > 0) {
    return {
      status: "not_evaluated_missing_input",
      reason: "missing_required_caller_context",
      missingCallerContext: missing,
      ...(matched ?? {}),
    };
  }
  return { status: "applicable", ...(matched ?? {}) };
}
