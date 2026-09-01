import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  adapterRegistrationSchema,
  trustedConfigSchema,
  type TrustedConfigV2,
} from "../../src/config/schemas.js";
import { loadConfigFiles } from "../../src/config/load.js";
import { resolveConfig } from "../../src/config/resolve.js";
import { trustedConfig } from "../helpers/fixtures.js";

function v2(workspace: string): TrustedConfigV2 {
  return {
    schema_version: "2",
    execution: {
      max_concurrency: 2,
      heartbeat_interval_ms: 1_000,
      shutdown_grace_period_ms: 1_000,
    },
    diagnostics: { persist_runs: false, max_runs: 10 },
    adapters: {
      gateway: {
        type: "openai_compatible",
        base_url_env: "BASE_URL",
        api_key_env: "API_KEY",
      },
    },
    agents: {
      gemini: {
        adapter: "gateway",
        model: "gemini",
        purpose: "Review correctness",
        instructions: "Global instructions.",
        isolation: "prefer_enforced",
        timeout_ms: 60_000,
      },
      opus: {
        adapter: "gateway",
        model: "opus",
        purpose: "Review architecture",
        instructions: "Architecture instructions.",
        isolation: "prefer_enforced",
        timeout_ms: 60_000,
      },
    },
    defaults: { agents: ["opus"] },
    projects: {
      [workspace]: {
        agents: ["gemini"],
        instructions: "Project guidance.",
        context: { project: "demo" },
      },
    },
  };
}

describe("global configuration", () => {
  it("keeps v1 trusted configs as global defaults", () => {
    expect(resolveConfig({ trusted: trustedConfig() }).reviewers[0]?.id).toBe(
      "baseline",
    );
  });

  it("selects an exact project agent roster and trusted project guidance", () => {
    const workspace =
      process.platform === "win32" ? "C:\\work\\demo" : "/work/demo";
    const resolved = resolveConfig({ trusted: v2(workspace), workspace });
    expect(resolved.reviewers.map((reviewer) => reviewer.id)).toEqual([
      "gemini",
    ]);
    expect(resolved.reviewers[0]?.instruction_layers).toEqual([
      { source: "trusted", content: "Global instructions." },
      { source: "project", content: "Project guidance." },
    ]);
    expect(resolved.project_context).toEqual({ project: "demo" });
  });

  it("uses the most-specific configured project containing the workspace", () => {
    const root = process.platform === "win32" ? "C:\\work\\mono" : "/work/mono";
    const nested = join(root, "packages", "api");
    const config = v2(root);
    config.projects![nested] = { agents: ["opus"] };
    expect(
      resolveConfig({
        trusted: config,
        workspace: join(nested, "src"),
      }).reviewers.map(({ id }) => id),
    ).toEqual(["opus"]);
    expect(
      resolveConfig({
        trusted: config,
        workspace: join(root, "packages", "web"),
      }).reviewers.map(({ id }) => id),
    ).toEqual(["gemini"]);
  });

  it("does not confuse path-component prefixes", () => {
    const configured =
      process.platform === "win32" ? "C:\\work\\app" : "/work/app";
    const sibling =
      process.platform === "win32"
        ? "C:\\work\\application"
        : "/work/application";
    expect(
      resolveConfig({
        trusted: v2(configured),
        workspace: sibling,
      }).reviewers.map(({ id }) => id),
    ).toEqual(["opus"]);
  });

  it("uses defaults for unmatched projects and rejects missing selection", () => {
    const configured =
      process.platform === "win32" ? "C:\\work\\demo" : "/work/demo";
    const other =
      process.platform === "win32" ? "C:\\work\\other" : "/work/other";
    expect(
      resolveConfig({
        trusted: v2(configured),
        workspace: other,
      }).reviewers.map((reviewer) => reviewer.id),
    ).toEqual(["opus"]);
    const withoutDefaults = v2(configured);
    delete withoutDefaults.defaults;
    expect(() =>
      resolveConfig({ trusted: withoutDefaults, workspace: other }),
    ).toThrow(/no agents/i);
    const emptyProject = v2(configured);
    emptyProject.projects![configured] = { agents: [] };
    expect(() =>
      resolveConfig({ trusted: emptyProject, workspace: configured }),
    ).toThrow(/array|agent/i);
  });

  it("rejects relative project paths, duplicate agents, and unknown references", () => {
    expect(() =>
      trustedConfigSchema.parse({
        ...v2("relative"),
        projects: { relative: { agents: ["gemini"] } },
      }),
    ).not.toThrow();
    expect(() =>
      resolveConfig({ trusted: v2("relative"), workspace: "relative" }),
    ).toThrow(/absolute/i);
    expect(() =>
      trustedConfigSchema.parse({
        ...v2("/demo"),
        defaults: { agents: ["opus", "opus"] },
      }),
    ).toThrow(/unique/i);
    expect(() =>
      resolveConfig({
        trusted: { ...v2("/demo"), defaults: { agents: ["missing"] } },
        workspace: "/other",
      }),
    ).toThrow(/unknown/i);
  });

  it("accepts only the trusted OpenAI-compatible registration shape", () => {
    expect(
      adapterRegistrationSchema.parse({
        type: "openai_compatible",
        base_url_env: "BASE_URL",
        api_key_env: "API_KEY",
      }),
    ).toBeTruthy();
  });
});

