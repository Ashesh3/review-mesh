import { createHash } from "node:crypto";
import type { ReviewerResultV4 } from "../protocol/v9.js";

export type CanonicalFindingSeverity = "critical" | "high" | "medium" | "low";
export type CanonicalFindingConfidence = "high" | "medium" | "low";
export type CanonicalFindingClassification =
  "confirmed_defect" | "needs_verification" | "advisory";
export type CanonicalAdjudicationDisposition =
  | "unadjudicated"
  | "confirmed"
  | "adjusted"
  | "rejected"
  | "needs_verification";
export type CanonicalGateEligibilityReason =
  | "classification_not_confirmed"
  | "severity_below_threshold"
  | "confidence_below_threshold"
  | "adjudication_required"
  | "adjudication_rejected"
  | "evidence_unverified"
  | "ordered_proof_missing"
  | "change_impact_unverified"
  | "source_coverage_unverified"
  | "out_of_scope"
  | "policy_non_gating";

export interface CanonicalFindingEvidence {
  path?: string;
  start_line?: number;
  end_line?: number;
  detail: string;
}
export interface CanonicalFindingSource {
  reviewer_id: string;
  finding_id: string;
}
export interface CanonicalFindingClaim {
  trigger: string;
  affected_behavior: string;
  outcome: string;
}
export interface CanonicalRawFinding {
  provenance?: "reviewer_result_v4";
  source_ref: string;
  reviewer_id: string;
  lens_id: string;
  finding_id: string;
  severity: CanonicalFindingSeverity;
  title: string;
  description: string;
  evidence: CanonicalFindingEvidence[];
  suggested_direction: string;
  confidence: CanonicalFindingConfidence;
  classification: CanonicalFindingClassification;
  external_assumptions: string[];
  source_findings: CanonicalFindingSource[];
  duplicate_finding_ids: string[];
  root_issue_id?: string;
  deduplication_key?: string;
  duplicate_of?: string;
  confirmed_duplicate_of?: string;
  gate_eligible?: boolean;
  adjudication?: CanonicalAdjudicationDisposition;
  category?: string;
  verification?: string;
  change_impact?: string;
  claim?: CanonicalFindingClaim;
  effective_finding?: {
    severity: CanonicalFindingSeverity;
    title: string;
    description: string;
    evidence: CanonicalFindingEvidence[];
    suggested_direction: string;
    confidence: CanonicalFindingConfidence;
    classification: CanonicalFindingClassification;
    root_issue_id?: string;
    external_assumptions: string[];
    category?: string;
    verification?: string;
    change_impact?: string;
    claim?: CanonicalFindingClaim;
  };
}
export interface CanonicalFindingCoreProof {
  evidence_verified?: boolean;
  source_coverage_verified?: boolean;
  ordered_proof_required?: boolean;
  ordered_proof_verified?: boolean;
  change_impact_required?: boolean;
  change_impact_verified?: boolean;
  adjudication_required?: boolean;
  out_of_scope?: boolean;
  policy_non_gating?: boolean;
  unrelated_coverage_deficits?: readonly string[];
}
export interface CanonicalGateEligibility {
  eligible: boolean;
  reasons: CanonicalGateEligibilityReason[];
}
export interface CanonicalSourceEligibility extends CanonicalGateEligibility {
  source_ref: string;
}
export interface CanonicalFindingDiagnostic {
  code: "conflicting_duplicate_claim";
  source_ref: string;
  target_source_ref: string;
}
export interface CanonicalAtomicFinding {
  id: string;
  signature_id: string;
  signature: string;
  severity: CanonicalFindingSeverity;
  title: string;
  description: string;
  descriptions: string[];
  evidence: CanonicalFindingEvidence[];
  suggested_direction: string;
  suggested_directions: string[];
  confidence: CanonicalFindingConfidence;
  classification: CanonicalFindingClassification;
  external_assumptions: string[];
  source_findings: CanonicalFindingSource[];
  source_refs: string[];
  duplicate_finding_ids: string[];
  root_issue_ids: string[];
  category: string;
  verification?: string;
  change_impact?: string;
  claim: CanonicalFindingClaim;
  gate_eligibility: CanonicalGateEligibility;
  source_gate_eligibility: CanonicalSourceEligibility[];
  diagnostics: CanonicalFindingDiagnostic[];
  gate_eligible: boolean;
}
export type CanonicalConsolidatedFinding = CanonicalAtomicFinding;
export interface CanonicalRootFinding {
  id: string;
  subfindings: CanonicalAtomicFinding[];
}
export interface CanonicalSemanticProposal {
  relation: "semantic_proposal";
  atomic_ids: [string, string];
  scores: { trigger: number; affected_behavior: number; outcome: number };
  existing_root_id?: string;
}
export interface CanonicalFindingCounts {
  raw_source_findings: number;
  atomic_subfindings: number;
  canonical_roots: number;
  gate_eligible_subfindings: number;
  advisory_subfindings: number;
  rejected_subfindings: number;
  needs_verification_subfindings: number;
  out_of_scope_subfindings: number;
  policy_non_gating_subfindings: number;
  non_gating_subfindings: number;
  raw: number;
  unique: number;
  gate: number;
  advisory: number;
}
export interface CanonicalFindingSet {
  raw: CanonicalRawFinding[];
  atomics: CanonicalAtomicFinding[];
  roots: CanonicalRootFinding[];
  semantic_proposals: CanonicalSemanticProposal[];
  consolidated: CanonicalConsolidatedFinding[];
  gate_effective: CanonicalConsolidatedFinding[];
  advisory: CanonicalConsolidatedFinding[];
  counts: CanonicalFindingCounts;
}
export interface CanonicalGatePolicy {
  minimumSeverity: CanonicalFindingSeverity;
  minimumConfidence: CanonicalFindingConfidence;
}
export interface CanonicalizeFindingsOptions {
  gatePolicies?: Readonly<Record<string, CanonicalGatePolicy>>;
  proofBySourceRef?: Readonly<Record<string, CanonicalFindingCoreProof>>;
}
export interface BuildCanonicalRawFindingsInput {
  reviewer_id: string;
  lens_id: string;
  result: ReviewerResultV4;
  adjudication?: CanonicalAdjudicationDisposition;
}
export interface CanonicalAdjudicationCandidate {
  candidate_id: string;
  atomic_id: string;
  source_refs: string[];
  source_findings: CanonicalFindingSource[];
  finding: CanonicalAtomicFinding;
}
export interface CanonicalAdjudicationCandidateSet {
  candidates: CanonicalAdjudicationCandidate[];
  source_to_candidate: Record<string, string>;
}
export class CanonicalCandidateLimitError extends Error {
  readonly candidate_count: number;
  constructor(candidateCount: number) {
    super(
      `Canonical adjudication candidates exceed the 256-candidate limit: ${candidateCount}`,
    );
    this.name = "CanonicalCandidateLimitError";
    this.candidate_count = candidateCount;
  }
}

