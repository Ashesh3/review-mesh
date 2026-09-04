import { describe, expect, it } from "vitest";
import {
  DEFAULT_GATE_THRESHOLDS,
  DEFAULT_PASS_QUORUM_POLICY,
  changedPathMatchesGlob,
  compareFindingConfidence,
  compareFindingSeverity,
  evaluateLensPolicy,
  evaluatePassQuorum,
  hasRequiredCallerContext,
  highestFindingConfidence,
  highestFindingSeverity,
  meetsGateThresholds,
  validateCallerContextRequirement,
  validateChangedPath,
  validateChangedPathGlob,
  validateLensPolicy,
  validatePassQuorumFeasibility,
  validatePassQuorumPolicy,
  validateProviderGroup,
  type LensPolicy,
} from "../../src/orchestrator/lens-policy.js";

function policy(overrides: Partial<LensPolicy> = {}): LensPolicy {
  return {
    applicability: { mode: "always" },
    requiredCallerContext: [],
    pass: { ...DEFAULT_PASS_QUORUM_POLICY },
    gate: { ...DEFAULT_GATE_THRESHOLDS },
    ...overrides,
  };
}

describe("changed-path applicability", () => {
  it("treats explicit always applicability as independent of changed paths", () => {
    expect(
      evaluateLensPolicy(
        policy({
          applicability: { mode: "always" } as LensPolicy["applicability"],
        }),
        {
          reviewScopeMode: "changes",
          changedPaths: ["src/index.ts"],
        },
      ),
    ).toEqual({ status: "applicable" });
  });

  it.each([
    ["deploy/**", "deploy/service.yaml"],
    ["deploy/**", "deploy/nested/service.yaml"],
    ["**/Dockerfile", "Dockerfile"],
    ["**/Dockerfile", "services/api/Dockerfile"],
    ["src/*.ts", "src/index.ts"],
    ["src/file?.ts", "src/file1.ts"],
    ["src/?.ts", "src/😀.ts"],
    ["src/😀.ts", "src/😀.ts"],
  ])("matches %s against %s", (pattern, path) => {
    expect(changedPathMatchesGlob(pattern, path)).toBe(true);
  });

  it.each([
    ["deploy/**", "src/deploy/service.yaml"],
    ["src/*.ts", "src/nested/index.ts"],
    ["src/file?.ts", "src/file10.ts"],
    ["Dockerfile", "services/Dockerfile"],
  ])("does not match %s against %s", (pattern, path) => {
    expect(changedPathMatchesGlob(pattern, path)).toBe(false);
  });

  it("defaults to case-sensitive matching and supports explicit insensitive matching", () => {
    expect(changedPathMatchesGlob("Deploy/**", "deploy/app.yaml")).toBe(false);
    expect(
      changedPathMatchesGlob("Deploy/**", "deploy/app.yaml", {
        caseSensitive: false,
      }),
    ).toBe(true);
  });

  it.each([
    "",
    "/absolute/**",
    "C:/absolute/**",
    "deploy\\**",
    "deploy//**",
    "deploy/../**",
    "deploy/ab**cd",
    "deploy/[ab]",
    "deploy/{a,b}",
    "!deploy/**",
  ])("rejects unsafe or unsupported glob %j", (pattern) => {
    expect(() => validateChangedPathGlob(pattern)).toThrow();
  });

  it.each([
    "../secret",
    "/absolute",
    "C:/absolute",
    "src\\file.ts",
    "src/*.ts",
  ])("rejects unsafe or non-literal changed path %j", (path) => {
    expect(() => validateChangedPath(path)).toThrow();
  });

  it("marks an irrelevant lens not applicable before inspecting required inputs", () => {
    const result = evaluateLensPolicy(
      policy({
        applicability: {
          mode: "changed_paths",
          anyChangedPaths: ["deploy/**", "**/Dockerfile"],
        },
        requiredCallerContext: ["/pull_request/number"],
      }),
      {
        reviewScopeMode: "changes",
        changedPaths: ["src/index.ts", "tests/index.test.ts"],
      },
    );

    expect(result).toEqual({
      status: "not_applicable",
      reason: "no_changed_path_match",
    });
  });

  it("reports missing inputs only after the changed surface matches", () => {
    const result = evaluateLensPolicy(
      policy({
        applicability: {
          mode: "changed_paths",
          anyChangedPaths: ["deploy/**"],
        },
        requiredCallerContext: ["/pull_request/number", "work_item"],
      }),
      {
        reviewScopeMode: "changes",
        changedPaths: ["deploy/service.yaml"],
        callerContext: { pull_request: { title: "Release" } },
      },
    );

    expect(result).toEqual({
      status: "not_evaluated_missing_input",
      reason: "missing_required_caller_context",
      missingCallerContext: ["/pull_request/number", "work_item"],
      matchedChangedPath: "deploy/service.yaml",
      matchedPattern: "deploy/**",
    });
  });

  it("treats a full-scope review as applicable regardless of changed paths", () => {
    expect(
      evaluateLensPolicy(
        policy({
          applicability: {
            mode: "changed_paths",
            anyChangedPaths: ["deploy/**"],
          },
          requiredCallerContext: ["/pull_request/number"],
        }),
        {
          reviewScopeMode: "full",
          changedPaths: [],
          callerContext: { pull_request: { number: 42 } },
        },
      ),
    ).toEqual({ status: "applicable" });
  });

  it("returns the first deterministic path and pattern match", () => {
    expect(
      evaluateLensPolicy(
        policy({
          applicability: {
            mode: "changed_paths",
            anyChangedPaths: ["src/**", "src/exact.ts"],
          },
        }),
        {
          reviewScopeMode: "changes",
          changedPaths: ["tests/test.ts", "src/exact.ts", "src/later.ts"],
        },
      ),
    ).toEqual({
      status: "applicable",
      matchedChangedPath: "src/exact.ts",
      matchedPattern: "src/**",
    });
  });

  it("validates the complete changed-path list before accepting an early match", () => {
    expect(() =>
      evaluateLensPolicy(
        policy({
          applicability: {
            mode: "changed_paths",
            anyChangedPaths: ["src/**"],
          },
        }),
        {
          reviewScopeMode: "changes",
          changedPaths: ["src/index.ts", "../outside.ts"],
        },
      ),
    ).toThrow(/changed path/i);
  });

  it("rejects empty and duplicate applicability policies", () => {
    expect(() =>
      validateLensPolicy(
        policy({
          applicability: { mode: "changed_paths", anyChangedPaths: [] },
        }),
      ),
    ).toThrow(/requires/i);
    expect(() =>
      validateLensPolicy(
        policy({
          applicability: {
            mode: "changed_paths",
            anyChangedPaths: ["src/**", "src/**"],
          },
        }),
      ),
    ).toThrow(/duplicate/i);
  });
});

