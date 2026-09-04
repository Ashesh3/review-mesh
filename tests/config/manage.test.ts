import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "smol-toml";
import {
  emptyManagedConfig,
  loadManagedConfig,
  parseManagedConfig,
  saveManagedConfig,
  serializeManagedConfig,
  type ManagedConfig,
} from "../../src/config/manage.js";

const roots: string[] = [];

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "review-mesh-config-manage-"));
  roots.push(path);
  return path;
}

function config(): ManagedConfig {
  return {
    schema_version: "6",
    execution: {
      max_concurrency: 2,
      heartbeat_interval_ms: 15_000,
      shutdown_grace_period_ms: 5_000,
      allow_provider_concentration: false,
      continuation_attempts: 2,
    },
    diagnostics: { persist_runs: true, max_runs: 50 },
    adapters: {
      gateway: {
        type: "openai_compatible",
        base_url_env: "REVIEW_BASE_URL",
        api_key_env: "REVIEW_API_KEY",
      },
    },
    agents: {
      gemini: {
        adapter: "gateway",
        model: "gemini-flash",
        effort: "high",
        purpose: "Correctness",
        instructions: "Review carefully.",
        isolation: "prefer_enforced",
        timeout_ms: 900_000,
        applicability: { mode: "always" },
        required_context: [],
      },
    },
    defaults: { agents: ["gemini"] },
    projects: {},
  };
}

