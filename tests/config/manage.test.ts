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
import {
  canonicalProjectPath,
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
    schema_version: "3",
    execution: {
      max_concurrency: 2,
      heartbeat_interval_ms: 15_000,
      shutdown_grace_period_ms: 5_000,
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
      },
    },
    defaults: { agents: ["gemini"] },
    projects: {},
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("managed configuration", () => {
  it("round-trips a native v2 configuration", () => {
    const text = serializeManagedConfig(config());
    expect(parseManagedConfig(text)).toEqual({
      config: config(),
      migrated: false,
    });
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
    };

    const parsed = parseManagedConfig(serializeManagedConfig(multi));
    expect(parsed.config.agents.gemini).toEqual(multi.agents.gemini);
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
    };
    collision.agents["architecture::opus"] = {
      adapter: "gateway",
      model: "two",
      purpose: "Collision",
      instructions: "Review collisions.",
      isolation: "prefer_enforced",
      timeout_ms: 900_000,
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
    };
    expect(() => serializeManagedConfig(singleRun)).toThrow(/at least two/i);
  });

  it("migrates the ordered v1 roster into v2 default agents", () => {
    const legacy = `schema_version = "1"
[execution]
max_concurrency = 1
heartbeat_interval_ms = 100
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
    expect(result.config.agents["agent-one"]?.instructions).toBe(
      "base\n\nextra",
    );
  });

  it("reads scalar v2 configuration and promotes it to managed v3", () => {
    const legacyV2 = serializeManagedConfig(config()).replace(
      'schema_version = "3"',
      'schema_version = "2"',
    );
    const result = parseManagedConfig(legacyV2);
    expect(result.migrated).toBe(true);
    expect(result.config.schema_version).toBe("3");
    expect(result.config.agents.gemini).toMatchObject({
      model: "gemini-flash",
      effort: "high",
    });
  });

  it("writes a new file atomically and rejects a stale writer", async () => {
    const directory = await root();
    const file = join(directory, "nested", "config.toml");
    const loaded = await loadManagedConfig(file, true);
    const saved = await saveManagedConfig(file, config(), loaded.snapshot);
    expect(parseManagedConfig(await readFile(file, "utf8")).config).toEqual(
      config(),
    );
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

  it("canonicalizes existing project directories", async () => {
    const directory = await root();
    const project = join(directory, "Project");
    await mkdir(project);
    const actual = await canonicalProjectPath(project);
    expect(actual.includes("\\")).toBe(false);
    expect(
      actual.endsWith(process.platform === "win32" ? "/project" : "/Project"),
    ).toBe(true);
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

  it("rejects relative and duplicate normalized project keys before saving", () => {
    const relative = config();
    relative.projects = { relative: { agents: ["gemini"] } };
    expect(() => serializeManagedConfig(relative)).toThrow(/absolute/i);

    const root = process.platform === "win32" ? "C:\\Work\\Demo" : "/work/demo";
    const duplicate = config();
    duplicate.projects = {
      [root]: { agents: ["gemini"] },
      [`${root}${process.platform === "win32" ? "\\" : "/"}`]: {
        agents: ["gemini"],
      },
    };
    expect(() => serializeManagedConfig(duplicate)).toThrow(
      /duplicate normalized project path/i,
    );
  });

  it("rejects a serialized configuration above the read limit", () => {
    const oversized = config();
    oversized.agents.gemini!.instructions = "x".repeat(4 * 1024 * 1024);
    expect(() => serializeManagedConfig(oversized)).toThrow(/4 MiB/i);
  });
});
