import { expect, it } from "vitest";
import {
  evaluateRemainingQuorum,
  snapshotWorkload,
  applyReviewProfile,
} from "../../src/orchestrator/review-feasibility.js";
import { roundInput } from "../helpers/fixtures.js";

it("marks a five-of-five clean quorum unreachable after one permanent failure", () => {
  expect(
    evaluateRemainingQuorum(
      { passQuorum: 5, minimumProviderGroups: 5 },
      [],
      ["b", "c", "d", "e"],
    ),
  ).toMatchObject({
    reachable: false,
    maximum_passes: 4,
    maximum_provider_groups: 4,
  });
  expect(
    evaluateRemainingQuorum(
      { passQuorum: 2, minimumProviderGroups: 2 },
      [{ providerGroup: "a" }],
      ["b", "c"],
    ),
  ).toMatchObject({ reachable: true });
});
it("costs full snapshots and flags unavailable evidence independently of diff size", () => {
  expect(
    snapshotWorkload([
      {
        relevant: true,
        required_method: "full_file",
        snapshot_byte_count: 150 * 1024,
        snapshot_read: "not_inspected",
      },
      {
        relevant: true,
        required_method: "full_file",
        snapshot_read: "unavailable",
      },
      {
        relevant: false,
        required_method: "full_file",
        snapshot_byte_count: 999999,
      },
    ]),
  ).toEqual({
    required_files: 2,
    snapshot_bytes: 150 * 1024,
    minimum_read_requests: 2,
    unavailable_files: 1,
  });
});
it("only changes quorum when a deliberate profile is selected and retains evidence requirements", () => {
  const config = roundInput().config;
  const original = config.reviewers[0]!;
  config.reviewers = Array.from({ length: 5 }, (_, i) => ({
    ...original,
    id: `r${i}`,
    agentId: "lens",
    providerGroup: `p${i}`,
    policy: {
      applicability: { mode: "always" },
      requiredCallerContext: [],
      passQuorum: 5,
      minimumProviderGroups: 5,
      adjudication: "required",
      gateMinimumSeverity: "medium",
      gateMinimumConfidence: "medium",
      changeCoverage: {
        relevantPaths: ["**"],
        minimumInspection: "full_file",
        proof: "observed",
      },
    },
  }));
  applyReviewProfile(config, undefined);
  expect(config.reviewers[0]!.policy!.passQuorum).toBe(5);
  applyReviewProfile(config, "routine-review");
  expect(config.reviewers[0]!.policy).toMatchObject({
    passQuorum: 2,
    minimumProviderGroups: 2,
    changeCoverage: { minimumInspection: "full_file", proof: "observed" },
  });
  applyReviewProfile(config, "strict-evaluation");
  expect(config.reviewers[0]!.policy).toMatchObject({
    passQuorum: 5,
    minimumProviderGroups: 5,
  });
});