function legacyConfig(version: "2" | "4" | "5"): Record<string, unknown> {
  const current = config();
  const agents = Object.fromEntries(
    Object.entries(current.agents).map(([id, agent]) => {
      const {
        applicability: _applicability,
        required_context: _requiredContext,
        allow_zero_outage_tolerance: _allowZeroOutageTolerance,
        ...legacy
      } = agent;
      return [id, legacy];
    }),
  );
  const {
    allow_provider_concentration: _allowProviderConcentration,
    continuation_attempts: _continuationAttempts,
    ...v5Execution
  } = current.execution;
  const {
    distribute_primaries: _distributePrimaries,
    default_provider_concurrency: _defaultProviderConcurrency,
    provider_limits: _providerLimits,
    circuit_breaker_threshold: _circuitBreakerThreshold,
    circuit_breaker_cooldown_ms: _circuitBreakerCooldownMs,
    retry_attempts: _retryAttempts,
    retry_backoff_ms: _retryBackoffMs,
    ...legacyExecution
  } = v5Execution;
  return {
    ...current,
    schema_version: version,
    execution: version === "5" ? v5Execution : legacyExecution,
    agents,
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("managed configuration", () => {
  it("migrates to v7 while preserving explicit heartbeat, roster, order, quorum, and acknowledgements", () => {
    const legacy = legacyConfig("5") as {
      execution: Record<string, unknown>;
      agents: Record<string, Record<string, unknown>>;
      defaults: { agents: string[] };
    };
    legacy.execution.heartbeat_interval_ms = 15_000;
    legacy.agents.gemini = {
      adapter: "gateway",
      model_runs: [
        { id: "first", model: "one", provider_group: "a" },
        { id: "second", model: "two", provider_group: "b" },
      ],
      purpose: "Strict legacy review",
      instructions: "Review.",
      isolation: "prefer_enforced",
      timeout_ms: 60_000,
      applicability: { any_changed_paths: ["src/**"] },
      required_context: ["/ticket"],
      pass_quorum: 2,
      minimum_provider_groups: 2,
    };
    legacy.defaults.agents = ["gemini"];

    const migrated = parseManagedConfig(`${stringify(legacy)}\n`);
    expect(migrated.config).toMatchObject({
      schema_version: "7",
      execution: {
        heartbeat_interval_ms: 15_000,
        deadline_mode: "adaptive",
        no_progress_timeout_ms: 300_000,
      },
      defaults: { agents: ["gemini"] },
      agents: {
        gemini: {
          kind: "generic",
          model_runs: [{ id: "first" }, { id: "second" }],
          pass_quorum: 2,
          minimum_provider_groups: 2,
          allow_zero_outage_tolerance: true,
          required_input: ["/context/ticket"],
          change_coverage: {
            relevant_paths: ["src/**"],
            minimum_inspection: "full_file",
            proof: "observed",
          },
        },
      },
    });
    expect(migrated.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "implicit_v9_deadline" }),
        expect.objectContaining({
          code: "implicit_v9_change_coverage",
          lens_ids: ["gemini"],
        }),
      ]),
    );
  });

  it("derives one attested policy when any candidate adapter is opaque", () => {
    const legacy = legacyConfig("5") as {
      adapters: Record<string, unknown>;
      agents: Record<string, Record<string, unknown>>;
    };
    legacy.adapters.opaque = {
      type: "command",
      command: "reviewer",
      protocol: "review-mesh-command-v1",
    };
    legacy.agents.gemini = {
      adapter: "gateway",
      model_runs: [
        { id: "mediated", model: "one" },
        { id: "opaque", adapter: "opaque", model: "two" },
      ],
      purpose: "Mixed adapters",
      instructions: "Review.",
      isolation: "prefer_enforced",
      timeout_ms: 60_000,
    };
    const migrated = parseManagedConfig(`${stringify(legacy)}\n`);
    expect(migrated.config.agents.gemini?.change_coverage?.proof).toBe(
      "attested",
    );
    expect(migrated.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "attested_coverage_requires_adapter_upgrade",
          lens_ids: ["gemini"],
        }),
      ]),
    );
  });

  it("preserves v6 five-model defaults, applicability, continuation, and selector meaning", () => {
    const current = config();
    current.schema_version = "6";
    current.execution.continuation_attempts = 5;
    current.agents.gemini = {
      adapter: "gateway",
      model_runs: ["a", "b", "c", "d", "e"].map((id) => ({
        id,
        model: id,
        provider_group: id,
      })),
      purpose: "V6 defaults",
      instructions: "Review.",
      isolation: "prefer_enforced",
      timeout_ms: 60_000,
      applicability: {
        mode: "changed_paths",
        any_changed_paths: ["src/**"],
      },
      required_context: ["legacy_key"],
    };
    const migrated = parseManagedConfig(`${stringify(current)}\n`).config;
    expect(migrated.execution.continuation_attempts).toBe(5);
    expect(migrated.agents.gemini).toMatchObject({
      pass_quorum: 3,
      minimum_provider_groups: 3,
      applicability: {
        mode: "changed_paths",
        any_changed_paths: ["src/**"],
      },
      required_input: ["/context/legacy_key"],
      change_coverage: { relevant_paths: ["src/**"] },
    });
  });
  it("migrates v5 lenses to explicit v6 policy without inventing prerequisites", () => {
    const legacy = legacyConfig("5") as {
      agents: Record<string, Record<string, unknown>>;
    };
    legacy.agents.gemini!.applicability = {
      any_changed_paths: ["deploy/**"],
    };
    const result = parseManagedConfig(`${stringify(legacy)}\n`);

    expect(result.migrated).toBe(true);
    expect(result.config.schema_version).toBe("7");
    expect(result.config.agents.gemini).toMatchObject({
      applicability: {
        mode: "changed_paths",
        any_changed_paths: ["deploy/**"],
      },
      required_input: [],
    });
    expect(result.config.adapters.gateway).toMatchObject({
      type: "openai_compatible",
      streaming: "disabled",
    });
  });

  it("preserves an explicitly strict legacy quorum by acknowledging it", () => {
    const legacy = legacyConfig("5") as {
      agents: Record<string, Record<string, unknown>>;
    };
    legacy.agents.gemini = {
      adapter: "gateway",
      model_runs: [
        { id: "one", model: "one", provider_group: "one" },
        { id: "two", model: "two", provider_group: "two" },
        { id: "three", model: "three", provider_group: "three" },
        { id: "four", model: "four", provider_group: "four" },
        { id: "five", model: "five", provider_group: "five" },
      ],
      purpose: "Strict legacy review",
      instructions: "Review.",
      isolation: "prefer_enforced",
      timeout_ms: 60_000,
      pass_quorum: 5,
      minimum_provider_groups: 5,
    };

    const migrated = parseManagedConfig(`${stringify(legacy)}\n`).config;
    expect(migrated.agents.gemini).toMatchObject({
      pass_quorum: 5,
      minimum_provider_groups: 5,
      allow_zero_outage_tolerance: true,
      applicability: { mode: "always" },
      required_input: [],
    });
  });

  it("normalizes managed saves to schema v7", () => {
    const serialized = serializeManagedConfig(
      legacyConfig("5") as unknown as ManagedConfig,
    );
    expect(parseManagedConfig(serialized)).toMatchObject({
      migrated: false,
      config: {
        schema_version: "7",
        execution: { allow_provider_concentration: false },
        agents: {
          gemini: {
            applicability: { mode: "always" },
            required_input: [],
          },
        },
      },
    });
  });

  it("migrates and round-trips a native v6 configuration as v7", () => {
    const configured = config();
    configured.adapters.gateway = {
      type: "openai_compatible",
      base_url_env: "REVIEW_BASE_URL",
      api_key_env: "REVIEW_API_KEY",
      streaming: "required",
    };
    const serialized = serializeManagedConfig(configured);
    expect(parseManagedConfig(serialized)).toMatchObject({
      config: { schema_version: "7" },
      migrated: false,
      warnings: [],
    });
    expect(serialized).toContain('streaming = "required"');
  });

  it("round-trips ordered model runs with inherited and overridden adapters", () => {
    const multi = config();
    multi.adapters.claude = { type: "claude" };
    multi.agents.gemini = {
      adapter: "gateway",
      model_runs: [
        { id: "opus", model: "claude-opus" },
        {
          id: "grok",
          adapter: "claude",
          model: "grok-code",
          effort: "high",
        },
      ],
      purpose: "Architecture",
      instructions: "Review architecture.",
      isolation: "prefer_enforced",
      timeout_ms: 900_000,
      applicability: { mode: "always" },
      required_context: [],
      allow_zero_outage_tolerance: true,
    };

    const parsed = parseManagedConfig(serializeManagedConfig(multi));
    expect(parsed.config.agents.gemini).toMatchObject({
      adapter: "gateway",
      model_runs: multi.agents.gemini.model_runs,
      required_input: [],
      change_coverage: { proof: "observed" },
    });
  });

  it("rejects invalid model-run shapes and expanded reviewer id collisions", () => {
    const invalidId = config();
    invalidId.agents.gemini = {
      adapter: "gateway",
      model_runs: [{ id: "not safe", model: "model" }],
      purpose: "Architecture",
      instructions: "Review architecture.",
      isolation: "prefer_enforced",
      timeout_ms: 900_000,
      applicability: { mode: "always" },
      required_context: [],
      allow_zero_outage_tolerance: true,
    };
    expect(() => serializeManagedConfig(invalidId)).toThrow(/model run id/i);

    const duplicateRun = config();
    duplicateRun.agents.gemini = {
      adapter: "gateway",
      model_runs: [
        { id: "same", model: "one" },
        { id: "same", model: "two" },
      ],
      purpose: "Architecture",
      instructions: "Review architecture.",
      isolation: "prefer_enforced",
      timeout_ms: 900_000,
      applicability: { mode: "always" },
      required_context: [],
    };
    expect(() => serializeManagedConfig(duplicateRun)).toThrow(/unique/i);

    const bothModes = config() as unknown as Record<string, unknown>;
    const bothAgents = bothModes.agents as Record<
      string,
      Record<string, unknown>
    >;
    bothAgents.gemini!.model_runs = [{ id: "extra", model: "other" }];
    expect(() =>
      serializeManagedConfig(bothModes as unknown as ManagedConfig),
    ).toThrow();

    const collision = config();
    collision.agents.architecture = {
      adapter: "gateway",
      model_runs: [
        { id: "opus", model: "one" },
        { id: "grok", model: "two" },
      ],
      purpose: "Architecture",
      instructions: "Review architecture.",
      isolation: "prefer_enforced",
      timeout_ms: 900_000,
      applicability: { mode: "always" },
      required_context: [],
    };
    collision.agents["architecture::opus"] = {
      adapter: "gateway",
      model: "two",
      purpose: "Collision",
      instructions: "Review collisions.",
      isolation: "prefer_enforced",
      timeout_ms: 900_000,
      applicability: { mode: "always" },
      required_context: [],
    };
    expect(() => serializeManagedConfig(collision)).toThrow(
      /expanded reviewer id collision/i,
    );

    const singleRun = config();
    singleRun.agents.gemini = {
      adapter: "gateway",
      model_runs: [{ id: "only", model: "one" }],
      purpose: "Architecture",
      instructions: "Review architecture.",
      isolation: "prefer_enforced",
      timeout_ms: 900_000,
      applicability: { mode: "always" },
      required_context: [],
    };
    expect(() => serializeManagedConfig(singleRun)).toThrow(/at least two/i);
  });

  it("migrates the ordered v1 roster into v4 default agents", () => {
    const legacy = `schema_version = "1"
[execution]
max_concurrency = 1
heartbeat_interval_ms = 1000
shutdown_grace_period_ms = 100
[diagnostics]
persist_runs = false
max_runs = 1
[adapters.gateway]
type = "openai_compatible"
base_url_env = "BASE"
api_key_env = "KEY"
[reviewer_profiles.profile]
adapter = "gateway"
model = "model"
purpose = "purpose"
instructions = "base"
isolation = "prefer_enforced"
timeout_ms = 1000
[[reviewers]]
id = "agent-one"
profile = "profile"
append_instructions = "extra"
`;
    const result = parseManagedConfig(legacy);
    expect(result.migrated).toBe(true);
    expect(result.config.defaults?.agents).toEqual(["agent-one"]);
    expect(result.config.execution.distribute_primaries).toBe(false);
    expect(result.config.agents["agent-one"]?.instructions).toBe(
      "base\n\nextra",
    );
    expect(result.warnings.map(({ code }) => code)).toEqual([
      "implicit_v9_deadline",
      "implicit_v9_change_coverage",
    ]);
  });

  it("reads scalar v2 configuration and promotes it to managed v4", () => {
    const legacyV2 = `${stringify(legacyConfig("2"))}\n`;
    const result = parseManagedConfig(legacyV2);
    expect(result.migrated).toBe(true);
    expect(result.config.schema_version).toBe("7");
    expect(result.config.execution.distribute_primaries).toBe(false);
    expect(result.config.agents.gemini).toMatchObject({
      model: "gemini-flash",
      effort: "high",
    });
    expect(result.warnings.map(({ code }) => code)).toEqual([
      "implicit_v9_deadline",
      "implicit_v9_change_coverage",
    ]);
  });

  it("preserves configured primary order when promoting v4 to v6", () => {
    const legacyV4 = `${stringify(legacyConfig("4"))}\n`;
    const result = parseManagedConfig(legacyV4);
    expect(result).toMatchObject({ migrated: true });
    expect(result.config.execution.distribute_primaries).toBe(false);
  });

  it("migrates path-keyed v3 projects to names and rejects collisions", () => {
    const legacyV3 = legacyConfig("5");
    legacyV3.schema_version = "3";
    legacyV3.projects = {
      "C:/work/payments": { agents: ["gemini"] },
    };
    const migrated = parseManagedConfig(`${stringify(legacyV3)}\n`);
    expect(migrated.migrated).toBe(true);
    expect(migrated.config.execution.distribute_primaries).toBe(false);
    expect(migrated.config.projects).toEqual({
      payments: { agents: ["gemini"] },
    });

    const colliding = `schema_version = "3"
[execution]
max_concurrency = 2
heartbeat_interval_ms = 15000
shutdown_grace_period_ms = 5000
[diagnostics]
persist_runs = true
max_runs = 50
[adapters.gateway]
type = "openai_compatible"
base_url_env = "REVIEW_BASE_URL"
api_key_env = "REVIEW_API_KEY"
[agents.gemini]
adapter = "gateway"
model = "gemini-flash"
purpose = "Correctness"
instructions = "Review carefully."
isolation = "prefer_enforced"
timeout_ms = 900000
[defaults]
agents = ["gemini"]
[projects."C:/one/demo"]
agents = ["gemini"]
[projects."D:/two/demo"]
agents = ["gemini"]
`;
    expect(() => parseManagedConfig(colliding)).toThrow(/both migrate/i);
  });

  it("writes a new file atomically and rejects a stale writer", async () => {
    const directory = await root();
    const file = join(directory, "nested", "config.toml");
    const loaded = await loadManagedConfig(file, true);
    const saved = await saveManagedConfig(file, config(), loaded.snapshot);
    expect(
      parseManagedConfig(await readFile(file, "utf8")).config,
    ).toMatchObject({
      schema_version: "7",
      execution: { heartbeat_interval_ms: 15_000 },
      defaults: { agents: ["gemini"] },
    });
    if (process.platform !== "win32") {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    }

    await writeFile(
      file,
      serializeManagedConfig({
        ...config(),
        diagnostics: { persist_runs: false, max_runs: 2 },
      }),
    );
    await expect(saveManagedConfig(file, config(), saved)).rejects.toThrow(
      /changed on disk/i,
    );
  });

  it("allows only one concurrent writer to publish from the same revision", async () => {
    const directory = await root();
    const file = join(directory, "config.toml");
    const initial = await loadManagedConfig(file, true);
    await saveManagedConfig(file, config(), initial.snapshot);
    const shared = await loadManagedConfig(file);
    const first = config();
    first.execution.max_concurrency = 3;
    const second = config();
    second.execution.max_concurrency = 4;

    const outcomes = await Promise.allSettled([
      saveManagedConfig(file, first, shared.snapshot),
      saveManagedConfig(file, second, shared.snapshot),
    ]);

    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      outcomes.filter((outcome) => outcome.status === "rejected"),
    ).toHaveLength(1);
    expect([3, 4]).toContain(
      (await loadManagedConfig(file)).config.execution.max_concurrency,
    );
  });

  it("rejects symlink destinations", async () => {
    const directory = await root();
    const outside = join(directory, "outside.toml");
    const linked = join(directory, "config.toml");
    await writeFile(outside, serializeManagedConfig(config()));
    try {
      await symlink(outside, linked, "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    await expect(loadManagedConfig(linked)).rejects.toThrow(/symlink/i);
  });

  it("does not serialize environment variable values", () => {
    process.env.REVIEW_API_KEY = "super-secret-value";
    expect(serializeManagedConfig(config())).not.toContain(
      "super-secret-value",
    );
  });

  it("keeps an intentionally incomplete first-run draft in memory only", () => {
    expect(emptyManagedConfig().defaults?.agents).toEqual([]);
    expect(() => serializeManagedConfig(emptyManagedConfig())).toThrow();
  });

  it("rejects an effort that the selected native adapter cannot forward", () => {
    const invalid = config();
    invalid.adapters.claude = { type: "claude" };
    const current = invalid.agents.gemini!;
    if (current.model === undefined)
      throw new Error("expected scalar test agent");
    invalid.agents.gemini = {
      adapter: "claude",
      model: current.model,
      effort: "ultra",
      purpose: current.purpose,
      ...(current.instructions === undefined
        ? { instructions_file: current.instructions_file! }
        : { instructions: current.instructions }),
      isolation: current.isolation,
      timeout_ms: current.timeout_ms,
      applicability: current.applicability ?? { mode: "always" },
      required_context: current.required_context ?? [],
      ...(current.runtime === undefined ? {} : { runtime: current.runtime }),
    };
    expect(() => serializeManagedConfig(invalid)).toThrow(
      /unsupported claude effort ultra/i,
    );
  });

  it("validates each model run against its effective adapter", () => {
    const invalid = config();
    invalid.adapters.claude = { type: "claude" };
    invalid.agents.gemini = {
      adapter: "gateway",
      model_runs: [
        { id: "valid", model: "gateway-model", effort: "ultra" },
        {
          id: "invalid",
          adapter: "claude",
          model: "claude-model",
          effort: "ultra",
        },
      ],
      purpose: "Architecture",
      instructions: "Review architecture.",
      isolation: "prefer_enforced",
      timeout_ms: 900_000,
      applicability: { mode: "always" },
      required_context: [],
      allow_zero_outage_tolerance: true,
    };

    expect(() => serializeManagedConfig(invalid)).toThrow(
      /agent gemini model run invalid configures unsupported claude effort ultra/i,
    );
  });

  it("does not resolve inherited prototype names as configured agents or adapters", () => {
    const inheritedAgent = config();
    inheritedAgent.defaults = { agents: ["toString"] };
    expect(() => serializeManagedConfig(inheritedAgent)).toThrow(
      /unknown agent/i,
    );

    const inheritedAdapter = config();
    inheritedAdapter.agents.gemini!.adapter = "toString";
    expect(() => serializeManagedConfig(inheritedAdapter)).toThrow(
      /unknown adapter/i,
    );
  });

  it("rejects path-shaped and duplicate normalized project names before saving", () => {
    const pathShaped = config();
    pathShaped.projects = { "work/demo": { agents: ["gemini"] } };
    expect(() => serializeManagedConfig(pathShaped)).toThrow(/project name/i);

    const duplicate = config();
    duplicate.projects = {
      Demo: { agents: ["gemini"] },
      demo: { agents: ["gemini"] },
    };
    expect(() => serializeManagedConfig(duplicate)).toThrow(
      /duplicate normalized project name/i,
    );
  });

  it("rejects a serialized configuration above the read limit", () => {
    const oversized = config();
    oversized.agents.gemini!.instructions = "x".repeat(4 * 1024 * 1024);
    expect(() => serializeManagedConfig(oversized)).toThrow(/4 MiB/i);
  });
});
