export type CanonicalFindingSeverity = "critical" | "high" | "medium" | "low";
export type CanonicalFindingConfidence = "high" | "medium" | "low";
export type CanonicalFindingClassification =
  | "confirmed_defect"
  | "needs_verification"
  | "advisory";
export type CanonicalAdjudicationDisposition =
  | "unadjudicated"
  | "confirmed"
  | "adjusted"
  | "rejected"
  | "needs_verification";

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

export interface CanonicalRawFinding {
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
  gate_eligible?: boolean;
  adjudication?: CanonicalAdjudicationDisposition;
  category?: string;
  verification?: string;
  change_impact?: string;
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
  };
}

export interface CanonicalConsolidatedFinding {
  id: string;
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
  duplicate_finding_ids: string[];
  gate_eligible: boolean;
}

export interface CanonicalFindingSet {
  raw: CanonicalRawFinding[];
  consolidated: CanonicalConsolidatedFinding[];
  gate_effective: CanonicalConsolidatedFinding[];
  advisory: CanonicalConsolidatedFinding[];
  counts: {
    raw: number;
    unique: number;
    gate: number;
    advisory: number;
  };
}

export interface CanonicalGatePolicy {
  minimumSeverity: CanonicalFindingSeverity;
  minimumConfidence: CanonicalFindingConfidence;
}

