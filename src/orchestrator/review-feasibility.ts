import type { ResolvedConfig } from "../config/schemas.js";
import type { CleanModelPass, PassQuorumPolicy } from "./lens-policy.js";

export type ReviewProfile = "strict-evaluation" | "routine-review";

/** Shared by trusted validation and effective resolution; never mutates saved policy. */
export function reviewProfilePolicy(
  profile: ReviewProfile,
  modelCount: number,
  providerGroups: number,
  acknowledged = false,
) {
  return {
    passQuorum:
      profile === "strict-evaluation" ? modelCount : Math.min(2, modelCount),
    minimumProviderGroups:
      profile === "strict-evaluation"
        ? providerGroups
        : Math.min(2, providerGroups),
    allowZeroOutageTolerance: profile === "strict-evaluation" || acknowledged,
  };
}

/** Selected explicitly in trusted configuration; absence preserves every policy. */
export function applyReviewProfile(
  config: ResolvedConfig,
  profile?: ReviewProfile,
): void {
  if (!profile) return;
  const lenses = new Map<string, ResolvedConfig["reviewers"]>();
  for (const reviewer of config.reviewers) {
    const id = reviewer.agentId ?? reviewer.id;
    const members = lenses.get(id) ?? [];
    members.push(reviewer);
    lenses.set(id, members);
  }
  for (const members of lenses.values()) {
    const groups = new Set(
      members.map((reviewer) => reviewer.providerGroup ?? reviewer.adapterId),
    ).size;
    for (const reviewer of members) {
      if (!reviewer.policy) continue;
      Object.assign(
        reviewer.policy,
        reviewProfilePolicy(
          profile,
          members.length,
          groups,
          reviewer.policy.allowZeroOutageTolerance,
        ),
      );
    }
  }
}

export function evaluateRemainingQuorum(
  policy: PassQuorumPolicy,
  passes: readonly CleanModelPass[],
  remainingProviderGroups: readonly string[],
) {
  const maximumPasses = passes.length + remainingProviderGroups.length;
  const maximumProviderGroups = new Set([
    ...passes.map((pass) => pass.providerGroup),
    ...remainingProviderGroups,
  ]).size;
  return {
    reachable:
      maximumPasses >= policy.passQuorum &&
      maximumProviderGroups >= policy.minimumProviderGroups,
    maximum_passes: maximumPasses,
    maximum_provider_groups: maximumProviderGroups,
    required_passes: policy.passQuorum,
    required_provider_groups: policy.minimumProviderGroups,
  };
}

export function snapshotWorkload(
  entries: readonly {
    relevant: boolean;
    required_method: string;
    snapshot_byte_count?: number;
    snapshot_read?: string;
  }[],
) {
  const required = entries.filter(
    (entry) => entry.relevant && entry.required_method === "full_file",
  );
  return {
    required_files: required.length,
    snapshot_bytes: required.reduce(
      (sum, entry) => sum + (entry.snapshot_byte_count ?? 0),
      0,
    ),
    minimum_read_requests: required.reduce(
      (sum, entry) =>
        sum + Math.ceil((entry.snapshot_byte_count ?? 0) / (128 * 1024)),
      0,
    ),
    unavailable_files: required.filter((entry) =>
      ["unavailable", "oversize", "binary"].includes(entry.snapshot_read ?? ""),
    ).length,
  };
}
