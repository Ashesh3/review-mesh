import { describe, expect, it } from "vitest";
import { trustedConfigSchema } from "../../src/config/schemas.js";

function fiveModelProfile(): Record<string, unknown> {
  return {
    adapter: "gateway",
    model_runs: [
      { id: "one", model: "one", provider_group: "provider-one" },
      { id: "two", model: "two", provider_group: "provider-two" },
      { id: "three", model: "three", provider_group: "provider-three" },
      { id: "four", model: "four", provider_group: "provider-four" },
      { id: "five", model: "five", provider_group: "provider-five" },
    ],
    purpose: "Resilient review",
    instructions: "Review carefully.",
    isolation: "prefer_enforced" as const,
    timeout_ms: 60_000,
    applicability: { mode: "always" as const },
    required_context: [],
  };
}

function v6Config(): {
  schema_version: "6";
  execution: Record<string, unknown>;
  diagnostics: Record<string, unknown>;
  adapters: Record<string, Record<string, unknown>>;
  agents: Record<string, Record<string, unknown>>;
  defaults: { agents: string[] };
  projects: Record<string, unknown>;
} {
  return {
    schema_version: "6" as const,
    execution: {
      max_concurrency: 2,
      heartbeat_interval_ms: 1_000,
      shutdown_grace_period_ms: 1_000,
    },
    diagnostics: { persist_runs: false, max_runs: 10 },
    adapters: {
      gateway: {
        type: "openai_compatible" as const,
        base_url_env: "BASE_URL",
        api_key_env: "API_KEY",
      },
    },
    agents: { resilience: fiveModelProfile() },
    defaults: { agents: ["resilience"] },
    projects: {},
  };
}

describe("trusted configuration schema v6", () => {
  it("accepts continuation_attempts from 1 through 10 and rejects values outside the bound", () => {
    const valid = v6Config();
    valid.execution.continuation_attempts = 4;
    expect(trustedConfigSchema.safeParse(valid).success).toBe(true);
    for (const value of [0, 11]) {
      const invalid = v6Config();
      invalid.execution.continuation_attempts = value;
      expect(trustedConfigSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("requires every lens to declare applicability and required context explicitly", () => {
    expect(trustedConfigSchema.safeParse(v6Config()).success).toBe(true);

    const missingApplicability = v6Config();
    delete missingApplicability.agents.resilience!.applicability;
    expect(trustedConfigSchema.safeParse(missingApplicability).success).toBe(
      false,
    );

    const missingContext = v6Config();
    delete missingContext.agents.resilience!.required_context;
    expect(trustedConfigSchema.safeParse(missingContext).success).toBe(false);
  });

  it("rejects concentrated multi-provider primaries unless explicitly acknowledged", () => {
    const concentrated = v6Config();
    concentrated.execution = {
      ...concentrated.execution,
      distribute_primaries: false,
    };
    concentrated.agents.second = fiveModelProfile();
    concentrated.defaults.agents = ["resilience", "second"];

    expect(trustedConfigSchema.safeParse(concentrated).success).toBe(false);
    expect(
      trustedConfigSchema.safeParse({
        ...concentrated,
        execution: {
          ...concentrated.execution,
          allow_provider_concentration: true,
        },
      }).success,
    ).toBe(true);
  });

  it("rejects scalar multi-provider rosters whose selected primaries concentrate", () => {
    const concentrated = v6Config();
    concentrated.agents = {
      resilience: fiveModelProfile(),
      scalar: {
        adapter: "gateway",
        provider_group: "provider-one",
        model: "one",
        purpose: "Scalar",
        instructions: "Review.",
        isolation: "prefer_enforced",
        timeout_ms: 60_000,
        applicability: { mode: "always" },
        required_context: [],
      },
    };
    concentrated.defaults.agents = ["resilience", "scalar"];

    expect(trustedConfigSchema.safeParse(concentrated).success).toBe(false);
  });

  it("rejects a strict five-of-five multi-provider quorum unless acknowledged", () => {
    const strict = v6Config();
    strict.agents.resilience = {
      ...strict.agents.resilience,
      pass_quorum: 5,
      minimum_provider_groups: 5,
    };

    expect(trustedConfigSchema.safeParse(strict).success).toBe(false);
    expect(
      trustedConfigSchema.safeParse({
        ...strict,
        agents: {
          resilience: {
            ...strict.agents.resilience,
            allow_zero_outage_tolerance: true,
          },
        },
      }).success,
    ).toBe(true);
  });

  it("rejects an impossible scalar quorum", () => {
    const scalar = v6Config();
    scalar.agents.resilience = {
      adapter: "gateway",
      model: "one",
      purpose: "Scalar review",
      instructions: "Review.",
      isolation: "prefer_enforced",
      timeout_ms: 60_000,
      applicability: { mode: "always" },
      required_context: [],
      pass_quorum: 2,
    };
    expect(trustedConfigSchema.safeParse(scalar).success).toBe(false);
  });
});