const severityRank: Record<CanonicalFindingSeverity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};
const confidenceRank: Record<CanonicalFindingConfidence, number> = {
  low: 0,
  medium: 1,
  high: 2,
};
const orderedProofCategories = new Set([
  "reliability",
  "concurrency",
  "lifecycle",
  "cleanup",
]);
const gateReasonOrder: readonly CanonicalGateEligibilityReason[] = [
  "classification_not_confirmed",
  "severity_below_threshold",
  "confidence_below_threshold",
  "adjudication_required",
  "adjudication_rejected",
  "evidence_unverified",
  "ordered_proof_missing",
  "change_impact_unverified",
  "source_coverage_unverified",
  "out_of_scope",
  "policy_non_gating",
];

function compareCodepoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function normalizedText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}
function normalizedPath(value: string): string {
  return value
    .normalize("NFC")
    .replace(/\\/gu, "/")
    .replace(/^\.\//u, "")
    .replace(/\/{2,}/gu, "/");
}
function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCodepoint);
}
function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
function evidenceKey(value: CanonicalFindingEvidence): string {
  return JSON.stringify([
    value.path === undefined ? null : normalizedPath(value.path),
    value.start_line ?? null,
    value.end_line ?? null,
    value.detail.normalize("NFC"),
  ]);
}
function uniqueEvidence(
  values: readonly CanonicalFindingEvidence[],
): CanonicalFindingEvidence[] {
  const unique = new Map<string, CanonicalFindingEvidence>();
  for (const value of values) {
    const normalized = structuredClone(value);
    if (normalized.path !== undefined)
      normalized.path = normalizedPath(normalized.path);
    unique.set(evidenceKey(normalized), normalized);
  }
  return [...unique.entries()]
    .sort(([left], [right]) => compareCodepoint(left, right))
    .map(([, value]) => value);
}
function sourceKey(value: CanonicalFindingSource): string {
  return `${value.reviewer_id}\u0000${value.finding_id}`;
}
function uniqueSources(
  values: readonly CanonicalFindingSource[],
): CanonicalFindingSource[] {
  const unique = new Map<string, CanonicalFindingSource>();
  for (const value of values)
    unique.set(sourceKey(value), structuredClone(value));
  return [...unique.entries()]
    .sort(([left], [right]) => compareCodepoint(left, right))
    .map(([, value]) => value);
}
function compareRaw(
  left: Pick<
    CanonicalRawFinding,
    "lens_id" | "reviewer_id" | "finding_id" | "title"
  >,
  right: Pick<
    CanonicalRawFinding,
    "lens_id" | "reviewer_id" | "finding_id" | "title"
  >,
): number {
  return (
    compareCodepoint(left.lens_id, right.lens_id) ||
    compareCodepoint(left.reviewer_id, right.reviewer_id) ||
    compareCodepoint(left.finding_id, right.finding_id) ||
    compareCodepoint(left.title, right.title)
  );
}
function compareCanonicalCandidates(
  left: CanonicalRawFinding,
  right: CanonicalRawFinding,
): number {
  return (
    severityRank[right.severity] - severityRank[left.severity] ||
    confidenceRank[right.confidence] - confidenceRank[left.confidence] ||
    (left.classification === "confirmed_defect" ? 0 : 1) -
      (right.classification === "confirmed_defect" ? 0 : 1) ||
    compareRaw(left, right)
  );
}
class DisjointSet {
  private readonly parents: number[];
  constructor(size: number) {
    this.parents = Array.from({ length: size }, (_, index) => index);
  }
  find(index: number): number {
    const parent = this.parents[index]!;
    if (parent === index) return index;
    const root = this.find(parent);
    this.parents[index] = root;
    return root;
  }
  union(left: number, right: number): void {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot === rightRoot) return;
    if (leftRoot < rightRoot) this.parents[rightRoot] = leftRoot;
    else this.parents[leftRoot] = rightRoot;
  }
}
interface EvidenceAnchor {
  path: string;
  start: number | null;
  end: number | null;
}
interface NormalizedAtomicInput {
  finding: CanonicalRawFinding;
  claim: CanonicalFindingClaim;
  normalizedClaim: CanonicalFindingClaim;
  category: string;
  anchors: EvidenceAnchor[];
}

