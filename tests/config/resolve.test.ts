import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  adapterRegistrationSchema,
  trustedConfigSchema,
  type TrustedConfigV2,
  type TrustedConfigV3,
  type TrustedConfigV4,
  type TrustedConfigV5,
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
        effort: "high",
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

function v3(workspace: string): TrustedConfigV3 {
  return { ...v2(workspace), schema_version: "3" };
}

function v4(projectName: string): TrustedConfigV4 {
  const legacy = v3("/legacy/path");
  return {
    ...legacy,
    schema_version: "4",
    projects: {
      [projectName]: legacy.projects!["/legacy/path"]!,
    },
  };
}

function v5(projectName: string): TrustedConfigV5 {
  const legacy = v4(projectName);
  return {
    ...legacy,
    schema_version: "5",
    execution: { ...legacy.execution },
  };
}

describe("global configuration", () => {
  it("resolves v7 execution and lens prerequisite and coverage policies", () => {
    const legacy = v5("demo");
    const config = {
      ...legacy,
      schema_version: "7" as const,
      execution: {
        ...legacy.execution,
        deadline_mode: "adaptive" as const,
        no_progress_timeout_ms: 300_000,
      },
      agents: {
        readiness: {
          ...Object.values(legacy.agents)[0]!,
          kind: "generic" as const,
          applicability: { mode: "always" as const },
          required_input: ["/context/ticket"],
          lens_deadline_ms: 600_000,
          change_coverage: {
            relevant_paths: ["**"],
            minimum_inspection: "full_file" as const,
            proof: "observed" as const,
          },
        },
      },
      defaults: { agents: ["readiness"] },
      projects: {},
    };
    const resolved = resolveConfig({ trusted: config });
    expect(resolved.execution).toMatchObject({
      deadline_mode: "adaptive",
      no_progress_timeout_ms: 300_000,
    });
    expect(resolved.reviewers[0]?.policy).toMatchObject({
      kind: "generic",
      lensDeadlineMs: 600_000,
      requiredInput: ["/context/ticket"],
      changeCoverage: {
        relevantPaths: ["**"],
        minimumInspection: "full_file",
        proof: "observed",
      },
    });
  });
  it("resolves explicit continuation attempts and preserves the legacy default of two", () => {
    const legacyBase = v5("demo");
    const legacyAgent = Object.values(legacyBase.agents)[0]!;
    const configured = {
      ...legacyBase,
      schema_version: "6" as const,
      execution: { ...legacyBase.execution, continuation_attempts: 4 },
      agents: {
        reviewer: {
          ...legacyAgent,
          applicability: { mode: "always" as const },
          required_context: [],
        },
      },
      defaults: { agents: ["reviewer"] },
      projects: {},
    };
    expect(
      resolveConfig({ trusted: configured, projectName: "demo" }).execution
        .continuation_attempts,
    ).toBe(4);

    const legacy = v5("demo");
    expect(
      resolveConfig({ trusted: legacy, projectName: "demo" }).execution
        .continuation_attempts,
    ).toBe(2);
  });

  it("defaults a five-model v6 lens to a resilient three-by-three quorum", () => {
    const config = {
      schema_version: "6",
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
        resilience: {
          adapter: "gateway",
          model_runs: ["one", "two", "three", "four", "five"].map((id) => ({
            id,
            model: id,
            provider_group: id,
          })),
          purpose: "Resilient review",
          instructions: "Review.",
          isolation: "prefer_enforced",
          timeout_ms: 60_000,
          applicability: { mode: "always" },
          required_context: [],
        },
      },
      defaults: { agents: ["resilience"] },
      projects: {},
    };

    const resolved = resolveConfig({ trusted: config as never });
    expect(resolved.reviewers[0]?.policy).toMatchObject({
      applicability: { mode: "always" },
      requiredCallerContext: [],
      passQuorum: 3,
      minimumProviderGroups: 3,
      allowZeroOutageTolerance: false,
    });
  });

  it("distributes v6 primaries and defaults new streaming while legacy remains disabled", () => {
    const current = {
      ...v5("demo"),
      schema_version: "6",
      agents: {
        first: {
          adapter: "gateway",
          model_runs: [
            { id: "one", model: "one", provider_group: "one" },
            { id: "two", model: "two", provider_group: "two" },
          ],
          purpose: "First",
          instructions: "Review.",
          isolation: "prefer_enforced",
          timeout_ms: 60_000,
          applicability: { mode: "always" },
          required_context: [],
          allow_zero_outage_tolerance: true,
        },
        second: {
          adapter: "gateway",
          model_runs: [
            { id: "one", model: "one", provider_group: "one" },
            { id: "two", model: "two", provider_group: "two" },
          ],
          purpose: "Second",
          instructions: "Review.",
          isolation: "prefer_enforced",
          timeout_ms: 60_000,
          applicability: { mode: "always" },
          required_context: [],
          allow_zero_outage_tolerance: true,
        },
      },
      defaults: { agents: ["first", "second"] },
      projects: {},
    };
    const resolvedCurrent = resolveConfig({ trusted: current as never });
    expect(resolvedCurrent.reviewers.map(({ id }) => id)).toEqual([
      "first::one",
      "first::two",
      "second::two",
      "second::one",
    ]);
    expect(resolvedCurrent.reviewers[0]?.adapter).toMatchObject({
      type: "openai_compatible",
      streaming: "auto",
    });

    const resolvedLegacy = resolveConfig({ trusted: v5("demo") });
    expect(resolvedLegacy.reviewers[0]?.adapter).toMatchObject({
      type: "openai_compatible",
      streaming: "disabled",
    });
  });

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
    expect(resolved.reviewers[0]?.effort).toBe("high");
    expect(resolved.project_context).toEqual({ project: "demo" });
    expect(resolved.selection).toEqual({
      source: "project",
      matchedProjectName: "demo",
    });
  });

  it("expands one logical agent into ordered model-run reviewers", () => {
    const workspace =
      process.platform === "win32" ? "C:\\work\\demo" : "/work/demo";
    const config = v3(workspace);
    config.adapters.claude = { type: "claude" };
    config.agents.gemini = {
      adapter: "gateway",
      model_runs: [
        { id: "opus", model: "claude-opus", effort: "high" },
        {
          id: "grok",
          adapter: "claude",
          model: "grok-code",
          effort: "max",
        },
      ],
      purpose: "Review architecture",
      instructions: "Global instructions.",
      isolation: "prefer_enforced",
      timeout_ms: 60_000,
    };

    const resolved = resolveConfig({ trusted: config, workspace });
    expect(
      resolved.reviewers.map(
        ({
          id,
          agentId,
          modelIndex,
          modelCount,
          previousReviewerId,
          adapterId,
          model,
          effort,
        }) => ({
          id,
          agentId,
          modelIndex,
          modelCount,
          previousReviewerId,
          adapterId,
          model,
          effort,
        }),
      ),
    ).toEqual([
      {
        id: "gemini::opus",
        agentId: "gemini",
        modelIndex: 0,
        modelCount: 2,
        previousReviewerId: undefined,
        adapterId: "gateway",
        model: "claude-opus",
        effort: "high",
      },
      {
        id: "gemini::grok",
        agentId: "gemini",
        modelIndex: 1,
        modelCount: 2,
        previousReviewerId: "gemini::opus",
        adapterId: "claude",
        model: "grok-code",
        effort: "max",
      },
    ]);
    expect(resolved.reviewers[0]?.instruction_layers).toEqual([
      { source: "trusted", content: "Global instructions." },
      { source: "project", content: "Project guidance." },
    ]);
    expect(resolved.reviewers[1]?.instruction_layers).toEqual(
      resolved.reviewers[0]?.instruction_layers,
    );
  });

  it("rotates multi-model primaries deterministically across logical lenses", () => {
    const config = v5("demo");
    config.adapters.a = {
      type: "command",
      command: "a",
      protocol: "review-mesh-command-v1",
    };
    config.adapters.b = {
      type: "command",
      command: "b",
      protocol: "review-mesh-command-v1",
    };
    config.adapters.c = {
      type: "command",
      command: "c",
      protocol: "review-mesh-command-v1",
    };
    const profile = {
      adapter: "a",
      model_runs: [
        { id: "a", adapter: "a", model: "model-a" },
        { id: "b", adapter: "b", model: "model-b" },
        { id: "c", adapter: "c", model: "model-c" },
      ],
      purpose: "Distributed review",
      instructions: "Review carefully.",
      isolation: "prefer_enforced" as const,
      timeout_ms: 60_000,
    };
    config.agents = {
      first: structuredClone(profile),
      second: structuredClone(profile),
      third: structuredClone(profile),
      fourth: structuredClone(profile),
    };
    config.defaults = { agents: ["first", "second", "third", "fourth"] };
    config.projects = {};

    const resolved = resolveConfig({
      trusted: config,
      projectName: "demo",
    });
    const orders = new Map<string, string[]>();
    for (const reviewer of resolved.reviewers) {
      const id = reviewer.agentId ?? reviewer.id;
      orders.set(id, [...(orders.get(id) ?? []), reviewer.id]);
    }
    expect(resolved.execution.distribute_primaries).toBe(true);
    expect([...orders.values()]).toEqual([
      ["first::a", "first::b", "first::c"],
      ["second::b", "second::c", "second::a"],
      ["third::c", "third::a", "third::b"],
      ["fourth::a", "fourth::b", "fourth::c"],
    ]);
    expect(
      resolved.reviewers.map((reviewer) => ({
        id: reviewer.id,
        modelIndex: reviewer.modelIndex,
        configuredModelIndex: reviewer.configuredModelIndex,
        previousReviewerId: reviewer.previousReviewerId,
      })),
    ).toEqual([
      { id: "first::a", modelIndex: 0, configuredModelIndex: 0 },
      {
        id: "first::b",
        modelIndex: 1,
        configuredModelIndex: 1,
        previousReviewerId: "first::a",
      },
      {
        id: "first::c",
        modelIndex: 2,
        configuredModelIndex: 2,
        previousReviewerId: "first::b",
      },
      { id: "second::b", modelIndex: 0, configuredModelIndex: 1 },
      {
        id: "second::c",
        modelIndex: 1,
        configuredModelIndex: 2,
        previousReviewerId: "second::b",
      },
      {
        id: "second::a",
        modelIndex: 2,
        configuredModelIndex: 0,
        previousReviewerId: "second::c",
      },
      { id: "third::c", modelIndex: 0, configuredModelIndex: 2 },
      {
        id: "third::a",
        modelIndex: 1,
        configuredModelIndex: 0,
        previousReviewerId: "third::c",
      },
      {
        id: "third::b",
        modelIndex: 2,
        configuredModelIndex: 1,
        previousReviewerId: "third::a",
      },
      { id: "fourth::a", modelIndex: 0, configuredModelIndex: 0 },
      {
        id: "fourth::b",
        modelIndex: 1,
        configuredModelIndex: 1,
        previousReviewerId: "fourth::a",
      },
      {
        id: "fourth::c",
        modelIndex: 2,
        configuredModelIndex: 2,
        previousReviewerId: "fourth::b",
      },
    ]);
  });

  it("preserves configured model-run order when primary distribution is disabled", () => {
    const config = v5("demo");
    config.execution.distribute_primaries = false;
    config.agents = {
      first: {
        adapter: "gateway",
        model_runs: [
          { id: "one", model: "one" },
          { id: "two", model: "two" },
        ],
        purpose: "First",
        instructions: "Review.",
        isolation: "prefer_enforced",
        timeout_ms: 60_000,
      },
      second: {
        adapter: "gateway",
        model_runs: [
          { id: "one", model: "one" },
          { id: "two", model: "two" },
        ],
        purpose: "Second",
        instructions: "Review.",
        isolation: "prefer_enforced",
        timeout_ms: 60_000,
      },
    };
    config.defaults = { agents: ["first", "second"] };
    config.projects = {};

    const resolved = resolveConfig({ trusted: config, projectName: "demo" });
    expect(resolved.execution.distribute_primaries).toBe(false);
    expect(resolved.reviewers.map((reviewer) => reviewer.id)).toEqual([
      "first::one",
      "first::two",
      "second::one",
      "second::two",
    ]);
  });

  it("does not let scalar lenses consume a primary-rotation slot", () => {
    const config = v5("demo");
    const rotating = {
      adapter: "gateway",
      model_runs: [
        { id: "one", model: "one" },
        { id: "two", model: "two" },
      ],
      purpose: "Rotating",
      instructions: "Review.",
      isolation: "prefer_enforced" as const,
      timeout_ms: 60_000,
    };
    config.agents = {
      first: structuredClone(rotating),
      scalar: {
        adapter: "gateway",
        model: "scalar",
        purpose: "Scalar",
        instructions: "Review.",
        isolation: "prefer_enforced",
        timeout_ms: 60_000,
      },
      second: structuredClone(rotating),
    };
    config.defaults = { agents: ["first", "scalar", "second"] };
    config.projects = {};

    const resolved = resolveConfig({ trusted: config, projectName: "demo" });
    expect(resolved.reviewers.map((reviewer) => reviewer.id)).toEqual([
      "first::one",
      "first::two",
      "scalar",
      "second::two",
      "second::one",
    ]);
  });

  it("selects v4 project settings by name regardless of workspace path", () => {
    const config = v4("Review-Mesh");
    const resolved = resolveConfig({
      trusted: config,
      workspace: "/unrelated/clone/location",
      projectName: "review-mesh",
      projectNameSource: "git_remote",
    });
    expect(resolved.reviewers.map(({ id }) => id)).toEqual(["gemini"]);
    expect(resolved.execution.distribute_primaries).toBe(false);
    expect(resolved.selection).toEqual({
      source: "project",
      projectName: "review-mesh",
      projectNameSource: "git_remote",
      matchedProjectName: "Review-Mesh",
    });
  });

  it("keeps legacy v2 path selection readable during migration", () => {
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
    expect(
      resolveConfig({ trusted: v2(configured), workspace: other }).selection,
    ).toEqual({ source: "defaults" });
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
    for (const streaming of ["auto", "required", "disabled"] as const) {
      expect(
        adapterRegistrationSchema.parse({
          type: "openai_compatible",
          base_url_env: "BASE_URL",
          api_key_env: "API_KEY",
          streaming,
        }),
      ).toMatchObject({ streaming });
    }
    expect(() =>
      adapterRegistrationSchema.parse({
        type: "openai_compatible",
        base_url_env: "BASE_URL",
        api_key_env: "API_KEY",
        streaming: "sometimes",
      }),
    ).toThrow();
  });

  it("preserves the selected OpenAI streaming mode on resolved reviewers", () => {
    const config = v2("/demo");
    config.adapters.gateway = {
      type: "openai_compatible",
      base_url_env: "BASE_URL",
      api_key_env: "API_KEY",
      streaming: "required",
    };
    const resolved = resolveConfig({ trusted: config, workspace: "/other" });
    expect(resolved.reviewers[0]?.adapter).toMatchObject({
      type: "openai_compatible",
      streaming: "required",
    });
  });

  it("rejects adapter-specific effort values that cannot be forwarded", () => {
    const config = v2("/demo");
    config.adapters.claude = { type: "claude" };
    config.agents.opus = {
      ...config.agents.opus!,
      adapter: "claude",
      effort: "ultra",
    };
    expect(() =>
      resolveConfig({ trusted: config, workspace: "/other" }),
    ).toThrow(/unsupported claude effort ultra/i);
  });

  it("rejects model-run adapter errors and expanded id collisions", () => {
    const unknownAdapter = v3("/demo");
    unknownAdapter.agents.opus = {
      adapter: "gateway",
      model_runs: [
        { id: "default", model: "one" },
        { id: "other", adapter: "missing", model: "two" },
      ],
      purpose: "Review architecture",
      instructions: "Architecture instructions.",
      isolation: "prefer_enforced",
      timeout_ms: 60_000,
    };
    expect(() =>
      resolveConfig({ trusted: unknownAdapter, workspace: "/other" }),
    ).toThrow(/model run other references unknown adapter missing/i);

    const invalidEffort = v3("/demo");
    invalidEffort.adapters.claude = { type: "claude" };
    invalidEffort.agents.opus = {
      adapter: "gateway",
      model_runs: [
        {
          id: "claude",
          adapter: "claude",
          model: "claude-model",
          effort: "ultra",
        },
        { id: "gateway", model: "gateway-model" },
      ],
      purpose: "Review architecture",
      instructions: "Architecture instructions.",
      isolation: "prefer_enforced",
      timeout_ms: 60_000,
    };
    expect(() =>
      resolveConfig({ trusted: invalidEffort, workspace: "/other" }),
    ).toThrow(/model run claude configures unsupported claude effort ultra/i);

    const collision = v3("/demo");
    collision.agents.architecture = {
      adapter: "gateway",
      model_runs: [
        { id: "opus", model: "one" },
        { id: "grok", model: "two" },
      ],
      purpose: "Review architecture",
      instructions: "Architecture instructions.",
      isolation: "prefer_enforced",
      timeout_ms: 60_000,
    };
    collision.agents["architecture::opus"] = {
      adapter: "gateway",
      model: "two",
      purpose: "Collision",
      instructions: "Collision instructions.",
      isolation: "prefer_enforced",
      timeout_ms: 60_000,
    };
    expect(() =>
      resolveConfig({ trusted: collision, workspace: "/other" }),
    ).toThrow(/expanded reviewer id collision/i);
  });
});