describe("required caller context", () => {
  it("supports own top-level keys, nested JSON Pointers, arrays, and RFC 6901 escapes", () => {
    const context = Object.assign(Object.create({ inherited: true }), {
      pull_request: { number: 42 },
      work_items: [{ id: "AB#123" }],
      "a/b": { "~key": "present" },
      false_value: false,
      zero_value: 0,
      empty_value: "",
    });

    expect(hasRequiredCallerContext(context, "pull_request")).toBe(true);
    expect(hasRequiredCallerContext(context, "/pull_request/number")).toBe(
      true,
    );
    expect(hasRequiredCallerContext(context, "/work_items/0/id")).toBe(true);
    expect(hasRequiredCallerContext(context, "/a~1b/~0key")).toBe(true);
    expect(hasRequiredCallerContext(context, "false_value")).toBe(true);
    expect(hasRequiredCallerContext(context, "zero_value")).toBe(true);
    expect(hasRequiredCallerContext(context, "empty_value")).toBe(true);
    expect(hasRequiredCallerContext(context, "inherited")).toBe(false);
    expect(hasRequiredCallerContext(context, "/work_items/1/id")).toBe(false);
  });

  it("treats null and undefined as missing but permits other JSON values", () => {
    const context = { null_value: null, undefined_value: undefined, list: [] };
    expect(hasRequiredCallerContext(context, "null_value")).toBe(false);
    expect(hasRequiredCallerContext(context, "undefined_value")).toBe(false);
    expect(hasRequiredCallerContext(context, "list")).toBe(true);
  });

  it.each(["", "unsafe key", "/bad~2escape", "/trailing~"])(
    "rejects invalid requirement %j",
    (requirement) => {
      expect(() => validateCallerContextRequirement(requirement)).toThrow();
    },
  );

  it("rejects duplicate context requirements", () => {
    expect(() =>
      validateLensPolicy(
        policy({ requiredCallerContext: ["pull_request", "pull_request"] }),
      ),
    ).toThrow(/duplicate/i);
  });
});