function effectiveRaw(finding: CanonicalRawFinding): CanonicalRawFinding {
  if (
    finding.adjudication !== "adjusted" ||
    finding.effective_finding === undefined
  )
    return finding;
  return {
    ...finding,
    ...structuredClone(finding.effective_finding),
    finding_id: finding.finding_id,
    source_ref: finding.source_ref,
    reviewer_id: finding.reviewer_id,
    lens_id: finding.lens_id,
    source_findings: finding.source_findings,
    duplicate_finding_ids: finding.duplicate_finding_ids,
  };
}
function claimFor(finding: CanonicalRawFinding): CanonicalFindingClaim {
  return (
    finding.claim ?? {
      trigger: finding.title,
      affected_behavior: finding.description,
      outcome: finding.description,
    }
  );
}
function anchorsFor(
  evidence: readonly CanonicalFindingEvidence[],
): EvidenceAnchor[] {
  const unique = new Map<string, EvidenceAnchor>();
  for (const item of evidence) {
    if (item.path === undefined) continue;
    const anchor = {
      path: normalizedPath(item.path),
      start: item.start_line ?? null,
      end: item.end_line ?? item.start_line ?? null,
    };
    unique.set(JSON.stringify([anchor.path, anchor.start, anchor.end]), anchor);
  }
  return [...unique.entries()]
    .sort(([left], [right]) => compareCodepoint(left, right))
    .map(([, value]) => value);
}
function normalizedAtomicInput(
  finding: CanonicalRawFinding,
): NormalizedAtomicInput {
  const effective = effectiveRaw(finding);
  const claim = structuredClone(claimFor(effective));
  return {
    finding: effective,
    claim,
    normalizedClaim: {
      trigger: normalizedText(claim.trigger),
      affected_behavior: normalizedText(claim.affected_behavior),
      outcome: normalizedText(claim.outcome),
    },
    category: normalizedText(effective.category ?? "other"),
    anchors: anchorsFor(effective.evidence),
  };
}
function rangesOverlap(left: EvidenceAnchor, right: EvidenceAnchor): boolean {
  if (left.path !== right.path) return false;
  if (
    left.start === null ||
    left.end === null ||
    right.start === null ||
    right.end === null
  )
    return true;
  return left.start <= right.end && right.start <= left.end;
}
function sharesAnchor(
  left: NormalizedAtomicInput,
  right: NormalizedAtomicInput,
): boolean {
  return left.anchors.some((leftAnchor) =>
    right.anchors.some((rightAnchor) => rangesOverlap(leftAnchor, rightAnchor)),
  );
}
function sameClaim(
  left: NormalizedAtomicInput,
  right: NormalizedAtomicInput,
): boolean {
  return (
    left.category === right.category &&
    left.normalizedClaim.trigger === right.normalizedClaim.trigger &&
    left.normalizedClaim.affected_behavior ===
      right.normalizedClaim.affected_behavior &&
    left.normalizedClaim.outcome === right.normalizedClaim.outcome
  );
}
function structurallyCompatible(
  left: NormalizedAtomicInput,
  right: NormalizedAtomicInput,
): boolean {
  return sameClaim(left, right) && sharesAnchor(left, right);
}
function signatureFor(group: readonly NormalizedAtomicInput[]): string {
  const first = group[0]!;
  const anchors = new Map<string, Array<string | number | null>>();
  for (const anchor of group
    .flatMap((value) => value.anchors)
    .map(
      (value) =>
        [value.path, value.start, value.end] as Array<string | number | null>,
    )) {
    anchors.set(JSON.stringify(anchor), anchor);
  }
  const orderedAnchors = [...anchors.entries()]
    .sort(([left], [right]) => compareCodepoint(left, right))
    .map(([, value]) => value);
  return JSON.stringify({
    trigger: first.normalizedClaim.trigger,
    affected_behavior: first.normalizedClaim.affected_behavior,
    outcome: first.normalizedClaim.outcome,
    category: first.category,
    anchors: orderedAnchors,
  });
}
function eligibilityForSource(
  finding: CanonicalRawFinding,
  policy: CanonicalGatePolicy | undefined,
  proof: CanonicalFindingCoreProof | undefined,
): CanonicalSourceEligibility {
  const reasons = new Set<CanonicalGateEligibilityReason>();
  const minimumSeverity = policy?.minimumSeverity ?? "medium";
  const minimumConfidence = policy?.minimumConfidence ?? "low";
  if (finding.classification !== "confirmed_defect")
    reasons.add("classification_not_confirmed");
  if (severityRank[finding.severity] < severityRank[minimumSeverity])
    reasons.add("severity_below_threshold");
  if (confidenceRank[finding.confidence] < confidenceRank[minimumConfidence])
    reasons.add("confidence_below_threshold");
  if (
    finding.adjudication === "needs_verification" ||
    (proof?.adjudication_required === true &&
      finding.adjudication === "unadjudicated")
  )
    reasons.add("adjudication_required");
  if (finding.adjudication === "rejected") reasons.add("adjudication_rejected");
  const currentV4 = finding.provenance === "reviewer_result_v4";
  if (
    currentV4
      ? proof?.evidence_verified !== true
      : proof?.evidence_verified === false
  )
    reasons.add("evidence_unverified");
  const orderedProofRequired =
    proof?.ordered_proof_required === true ||
    (currentV4 &&
      severityRank[finding.severity] >= severityRank.medium &&
      orderedProofCategories.has(finding.category ?? "other"));
  if (orderedProofRequired && proof?.ordered_proof_verified !== true)
    reasons.add("ordered_proof_missing");
  if (
    proof?.change_impact_required === true &&
    proof.change_impact_verified !== true
  )
    reasons.add("change_impact_unverified");
  if (
    currentV4
      ? proof?.source_coverage_verified !== true
      : proof?.source_coverage_verified === false
  )
    reasons.add("source_coverage_unverified");
  if (proof?.out_of_scope === true) reasons.add("out_of_scope");
  if (proof?.policy_non_gating === true || finding.gate_eligible === false)
    reasons.add("policy_non_gating");
  const orderedReasons = gateReasonOrder.filter((reason) =>
    reasons.has(reason),
  );
  return {
    source_ref: finding.source_ref,
    eligible: orderedReasons.length === 0,
    reasons: orderedReasons,
  };
}
function classificationFor(
  findings: readonly CanonicalRawFinding[],
): CanonicalFindingClassification {
  const values = new Set(findings.map((finding) => finding.classification));
  return values.size === 1 ? findings[0]!.classification : "needs_verification";
}
function compareEligibility(
  left: CanonicalSourceEligibility,
  right: CanonicalSourceEligibility,
): number {
  return (
    Number(right.eligible) - Number(left.eligible) ||
    left.reasons.length - right.reasons.length ||
    compareCodepoint(
      left.reasons.join("\u0000"),
      right.reasons.join("\u0000"),
    ) ||
    compareCodepoint(left.source_ref, right.source_ref)
  );
}