export interface CanonicalizeFindingsOptions {
  gatePolicies?: Readonly<Record<string, CanonicalGatePolicy>>;
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

function normalizedText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function evidenceKey(value: CanonicalFindingEvidence): string {
  return JSON.stringify([
    value.path ?? null,
    value.start_line ?? null,
    value.end_line ?? null,
    value.detail,
  ]);
}

function uniqueEvidence(
  values: readonly CanonicalFindingEvidence[],
): CanonicalFindingEvidence[] {
  const unique = new Map<string, CanonicalFindingEvidence>();
  for (const value of values) unique.set(evidenceKey(value), structuredClone(value));
  return [...unique.values()].sort(
    (left, right) =>
      (left.path ?? "\uffff").localeCompare(right.path ?? "\uffff") ||
      (left.start_line ?? Number.MAX_SAFE_INTEGER) -
        (right.start_line ?? Number.MAX_SAFE_INTEGER) ||
      (left.end_line ?? Number.MAX_SAFE_INTEGER) -
        (right.end_line ?? Number.MAX_SAFE_INTEGER) ||
      left.detail.localeCompare(right.detail),
  );
}

function sourceKey(value: CanonicalFindingSource): string {
  return `${value.reviewer_id}\u0000${value.finding_id}`;
}

function uniqueSources(
  values: readonly CanonicalFindingSource[],
): CanonicalFindingSource[] {
  const unique = new Map<string, CanonicalFindingSource>();
  for (const value of values) unique.set(sourceKey(value), structuredClone(value));
  return [...unique.values()].sort(
    (left, right) =>
      left.reviewer_id.localeCompare(right.reviewer_id) ||
      left.finding_id.localeCompare(right.finding_id),
  );
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
    left.lens_id.localeCompare(right.lens_id) ||
    left.reviewer_id.localeCompare(right.reviewer_id) ||
    left.finding_id.localeCompare(right.finding_id) ||
    left.title.localeCompare(right.title)
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

function groupClassification(
  findings: readonly CanonicalRawFinding[],
): CanonicalFindingClassification {
  const values = new Set(findings.map((finding) => finding.classification));
  return values.size === 1 ? findings[0]!.classification : "needs_verification";
}

function consolidateGroup(
  group: readonly CanonicalRawFinding[],
): CanonicalConsolidatedFinding {
  const ordered = [...group].sort(compareCanonicalCandidates);
  const canonical = ordered[0]!;
  const sourceFindings = uniqueSources(
    ordered.flatMap((finding) => finding.source_findings),
  );
  const sourceIds = uniqueSorted(
    ordered.flatMap((finding) => [
      finding.finding_id,
      ...finding.duplicate_finding_ids,
    ]),
  );
  const descriptions = uniqueSorted(ordered.map((finding) => finding.description));
  const directions = uniqueSorted(
    ordered.map((finding) => finding.suggested_direction),
  );
  return {
    id: canonical.finding_id,
    severity: ordered.reduce<CanonicalFindingSeverity>(
      (highest, finding) =>
        severityRank[finding.severity] > severityRank[highest]
          ? finding.severity
          : highest,
      "low",
    ),
    title: canonical.title,
    description: canonical.description,
    descriptions,
    evidence: uniqueEvidence(ordered.flatMap((finding) => finding.evidence)),
    suggested_direction: canonical.suggested_direction,
    suggested_directions: directions,
    confidence: ordered.reduce<CanonicalFindingConfidence>(
      (lowest, finding) =>
        confidenceRank[finding.confidence] < confidenceRank[lowest]
          ? finding.confidence
          : lowest,
      "high",
    ),
    classification: groupClassification(ordered),
    external_assumptions: uniqueSorted(
      ordered.flatMap((finding) => finding.external_assumptions),
    ),
    source_findings: sourceFindings,
    duplicate_finding_ids: sourceIds.filter(
      (findingId) => findingId !== canonical.finding_id,
    ),
    gate_eligible: ordered.some(gateEligible),
  };
}

function gateEligible(finding: CanonicalRawFinding): boolean {
  return (
    finding.gate_eligible ??
    (finding.severity !== "low" &&
      finding.classification === "confirmed_defect")
  );
}

function thresholdEligible(
  finding: CanonicalRawFinding,
  policy: CanonicalGatePolicy | undefined,
): boolean {
  if (finding.adjudication === "needs_verification") return false;
  if (finding.classification === "advisory") return false;
  if (policy === undefined) return gateEligible(finding);
  return (
    severityRank[finding.severity] >= severityRank[policy.minimumSeverity] &&
    confidenceRank[finding.confidence] >=
      confidenceRank[policy.minimumConfidence]
  );
}

/** Builds the one deterministic raw, unique, gate-effective, and advisory view. */
export function canonicalizeFindings(
  values: readonly CanonicalRawFinding[],
  options: CanonicalizeFindingsOptions = {},
): CanonicalFindingSet {
  const raw = values.map((value) => structuredClone(value)).sort(compareRaw);
  const findings = raw
    .filter((finding) => finding.adjudication !== "rejected")
    .map((finding) => {
      if (
        finding.adjudication !== "adjusted" ||
        finding.effective_finding === undefined
      ) {
        return finding;
      }
      return {
        ...finding,
        ...structuredClone(finding.effective_finding),
        finding_id: finding.finding_id,
        source_ref: finding.source_ref,
        reviewer_id: finding.reviewer_id,
        lens_id: finding.lens_id,
        source_findings: finding.source_findings,
        duplicate_finding_ids: finding.duplicate_finding_ids,
        gate_eligible: thresholdEligible(
          {
            ...finding,
            ...finding.effective_finding,
          },
          options.gatePolicies?.[finding.lens_id],
        ),
      };
    })
    .map((finding) => ({
      ...finding,
      gate_eligible: thresholdEligible(
        finding,
        options.gatePolicies?.[finding.lens_id],
      ),
    }));
  const sets = new DisjointSet(findings.length);
  const explicitRoots = new Map<string, number>();
  const sourceRefs = new Map<string, number>();
  const findingIds = new Map<string, number[]>();

  for (const [index, finding] of findings.entries()) {
    sourceRefs.set(finding.source_ref, index);
    findingIds.set(finding.finding_id, [
      ...(findingIds.get(finding.finding_id) ?? []),
      index,
    ]);
    const rootIssueId = finding.root_issue_id ?? finding.deduplication_key;
    if (rootIssueId === undefined) continue;
    const key = normalizedText(rootIssueId);
    const previous = explicitRoots.get(key);
    if (previous === undefined) explicitRoots.set(key, index);
    else sets.union(previous, index);
  }

  for (const [index, finding] of findings.entries()) {
    for (const reference of [
      ...(finding.duplicate_of === undefined ? [] : [finding.duplicate_of]),
      ...finding.duplicate_finding_ids,
    ]) {
      const byRef = sourceRefs.get(reference);
      if (byRef !== undefined) {
        sets.union(index, byRef);
        continue;
      }
      const byId = findingIds.get(reference);
      if (byId?.length === 1) sets.union(index, byId[0]!);
    }
  }

  const byTitle = new Map<string, number[]>();
  for (const [index, finding] of findings.entries()) {
    const key = normalizedText(finding.title);
    byTitle.set(key, [...(byTitle.get(key) ?? []), index]);
  }
  for (const indices of byTitle.values()) {
    const rooted = new Map<string, number>();
    const rootless: number[] = [];
    for (const index of indices) {
      const finding = findings[index]!;
      const rootIssueId = finding.root_issue_id ?? finding.deduplication_key;
      if (rootIssueId === undefined) rootless.push(index);
      else rooted.set(normalizedText(rootIssueId), index);
    }
    if (rooted.size === 1) {
      const root = [...rooted.values()][0]!;
      for (const index of indices) sets.union(root, index);
    } else if (rootless.length > 1) {
      for (const index of rootless.slice(1)) sets.union(rootless[0]!, index);
    }
  }

  const byLegacyKey = new Map<string, number[]>();
  for (const [index, finding] of findings.entries()) {
    const key = `${normalizedText(finding.title)}\u0000${normalizedText(
      finding.description,
    )}`;
    byLegacyKey.set(key, [...(byLegacyKey.get(key) ?? []), index]);
  }
  for (const indices of byLegacyKey.values()) {
    const rootedKeys = new Set(
      indices.flatMap((index) => {
        const finding = findings[index]!;
        const root = finding.root_issue_id ?? finding.deduplication_key;
        return root === undefined ? [] : [normalizedText(root)];
      }),
    );
    if (rootedKeys.size > 1) continue;
    for (const index of indices.slice(1)) sets.union(indices[0]!, index);
  }

  const groups = new Map<number, CanonicalRawFinding[]>();
  for (const [index, finding] of findings.entries()) {
    const root = sets.find(index);
    groups.set(root, [...(groups.get(root) ?? []), finding]);
  }
  const consolidated = [...groups.values()].map(consolidateGroup);
  consolidated.sort(
    (left, right) =>
      severityRank[right.severity] - severityRank[left.severity] ||
      left.id.localeCompare(right.id) ||
      left.title.localeCompare(right.title),
  );
  const usedIds = new Map<string, number>();
  for (const finding of consolidated) {
    const occurrence = (usedIds.get(finding.id) ?? 0) + 1;
    usedIds.set(finding.id, occurrence);
    if (occurrence > 1) finding.id = `${finding.id}~${occurrence}`;
  }
  const gateEffective = consolidated.filter((finding) => finding.gate_eligible);
  const advisory = consolidated.filter((finding) => !finding.gate_eligible);
  return {
    raw,
    consolidated,
    gate_effective: gateEffective,
    advisory,
    counts: {
      raw: raw.length,
      unique: consolidated.length,
      gate: gateEffective.length,
      advisory: advisory.length,
    },
  };
}