describe("loadConfigFiles", () => {
  it("loads v2 global/project instruction files and ignores workspace policy", async () => {
    const root = await mkdtemp(
      join(process.env.TEMP ?? "C:\\Temp", "mesh-config-"),
    );
    const configDirectory = join(root, "config");
    const workspace = join(root, "workspace");
    await mkdir(configDirectory);
    await mkdir(workspace);
    await writeFile(join(configDirectory, "agent.md"), "Agent instructions.");
    await writeFile(
      join(configDirectory, "project.md"),
      "Project instructions.",
    );
    await writeFile(join(workspace, ".review-mesh.toml"), "invalid = [");
    const projectKey = (await realpath(workspace)).replaceAll("\\", "/");
    await writeFile(
      join(configDirectory, "config.toml"),
      `schema_version = "2"
[execution]
max_concurrency = 1
heartbeat_interval_ms = 1000
shutdown_grace_period_ms = 1000
[diagnostics]
persist_runs = false
max_runs = 1
[adapters.command]
type = "command"
command = "reviewer"
protocol = "review-mesh-command-v1"
[agents.agent]
adapter = "command"
model = "model"
purpose = "Review"
instructions_file = "agent.md"
isolation = "prefer_enforced"
timeout_ms = 1000
[projects."${projectKey}"]
agents = ["agent"]
instructions_file = "project.md"
`,
    );
    try {
      const loaded = await loadConfigFiles({
        configFile: join(configDirectory, "config.toml"),
        workspace,
      });
      expect(loaded.trusted.schema_version).toBe("2");
      const resolved = resolveConfig(loaded);
      expect(resolved.reviewers[0]?.instruction_layers).toEqual([
        { source: "trusted", content: "Agent instructions." },
        { source: "project", content: "Project instructions." },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not let a stale unrelated project disable defaults", async () => {
    const root = await mkdtemp(
      join(process.env.TEMP ?? "C:\\Temp", "mesh-config-stale-"),
    );
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const missing = join(root, "missing-project").replaceAll("\\", "/");
    await writeFile(
      join(root, "config.toml"),
      `schema_version = "2"
[execution]
max_concurrency = 1
heartbeat_interval_ms = 1000
shutdown_grace_period_ms = 1000
[diagnostics]
persist_runs = false
max_runs = 1
[adapters.command]
type = "command"
command = "reviewer"
protocol = "review-mesh-command-v1"
[agents.agent]
adapter = "command"
model = "model"
purpose = "Review"
instructions = "Review carefully."
isolation = "prefer_enforced"
timeout_ms = 1000
[defaults]
agents = ["agent"]
[projects."${missing}"]
agents = ["agent"]
`,
    );
    try {
      const loaded = await loadConfigFiles({
        configFile: join(root, "config.toml"),
        workspace,
      });
      expect(resolveConfig(loaded).reviewers.map(({ id }) => id)).toEqual([
        "agent",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects escaping instruction files and bounds a stuck trusted read", async () => {
    const root = await mkdtemp(
      join(process.env.TEMP ?? "C:\\Temp", "mesh-config-"),
    );
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(root, "..", "outside.md"), "outside");
    await writeFile(
      join(root, "config.toml"),
      `schema_version = "1"
[execution]
max_concurrency = 1
heartbeat_interval_ms = 1000
shutdown_grace_period_ms = 1000
[diagnostics]
persist_runs = false
max_runs = 1
[adapters.command]
type = "command"
command = "reviewer"
protocol = "review-mesh-command-v1"
[reviewer_profiles.agent]
adapter = "command"
model = "model"
purpose = "Review"
instructions_file = "../outside.md"
isolation = "prefer_enforced"
timeout_ms = 1000
[[reviewers]]
id = "agent"
profile = "agent"
`,
    );
    try {
      await expect(
        loadConfigFiles({ configFile: join(root, "config.toml"), workspace }),
      ).rejects.toThrow(/escape/i);
      await expect(
        loadConfigFiles(
          { configFile: join(root, "config.toml"), workspace },
          {
            readTimeoutMs: 10,
            trustedRead: async () => await new Promise<never>(() => undefined),
          },
        ),
      ).rejects.toThrow(/timed out/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
