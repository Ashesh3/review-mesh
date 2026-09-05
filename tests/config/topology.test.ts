import { describe, expect, it } from "vitest";
import { describeTopology } from "../../src/config/topology.js";

describe("describeTopology", () => {
  it("does not call a single-provider suite concentrated", () => {
    const reviewers = ["one", "two"].map((agentId) => ({
      id: agentId,
      agentId,
      modelIndex: 0,
      providerGroup: "only",
      adapterId: "only",
    }));

    expect(
      describeTopology({
        execution: { default_provider_concurrency: 2 },
        reviewers,
      }).map(({ code }) => code),
    ).not.toContain("provider_concentration");
  });

  it("reports stable acknowledged topology warnings without changing policy", () => {
    const reviewers = Array.from({ length: 5 }, (_, index) => ({
      id: `lens::${index}`,
      agentId: "lens",
      modelIndex: index,
      providerGroup: index < 3 ? "a" : index === 3 ? "b" : "c",
      adapterId: index < 3 ? "a" : index === 3 ? "b" : "c",
      policy: {
        passQuorum: 5,
        minimumProviderGroups: 3,
        allowZeroOutageTolerance: true,
      },
    }));
    reviewers.push(
      {
        ...reviewers[0]!,
        id: "second",
        agentId: "second",
        modelIndex: 0,
        policy: {
          passQuorum: 1,
          minimumProviderGroups: 1,
          allowZeroOutageTolerance: false,
        },
      },
      {
        ...reviewers[0]!,
        id: "third",
        agentId: "third",
        modelIndex: 0,
        policy: {
          passQuorum: 1,
          minimumProviderGroups: 1,
          allowZeroOutageTolerance: false,
        },
      },
    );
    expect(
      describeTopology({
        execution: { default_provider_concurrency: 2, provider_limits: {} },
        reviewers,
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "zero_outage_tolerance",
          acknowledged: true,
          lens_ids: ["lens"],
        }),
        expect.objectContaining({
          code: "single_failure_makes_quorum_unreachable",
          acknowledged: true,
          lens_ids: ["lens"],
        }),
        expect.objectContaining({
          code: "provider_concurrency_amplification",
          provider_groups: ["a"],
        }),
      ]),
    );
  });
});