describe("loadConfigFiles", () => {
  it("migrates v1 into explicit v6 policy without changing legacy order or streaming", async () => {
    const root = await mkdtemp(
      join(process.env.TEMP ?? "C:\\Temp", "mesh-config-v1-"),
    );
    const workspace = join(root, "workspace");
    await mkdir(workspace);
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
[adapters.gateway]
type = "openai_compatible"
base_url_env = "BASE"
api_key_env = "KEY"
[reviewer_profiles.first]
adapter = "gateway"
model = "one"
purpose = "First"
instructions = "Review first."
isolation = "prefer_enforced"
timeout_ms = 1000
[reviewer_profiles.second]
adapter = "gateway"
model = "two"
purpose = "Second"
instructions = "Review second."
isolation = "prefer_enforced"
timeout_ms = 1000
[[reviewers]]
id = "first"
profile = "first"
[[reviewers]]
id = "second"
profile = "second"
`,
    );
    try {
      const loaded = await loadConfigFiles({
        configFile: join(root, "config.toml"),
        workspace,
      });
      expect(loaded.trusted.schema_version).toBe("7");
      expect(loaded.migrated).toBe(true);
      expect(loaded.migrationWarnings.map(({ code }) => code)).toEqual([
        "implicit_v9_deadline",
        "implicit_v9_change_coverage",
      ]);
      const resolved = resolveConfig(loaded);
      expect(resolved.sourceSchemaVersion).toBe("1");
      expect(resolved.migrationWarnings).toEqual(loaded.migrationWarnings);
      expect(resolved.execution.distribute_primaries).toBe(false);
      expect(resolved.reviewers.map(({ id }) => id)).toEqual([
        "first",
        "second",
      ]);
      expect(resolved.reviewers[0]).toMatchObject({
        adapter: { type: "openai_compatible", streaming: "disabled" },
        policy: {
          applicability: { mode: "always" },
          requiredCallerContext: [],
          passQuorum: 1,
          minimumProviderGroups: 1,
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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
      expect(loaded.trusted.schema_version).toBe("7");
      expect(loaded.migrationWarnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "attested_coverage_requires_adapter_upgrade",
            lens_ids: ["agent"],
          }),
        ]),
      );
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