function consolidateAtomic(
  group: readonly NormalizedAtomicInput[],
  options: CanonicalizeFindingsOptions,
  diagnostics: readonly CanonicalFindingDiagnostic[],
): CanonicalAtomicFinding {
  const orderedInputs = [...group].sort((left, right) =>
    compareCanonicalCandidates(left.finding, right.finding),
  );
  const ordered = orderedInputs.map((value) => value.finding);
  const canonical = ordered[0]!;
  const signature = signatureFor(group);
  const sourceEligibility = ordered
    .map((finding) =>
      eligibilityForSource(
        finding,
        options.gatePolicies?.[finding.lens_id],
        options.proofBySourceRef?.[finding.source_ref],
      ),
    )
    .sort(compareEligibility);
  const eligible = sourceEligibility.some((value) => value.eligible);
  const representative = sourceEligibility[0]!;
  const gateEligibility: CanonicalGateEligibility = eligible
    ? { eligible: true, reasons: [] }
    : { eligible: false, reasons: [...representative.reasons] };
  return {
    id: canonical.finding_id,
    signature_id: `atomic:${sha256(signature)}`,
    signature,
    severity: ordered.reduce<CanonicalFindingSeverity>(
      (highest, finding) =>
        severityRank[finding.severity] > severityRank[highest]
          ? finding.severity
          : highest,
      "low",
    ),
    title: canonical.title,
    description: canonical.description,
    descriptions: uniqueSorted(ordered.map((finding) => finding.description)),
    evidence: uniqueEvidence(ordered.flatMap((finding) => finding.evidence)),
    suggested_direction: canonical.suggested_direction,
    suggested_directions: uniqueSorted(
      ordered.map((finding) => finding.suggested_direction),
    ),
    confidence: ordered.reduce<CanonicalFindingConfidence>(
      (lowest, finding) =>
        confidenceRank[finding.confidence] < confidenceRank[lowest]
          ? finding.confidence
          : lowest,
      "high",
    ),
    classification: classificationFor(ordered),
    external_assumptions: uniqueSorted(
      ordered.flatMap((finding) => finding.external_assumptions),
    ),
    source_findings: uniqueSources(
      ordered.flatMap((finding) => [
        ...finding.source_findings,
        { reviewer_id: finding.reviewer_id, finding_id: finding.finding_id },
      ]),
    ),
    source_refs: uniqueSorted(ordered.map((finding) => finding.source_ref)),
    duplicate_finding_ids: uniqueSorted(
      ordered.flatMap((finding) => [
        finding.finding_id,
        ...finding.duplicate_finding_ids,
      ]),
    ).filter((findingId) => findingId !== canonical.finding_id),
    root_issue_ids: uniqueSorted(
      ordered.flatMap((finding) => {
        const root = finding.root_issue_id ?? finding.deduplication_key;
        return root === undefined ? [] : [root.normalize("NFC")];
      }),
    ),
    category: canonical.category ?? "other",
    ...(canonical.verification === undefined
      ? {}
      : { verification: canonical.verification }),
    ...(canonical.change_impact === undefined
      ? {}
      : { change_impact: canonical.change_impact }),
    claim: structuredClone(orderedInputs[0]!.claim),
    gate_eligibility: gateEligibility,
    source_gate_eligibility: sourceEligibility,
    diagnostics: diagnostics
      .filter((diagnostic) =>
        ordered.some((finding) => finding.source_ref === diagnostic.source_ref),
      )
      .map((diagnostic) => structuredClone(diagnostic))
      .sort(
        (left, right) =>
          compareCodepoint(left.source_ref, right.source_ref) ||
          compareCodepoint(left.target_source_ref, right.target_source_ref),
      ),
    gate_eligible: gateEligibility.eligible,
  };
}
function duplicateTargets(
  values: readonly NormalizedAtomicInput[],
): Map<string, number[]> {
  const targets = new Map<string, number[]>();
  for (const [index, value] of values.entries()) {
    for (const key of [value.finding.source_ref, value.finding.finding_id])
      targets.set(key, [...(targets.get(key) ?? []), index]);
  }
  return targets;
}
function explicitReferences(finding: CanonicalRawFinding): string[] {
  return uniqueSorted([
    ...(finding.duplicate_of === undefined ? [] : [finding.duplicate_of]),
    ...(finding.confirmed_duplicate_of === undefined
      ? []
      : [finding.confirmed_duplicate_of]),
    ...finding.duplicate_finding_ids,
  ]);
}
function canonicalAtomics(
  raw: readonly CanonicalRawFinding[],
  options: CanonicalizeFindingsOptions,
): CanonicalAtomicFinding[] {
  const normalized = raw.map(normalizedAtomicInput);
  const sets = new DisjointSet(normalized.length);
  const compatibleGroups: number[][] = [];
  for (const [index, value] of normalized.entries()) {
    const group = compatibleGroups.find((indices) =>
      indices.every((member) =>
        structurallyCompatible(value, normalized[member]!),
      ),
    );
    if (group === undefined) compatibleGroups.push([index]);
    else group.push(index);
  }
  for (const indices of compatibleGroups) {
    for (const index of indices.slice(1)) {
      sets.union(indices[0]!, index);
    }
  }
  const targets = duplicateTargets(normalized);
  const diagnostics: CanonicalFindingDiagnostic[] = [];
  for (const [index, value] of normalized.entries()) {
    for (const reference of explicitReferences(value.finding)) {
      const matches = targets.get(reference) ?? [];
      if (matches.length !== 1 || matches[0] === index) continue;
      const targetIndex = matches[0]!;
      const target = normalized[targetIndex]!;
      if (value.finding.confirmed_duplicate_of === reference)
        sets.union(index, targetIndex);
      else if (!structurallyCompatible(value, target))
        diagnostics.push({
          code: "conflicting_duplicate_claim",
          source_ref: value.finding.source_ref,
          target_source_ref: target.finding.source_ref,
        });
    }
  }
  const groups = new Map<number, NormalizedAtomicInput[]>();
  for (const [index, value] of normalized.entries()) {
    const root = sets.find(index);
    groups.set(root, [...(groups.get(root) ?? []), value]);
  }
  return [...groups.values()]
    .map((group) => consolidateAtomic(group, options, diagnostics))
    .sort(
      (left, right) =>
        severityRank[right.severity] - severityRank[left.severity] ||
        compareCodepoint(left.id, right.id),
    );
}
function rootsFor(
  atomics: readonly CanonicalAtomicFinding[],
): CanonicalRootFinding[] {
  const roots = new Map<string, CanonicalAtomicFinding[]>();
  for (const atomic of atomics) {
    for (const rootId of atomic.root_issue_ids)
      roots.set(rootId, [...(roots.get(rootId) ?? []), atomic]);
  }
  return [...roots.entries()]
    .sort(([left], [right]) => compareCodepoint(left, right))
    .map(([id, subfindings]) => ({
      id,
      subfindings: [...subfindings].sort((left, right) =>
        compareCodepoint(left.id, right.id),
      ),
    }));
}
function tokens(value: string): Set<string> {
  const normalized = normalizedText(value);
  return new Set(normalized === "" ? [] : normalized.split(" "));
}
function jaccard(left: string, right: string): number {
  const leftTokens = tokens(left);
  const rightTokens = tokens(right);
  const union = new Set([...leftTokens, ...rightTokens]);
  if (union.size === 0) return 1;
  let intersection = 0;
  for (const value of leftTokens) if (rightTokens.has(value)) intersection += 1;
  return intersection / union.size;
}
function atomicsShareEvidence(
  left: CanonicalAtomicFinding,
  right: CanonicalAtomicFinding,
): boolean {
  const leftAnchors = anchorsFor(left.evidence);
  const rightAnchors = anchorsFor(right.evidence);
  return leftAnchors.some((leftAnchor) =>
    rightAnchors.some((rightAnchor) => rangesOverlap(leftAnchor, rightAnchor)),
  );
}
function proposalsFor(
  atomics: readonly CanonicalAtomicFinding[],
): CanonicalSemanticProposal[] {
  const proposals: CanonicalSemanticProposal[] = [];
  for (let leftIndex = 0; leftIndex < atomics.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < atomics.length;
      rightIndex += 1
    ) {
      const left = atomics[leftIndex]!;
      const right = atomics[rightIndex]!;
      if (
        left.root_issue_ids.some((rootId) =>
          right.root_issue_ids.includes(rootId),
        ) ||
        normalizedText(left.category) !== normalizedText(right.category) ||
        !atomicsShareEvidence(left, right)
      )
        continue;
      const scores = {
        trigger: jaccard(left.claim.trigger, right.claim.trigger),
        affected_behavior: jaccard(
          left.claim.affected_behavior,
          right.claim.affected_behavior,
        ),
        outcome: jaccard(left.claim.outcome, right.claim.outcome),
      };
      const values = Object.values(scores);
      if (!(
        values.filter((value) => value >= 0.75).length >= 2 ||
        values.every((value) => value >= 0.85)
      ))
        continue;
      const atomicIds = [left.signature_id, right.signature_id].sort(
        compareCodepoint,
      ) as [string, string];
      const existingRootId = uniqueSorted([
        ...left.root_issue_ids,
        ...right.root_issue_ids,
      ])[0];
      proposals.push({
        relation: "semantic_proposal",
        atomic_ids: atomicIds,
        scores,
        ...(existingRootId === undefined
          ? {}
          : { existing_root_id: existingRootId }),
      });
    }
  }
  return proposals.sort(
    (left, right) =>
      compareCodepoint(left.atomic_ids[0], right.atomic_ids[0]) ||
      compareCodepoint(left.atomic_ids[1], right.atomic_ids[1]),
  );
}
type AtomicBucket =
  | "gate"
  | "rejected"
  | "out_of_scope"
  | "advisory"
  | "needs_verification"
  | "policy_non_gating";