describe("pass quorum and provider diversity", () => {
  it("requires both enough clean passes and enough provider groups", () => {
    expect(
      evaluatePassQuorum({ passQuorum: 2, minimumProviderGroups: 2 }, [
        { providerGroup: "anthropic" },
        { providerGroup: "anthropic" },
      ]),
    ).toEqual({
      cleanPasses: 2,
      distinctProviderGroups: 1,
      satisfied: false,
      remainingPasses: 0,
      remainingProviderGroups: 1,
    });

    expect(
      evaluatePassQuorum({ passQuorum: 2, minimumProviderGroups: 2 }, [
        { providerGroup: "anthropic" },
        { providerGroup: "openai" },
      ]),
    ).toMatchObject({ satisfied: true, remainingPasses: 0 });
  });

  it("counts model executions rather than unique provider groups for pass quorum", () => {
    expect(
      evaluatePassQuorum({ passQuorum: 3, minimumProviderGroups: 2 }, [
        { providerGroup: "a" },
        { providerGroup: "b" },
      ]),
    ).toMatchObject({
      cleanPasses: 2,
      distinctProviderGroups: 2,
      satisfied: false,
      remainingPasses: 1,
      remainingProviderGroups: 0,
    });
  });

  it.each([
    { passQuorum: 0, minimumProviderGroups: 1 },
    { passQuorum: 2, minimumProviderGroups: 0 },
    { passQuorum: 2, minimumProviderGroups: 3 },
    { passQuorum: 1.5, minimumProviderGroups: 1 },
  ])(
    "rejects invalid pass policy $passQuorum/$minimumProviderGroups",
    (value) => {
      expect(() => validatePassQuorumPolicy(value)).toThrow();
    },
  );

  it("rejects policies that the eligible model roster cannot satisfy", () => {
    expect(() =>
      validatePassQuorumFeasibility(
        { passQuorum: 3, minimumProviderGroups: 2 },
        ["a", "b"],
      ),
    ).toThrow(/eligible model runs/i);
    expect(() =>
      validatePassQuorumFeasibility(
        { passQuorum: 3, minimumProviderGroups: 2 },
        ["same", "same", "same"],
      ),
    ).toThrow(/eligible groups/i);
    expect(() =>
      validatePassQuorumFeasibility(
        { passQuorum: 3, minimumProviderGroups: 2 },
        ["a", "a", "b"],
      ),
    ).not.toThrow();
  });

  it.each(["", "provider/group", "provider group", "a".repeat(129)])(
    "rejects unsafe provider group %j",
    (providerGroup) => {
      expect(() => validateProviderGroup(providerGroup)).toThrow();
    },
  );
});

describe("gate severity and confidence helpers", () => {
  it("orders severity and confidence from low to high", () => {
    expect(compareFindingSeverity("critical", "high")).toBeGreaterThan(0);
    expect(compareFindingSeverity("medium", "medium")).toBe(0);
    expect(compareFindingConfidence("low", "high")).toBeLessThan(0);
    expect(compareFindingConfidence("high", "medium")).toBeGreaterThan(0);
  });

  it("selects the highest value without reordering caller data", () => {
    const severities = ["medium", "critical", "low"] as const;
    const confidences = ["low", "high", "medium"] as const;
    expect(highestFindingSeverity(severities)).toBe("critical");
    expect(highestFindingConfidence(confidences)).toBe("high");
    expect(highestFindingSeverity([])).toBeUndefined();
    expect(highestFindingConfidence([])).toBeUndefined();
    expect(severities).toEqual(["medium", "critical", "low"]);
  });

  it("keeps low severity and low confidence findings outside the default gate", () => {
    expect(
      meetsGateThresholds(
        { severity: "low", confidence: "high" },
        DEFAULT_GATE_THRESHOLDS,
      ),
    ).toBe(false);
    expect(
      meetsGateThresholds(
        { severity: "high", confidence: "low" },
        DEFAULT_GATE_THRESHOLDS,
      ),
    ).toBe(false);
    expect(
      meetsGateThresholds(
        { severity: "medium", confidence: "medium" },
        DEFAULT_GATE_THRESHOLDS,
      ),
    ).toBe(true);
  });
});
