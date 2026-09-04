import { providerOutageTolerance } from "../orchestrator/lens-policy.js";

export type TopologyWarningCode =
  | "provider_concentration"
  | "zero_outage_tolerance"
  | "single_failure_makes_quorum_unreachable"
  | "provider_concurrency_amplification";

export interface TopologyWarning {
  code: TopologyWarningCode;
  message: string;
  acknowledged: boolean;
  lens_ids: string[];
  provider_groups: string[];
}

type TopologyConfig = {
  execution: {
    allow_provider_concentration?: boolean;
    default_provider_concurrency?: number;
    provider_limits?: Record<string, number>;
  };
  reviewers: ReadonlyArray<{
    id: string;
    agentId?: string;
    modelIndex?: number;
    adapterId: string;
    providerGroup?: string;
    policy?: {
      passQuorum: number;
      minimumProviderGroups: number;
      allowZeroOutageTolerance?: boolean | undefined;
    };
  }>;
};

export function describeTopology(config: TopologyConfig): TopologyWarning[] {
  const lenses = new Map<string, TopologyConfig["reviewers"]>();
  for (const reviewer of config.reviewers) {
    const id = reviewer.agentId ?? reviewer.id;
    const members = lenses.get(id) ?? [];
    lenses.set(id, [...members, reviewer]);
  }
  const warnings: TopologyWarning[] = [];
  const primaryGroups = new Set(
    [...lenses.values()].map((members) => {
      const primary =
        members.find((member) => (member.modelIndex ?? 0) === 0) ?? members[0]!;
      return primary.providerGroup ?? primary.adapterId;
    }),
  );
  if (lenses.size > 1 && primaryGroups.size === 1) {
    warnings.push({
      code: "provider_concentration",
      message:
        "Every logical lens starts on the same provider group; one provider incident can amplify across the suite.",
      acknowledged: config.execution.allow_provider_concentration === true,
      lens_ids: [...lenses.keys()],
      provider_groups: [...primaryGroups],
    });
  }
  for (const [lensId, members] of lenses) {
    const groups = members.map(
      (member) => member.providerGroup ?? member.adapterId,
    );
    const policy = members[0]?.policy;
    const passQuorum = policy?.passQuorum ?? members.length;
    const minimumProviderGroups = policy?.minimumProviderGroups ?? 1;
    const acknowledged = policy?.allowZeroOutageTolerance === true;
    if (
      new Set(groups).size > 1 &&
      providerOutageTolerance({ passQuorum, minimumProviderGroups }, groups) ===
        0
    ) {
      warnings.push({
        code: "zero_outage_tolerance",
        message:
          "The configured lens cannot tolerate the loss of one provider group.",
        acknowledged,
        lens_ids: [lensId],
        provider_groups: [...new Set(groups)],
      });
    }
    if (passQuorum === members.length && members.length > 1) {
      warnings.push({
        code: "single_failure_makes_quorum_unreachable",
        message:
          "One model failure makes the configured pass quorum unreachable.",
        acknowledged,
        lens_ids: [lensId],
        provider_groups: [...new Set(groups)],
      });
    }
  }
  const byProvider = new Map<string, Set<string>>();
  for (const [lensId, members] of lenses) {
    for (const group of new Set(
      members.map((member) => member.providerGroup ?? member.adapterId),
    )) {
      const affected = byProvider.get(group) ?? new Set<string>();
      affected.add(lensId);
      byProvider.set(group, affected);
    }
  }
  for (const [group, lensIds] of byProvider) {
    const limit =
      config.execution.provider_limits?.[group] ??
      config.execution.default_provider_concurrency ??
      2;
    if (lensIds.size > limit) {
      warnings.push({
        code: "provider_concurrency_amplification",
        message:
          "More logical lenses target this provider group than its configured concurrent capacity.",
        acknowledged: false,
        lens_ids: [...lensIds],
        provider_groups: [group],
      });
    }
  }
  return warnings;
}