function bucketFor(atomic: CanonicalAtomicFinding): AtomicBucket {
  const allReasons = atomic.source_gate_eligibility.flatMap(
    (value) => value.reasons,
  );
  if (
    atomic.source_gate_eligibility.length > 0 &&
    atomic.source_gate_eligibility.every((value) =>
      value.reasons.includes("adjudication_rejected"),
    )
  )
    return "rejected";
  if (atomic.gate_eligibility.eligible) return "gate";
  if (allReasons.includes("out_of_scope")) return "out_of_scope";
  if (atomic.classification === "advisory") return "advisory";
  if (
    atomic.classification === "needs_verification" ||
    allReasons.some((reason) =>
      [
        "adjudication_required",
        "evidence_unverified",
        "ordered_proof_missing",
        "change_impact_unverified",
        "source_coverage_unverified",
      ].includes(reason),
    )
  )
    return "needs_verification";
  return "policy_non_gating";
}
function countsFor(
  raw: readonly CanonicalRawFinding[],
  atomics: readonly CanonicalAtomicFinding[],
  roots: readonly CanonicalRootFinding[],
): CanonicalFindingCounts {
  const buckets = atomics.map(bucketFor);
  const gate = buckets.filter((value) => value === "gate").length;
  const advisory = buckets.filter((value) => value === "advisory").length;
  const rejected = buckets.filter((value) => value === "rejected").length;
  const needsVerification = buckets.filter(
    (value) => value === "needs_verification",
  ).length;
  const outOfScope = buckets.filter((value) => value === "out_of_scope").length;
  const policyNonGating = buckets.filter(
    (value) => value === "policy_non_gating",
  ).length;
  const nonGating = atomics.length - gate;
  return {
    raw_source_findings: raw.length,
    atomic_subfindings: atomics.length,
    canonical_roots: roots.length,
    gate_eligible_subfindings: gate,
    advisory_subfindings: advisory,
    rejected_subfindings: rejected,
    needs_verification_subfindings: needsVerification,
    out_of_scope_subfindings: outOfScope,
    policy_non_gating_subfindings: policyNonGating,
    non_gating_subfindings: nonGating,
    raw: raw.length,
    unique: atomics.length,
    gate,
    advisory: nonGating,
  };
}

