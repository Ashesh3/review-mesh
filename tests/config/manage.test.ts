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
    schema_version: "2",
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
    invalid.agents.gemini = {
      ...invalid.agents.gemini!,
      adapter: "claude",
      effort: "ultra",
    };
    expect(() => serializeManagedConfig(invalid)).toThrow(
      /unsupported claude effort ultra/i,
    );
  });
});