export function buildCanonicalRawFindings(
  input: BuildCanonicalRawFindingsInput,
): CanonicalRawFinding[] {
  return input.result.actionable_findings.map((finding) => ({
    provenance: "reviewer_result_v4",
    source_ref: `${input.reviewer_id}#${finding.id}`,
    reviewer_id: input.reviewer_id,
    lens_id: input.lens_id,
    finding_id: finding.id,
    severity: finding.severity,
    title: finding.title,
    description: finding.description,
    evidence: finding.evidence.map((evidence) => ({
      detail: evidence.detail,
      ...(evidence.path === undefined ? {} : { path: evidence.path }),
      ...(evidence.start_line === undefined
        ? {}
        : { start_line: evidence.start_line }),
      ...(evidence.end_line === undefined
        ? {}
        : { end_line: evidence.end_line }),
    })),
    suggested_direction: finding.suggested_direction,
    confidence: finding.confidence,
    classification: finding.classification,
    external_assumptions: structuredClone(finding.external_assumptions),
    source_findings: [
      { reviewer_id: input.reviewer_id, finding_id: finding.id },
    ],
    duplicate_finding_ids: structuredClone(finding.duplicate_finding_ids ?? []),
    ...(finding.root_issue_id === undefined
      ? {}
      : { root_issue_id: finding.root_issue_id }),
    ...(finding.duplicate_of === undefined
      ? {}
      : { duplicate_of: finding.duplicate_of }),
    adjudication: input.adjudication ?? "unadjudicated",
    category: finding.category,
    verification: finding.verification,
    ...(finding.change_impact === undefined
      ? {}
      : { change_impact: finding.change_impact }),
    claim: structuredClone(finding.claim),
  }));
}
export function buildAdjudicationCandidates(
  values: readonly CanonicalRawFinding[],
): CanonicalAdjudicationCandidateSet {
  const atomics = canonicalAtomics(
    values.map((value) => structuredClone(value)).sort(compareRaw),
    {},
  ).sort((left, right) =>
    compareCodepoint(left.signature_id, right.signature_id),
  );
  if (atomics.length > 256)
    throw new CanonicalCandidateLimitError(atomics.length);
  const candidates = atomics.map((finding) => ({
    candidate_id: `candidate:${sha256(finding.signature)}`,
    atomic_id: finding.signature_id,
    source_refs: [...finding.source_refs],
    source_findings: structuredClone(finding.source_findings),
    finding: structuredClone(finding),
  }));
  return {
    candidates,
    source_to_candidate: Object.fromEntries(
      candidates.flatMap((candidate) =>
        candidate.source_refs.map((sourceRef) => [
          sourceRef,
          candidate.candidate_id,
        ]),
      ),
    ),
  };
}
export function canonicalizeFindings(
  values: readonly CanonicalRawFinding[],
  options: CanonicalizeFindingsOptions = {},
): CanonicalFindingSet {
  const raw = values.map((value) => structuredClone(value)).sort(compareRaw);
  const atomics = canonicalAtomics(raw, options);
  const roots = rootsFor(atomics);
  const gateEffective = atomics.filter(
    (finding) => finding.gate_eligibility.eligible,
  );
  const advisory = atomics.filter(
    (finding) => !finding.gate_eligibility.eligible,
  );
  return {
    raw,
    atomics,
    roots,
    semantic_proposals: proposalsFor(atomics),
    consolidated: atomics,
    gate_effective: gateEffective,
    advisory,
    counts: countsFor(raw, atomics, roots),
  };
}
