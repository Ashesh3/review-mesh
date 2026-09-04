import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { CopilotAccountService } from "../../src/copilot/account.js";
import {
  loadManagedConfig,
  normalizeManagedConfig,
  serializeManagedConfig,
  type ManagedConfig,
} from "../../src/config/manage.js";
import { runConfigMenu, type ConfigPrompter } from "../../src/config/tui.js";

const roots: string[] = [];

class Answers implements ConfigPrompter {
  closed = false;
  constructor(private readonly answers: string[]) {}
  async ask(_question: string, _signal?: AbortSignal): Promise<string> {
    const value = this.answers.shift();
    if (value === undefined) throw new Error("test ran out of answers");
    return value;
  }
  close(): void {
    this.closed = true;
  }
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("config menu", () => {
  it("logs in, discovers Copilot models, and stores model plus effort", async () => {
    const directory = await mkdtemp(join(tmpdir(), "review-mesh-config-tui-"));
    roots.push(directory);
    const file = join(directory, "config.toml");
    const loaded = await loadManagedConfig(file, true);
    let authenticated = false;
    const copilotAccount: CopilotAccountService = {
      status: async () => ({
        isAuthenticated: authenticated,
        runtimeVersion: "1.0.11",
      }),
      login: async () => {
        authenticated = true;
      },
      models: async () => ({
        status: {
          isAuthenticated: authenticated,
          ...(authenticated ? { login: "octocat" } : {}),
          runtimeVersion: "1.0.11",
        },
        models: authenticated
          ? [
              {
                id: "gpt-test",
                name: "GPT Test",
                capabilities: { supports: { reasoningEffort: true } },
                policy: { state: "enabled" },
                supportedReasoningEfforts: ["low", "high"],
              },
            ]
          : [],
      }),
    };
    const prompt = new Answers([
      "a",
      "copilot-reviewer",
      "new",
      "github",
      "copilot",
      "single",
      "y",
      "gpt-test",
      "high",
      "Independent review",
      "Review correctness.",
      "900000",
      "n",
      "q",
    ]);

    await runConfigMenu({
      configFile: file,
      config: loaded.config,
      snapshot: loaded.snapshot,
      prompt,
      output: new PassThrough(),
      copilotAccount,
    });

    const saved = (await loadManagedConfig(file)).config;
    expect(saved.adapters.github).toEqual({
      type: "copilot",
      use_logged_in_user: true,
    });
    expect(saved.agents["copilot-reviewer"]).toMatchObject({
      adapter: "github",
      model: "gpt-test",
      effort: "high",
      applicability: { mode: "always" },
      required_input: [],
    });
  });

  it("adds a multi-model agent with inherited and Copilot run adapters", async () => {
    const directory = await mkdtemp(join(tmpdir(), "review-mesh-config-tui-"));
    roots.push(directory);
    const file = join(directory, "config.toml");
    const loaded = await loadManagedConfig(file, true);
    loaded.config.adapters = {
      gateway: {
        type: "openai_compatible",
        base_url_env: "BASE",
        api_key_env: "KEY",
      },
      github: { type: "copilot", use_logged_in_user: true },
    };
    const copilotAccount: CopilotAccountService = {
      status: async () => ({
        isAuthenticated: true,
        runtimeVersion: "1.0.11",
      }),
      login: async () => undefined,
      models: async () => ({
        status: { isAuthenticated: true, runtimeVersion: "1.0.11" },
        models: [
          {
            id: "grok-test",
            name: "Grok Test",
            capabilities: { supports: { reasoningEffort: true } },
            policy: { state: "enabled" },
            supportedReasoningEfforts: ["high"],
          },
        ],
      }),
    };
    const prompt = new Answers([
      "a",
      "architecture",
      "gateway",
      "multi",
      "2",
      "opus",
      "inherit",
      "claude-opus-test",
      "max",
      "grok",
      "existing",
      "github",
      "grok-test",
      "high",
      "Architecture review",
      "Review architecture and trust boundaries.",
      "900000",
      "n",
      "y",
      "q",
    ]);

    await runConfigMenu({
      configFile: file,
      config: loaded.config,
      snapshot: loaded.snapshot,
      prompt,
      output: new PassThrough(),
      copilotAccount,
    });

    expect(
      (await loadManagedConfig(file)).config.agents.architecture,
    ).toMatchObject({
      adapter: "gateway",
      model_runs: [
        { id: "opus", model: "claude-opus-test", effort: "max" },
        {
          id: "grok",
          adapter: "github",
          model: "grok-test",
          effort: "high",
        },
      ],
      purpose: "Architecture review",
      instructions: "Review architecture and trust boundaries.",
      isolation: "prefer_enforced",
      timeout_ms: 900000,
      pass_quorum: 2,
      minimum_provider_groups: 2,
      applicability: { mode: "always" },
      required_input: [],
      kind: "generic",
      change_coverage: { proof: "observed" },
      allow_zero_outage_tolerance: true,
    });
  });

  it("creates a five-model two-provider lens directly with a three-by-two acknowledged policy", async () => {
    const directory = await mkdtemp(join(tmpdir(), "review-mesh-config-tui-"));
    roots.push(directory);
    const file = join(directory, "config.toml");
    const loaded = await loadManagedConfig(file, true);
    loaded.config.adapters.gateway = {
      type: "openai_compatible",
      base_url_env: "BASE",
      api_key_env: "KEY",
    };
    loaded.config.adapters.secondary = {
      type: "command",
      command: "secondary-reviewer",
      protocol: "review-mesh-command-v1",
    };
    await runConfigMenu({
      configFile: file,
      config: loaded.config,
      snapshot: loaded.snapshot,
      prompt: new Answers([
        "a",
        "resilience",
        "gateway",
        "multi",
        "5",
        "one",
        "inherit",
        "one",
        "high",
        "two",
        "inherit",
        "two",
        "high",
        "three",
        "inherit",
        "three",
        "high",
        "four",
        "existing",
        "secondary",
        "four",
        "high",
        "five",
        "existing",
        "secondary",
        "five",
        "high",
        "Resilience",
        "Review resilience.",
        "900000",
        "n",
        "y",
        "y",
        "q",
        "q",
      ]),
      output: new PassThrough(),
    });

    expect(
      (await loadManagedConfig(file)).config.agents.resilience,
    ).toMatchObject({
      pass_quorum: 3,
      minimum_provider_groups: 2,
      allow_zero_outage_tolerance: true,
      applicability: { mode: "always" },
      required_input: [],
    });
  });

  it("adds the first agent, then assigns it to a project name", async () => {
    const directory = await mkdtemp(join(tmpdir(), "review-mesh-config-tui-"));
    roots.push(directory);
    const project = join(directory, "project");
    await mkdir(project);
    const file = join(directory, "config.toml");
    const loaded = await loadManagedConfig(file, true);
    const output = new PassThrough();
    const prompt = new Answers([
      "a",
      "gemini",
      "new",
      "gateway",
      "openai_compatible",
      "REVIEW_BASE_URL",
      "REVIEW_API_KEY",
      "auto",
      "single",
      "gemini-flash",
      "high",
      "Correctness",
      "Review carefully",
      "900000",
      "n",
      "p",
      "project",
      "gemini",
      "Project focus",
      '{"team":"core"}',
      "q",
    ]);
    await runConfigMenu({
      configFile: file,
      config: loaded.config,
      snapshot: loaded.snapshot,
      prompt,
      output,
    });
    expect(prompt.closed).toBe(true);
    const saved = await loadManagedConfig(file);
    expect(saved.config.defaults?.agents).toEqual(["gemini"]);
    expect(saved.config.agents.gemini?.effort).toBe("high");
    expect(saved.config.agents.gemini).toMatchObject({
      applicability: { mode: "always" },
      required_input: [],
    });
    expect(saved.config.adapters.gateway).toMatchObject({
      type: "openai_compatible",
      streaming: "auto",
    });
    expect(Object.values(saved.config.projects ?? {})).toEqual([
      {
        agents: ["gemini"],
        instructions: "Project focus",
        context: { team: "core" },
      },
    ]);
  });

  it("edits an agent, project assignment, and global settings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "review-mesh-config-tui-"));
    roots.push(directory);
    const project = join(directory, "project");
    await mkdir(project);
    const file = join(directory, "config.toml");
    const initial: ManagedConfig = {
      schema_version: "5",
      execution: {
        max_concurrency: 1,
        heartbeat_interval_ms: 1_000,
        shutdown_grace_period_ms: 100,
      },
      diagnostics: { persist_runs: true, max_runs: 2 },
      adapters: {
        gateway: {
          type: "openai_compatible",
          base_url_env: "BASE",
          api_key_env: "KEY",
        },
      },
      agents: {
        one: {
          adapter: "gateway",
          model: "model-one",
          purpose: "one",
          instructions: "one",
          isolation: "prefer_enforced",
          timeout_ms: 1000,
        },
        two: {
          adapter: "gateway",
          model: "model-two",
          purpose: "two",
          instructions: "two",
          isolation: "prefer_enforced",
          timeout_ms: 1000,
        },
      },
      defaults: { agents: ["one"] },
      projects: {
        project: {
          agents: ["one"],
          instructions: "Original project focus",
          context: { tier: 1 },
        },
      },
    };
    await writeFile(
      file,
      serializeManagedConfig(normalizeManagedConfig(initial)),
    );
    const loaded = await loadManagedConfig(file);
    const output = new PassThrough();
    let transcript = "";
    output.on("data", (chunk) => (transcript += chunk.toString()));
    const prompt = new Answers([
      "e",
      "two",
      "gateway",
      "single",
      "model-two-new",
      "xhigh",
      "Purpose two new",
      "New agent instructions",
      "require_enforced",
      "2000",
      "y",
      "o",
      "project",
      "two",
      "Edited project focus",
      '{"tier":2}',
      "s",
      "3",
      "2000",
      "300",
      "n",
      "y",
      "4",
      "n",
      "7",
      "g",
      "two,one",
      "q",
    ]);
    await runConfigMenu({
      configFile: file,
      config: loaded.config,
      snapshot: loaded.snapshot,
      prompt,
      output,
    });

    const saved = (await loadManagedConfig(file)).config;
    expect(saved.agents.two).toMatchObject({
      adapter: "gateway",
      model: "model-two-new",
      effort: "xhigh",
      purpose: "Purpose two new",
      instructions: "New agent instructions",
      isolation: "require_enforced",
      timeout_ms: 2000,
    });
    expect(saved.defaults?.agents).toEqual(["two", "one"]);
    expect(transcript).not.toContain("Error:");
    expect(Object.values(saved.projects ?? {})).toEqual([
      {
        agents: ["two"],
        instructions: "Edited project focus",
        context: { tier: 2 },
      },
    ]);
    expect(saved.execution).toEqual({
      max_concurrency: 3,
      heartbeat_interval_ms: 2000,
      shutdown_grace_period_ms: 300,
      distribute_primaries: false,
      allow_provider_concentration: true,
      continuation_attempts: 4,
      deadline_mode: "adaptive",
      no_progress_timeout_ms: 300000,
    });
    expect(saved.diagnostics).toEqual({ persist_runs: false, max_runs: 7 });
  });

  it("edits an agent from scalar to multi-model and back to scalar", async () => {
    const directory = await mkdtemp(join(tmpdir(), "review-mesh-config-tui-"));
    roots.push(directory);
    const file = join(directory, "config.toml");
    const initial: ManagedConfig = {
      schema_version: "5",
      execution: {
        max_concurrency: 2,
        heartbeat_interval_ms: 1_000,
        shutdown_grace_period_ms: 100,
      },
      diagnostics: { persist_runs: false, max_runs: 2 },
      adapters: {
        gateway: {
          type: "openai_compatible",
          base_url_env: "BASE",
          api_key_env: "KEY",
        },
      },
      agents: {
        architecture: {
          adapter: "gateway",
          model: "opus-old",
          effort: "high",
          purpose: "Architecture",
          instructions: "Review architecture.",
          isolation: "prefer_enforced",
          timeout_ms: 1000,
        },
      },
      defaults: { agents: ["architecture"] },
      projects: {},
    };
    await writeFile(
      file,
      serializeManagedConfig(normalizeManagedConfig(initial)),
    );
    let loaded = await loadManagedConfig(file);
    await runConfigMenu({
      configFile: file,
      config: loaded.config,
      snapshot: loaded.snapshot,
      prompt: new Answers([
        "e",
        "architecture",
        "gateway",
        "multi",
        "2",
        "opus",
        "inherit",
        "opus-new",
        "max",
        "grok",
        "inherit",
        "grok-new",
        "high",
        "Architecture",
        "",
        "prefer_enforced",
        "1000",
        "y",
        "q",
      ]),
      output: new PassThrough(),
    });
    expect(
      (await loadManagedConfig(file)).config.agents.architecture,
    ).toMatchObject({
      model_runs: [
        { id: "opus", model: "opus-new", effort: "max" },
        { id: "grok", model: "grok-new", effort: "high" },
      ],
    });

    loaded = await loadManagedConfig(file);
    await runConfigMenu({
      configFile: file,
      config: loaded.config,
      snapshot: loaded.snapshot,
      prompt: new Answers([
        "e",
        "architecture",
        "gateway",
        "single",
        "solo-model",
        "medium",
        "Architecture",
        "",
        "prefer_enforced",
        "1000",
        "y",
        "q",
      ]),
      output: new PassThrough(),
    });
    const scalar = (await loadManagedConfig(file)).config.agents.architecture!;
    expect(scalar).toMatchObject({ model: "solo-model", effort: "medium" });
    expect("model_runs" in scalar).toBe(false);
  });

  it("does not reuse model defaults after a model run changes adapters", async () => {
    const directory = await mkdtemp(join(tmpdir(), "review-mesh-config-tui-"));
    roots.push(directory);
    const file = join(directory, "config.toml");
    const initial: ManagedConfig = {
      schema_version: "5",
      execution: {
        max_concurrency: 2,
        heartbeat_interval_ms: 1_000,
        shutdown_grace_period_ms: 100,
      },
      diagnostics: { persist_runs: false, max_runs: 2 },
      adapters: {
        gateway: {
          type: "openai_compatible",
          base_url_env: "BASE",
          api_key_env: "KEY",
        },
        github: { type: "copilot", use_logged_in_user: true },
      },
      agents: {
        architecture: {
          adapter: "gateway",
          model_runs: [
            { id: "opus", model: "gateway-opus", effort: "high" },
            {
              id: "grok",
              adapter: "github",
              model: "copilot-grok",
              effort: "high",
            },
          ],
          purpose: "Architecture",
          instructions: "Review architecture.",
          isolation: "prefer_enforced",
          timeout_ms: 1000,
        },
      },
      defaults: { agents: ["architecture"] },
      projects: {},
    };
    await writeFile(
      file,
      serializeManagedConfig(normalizeManagedConfig(initial)),
    );
    const loaded = await loadManagedConfig(file);
    await runConfigMenu({
      configFile: file,
      config: loaded.config,
      snapshot: loaded.snapshot,
      prompt: new Answers([
        "e",
        "architecture",
        "gateway",
        "multi",
        "2",
        "opus",
        "inherit",
        "gateway-opus",
        "high",
        "grok",
        "inherit",
        "gateway-grok",
        "medium",
        "Architecture",
        "",
        "prefer_enforced",
        "1000",
        "y",
        "q",
      ]),
      output: new PassThrough(),
    });

    expect(
      (await loadManagedConfig(file)).config.agents.architecture,
    ).toMatchObject({
      model_runs: [
        { id: "opus", model: "gateway-opus", effort: "high" },
        { id: "grok", model: "gateway-grok", effort: "medium" },
      ],
    });
  });

  it("rolls back duplicate model run ids", async () => {
    const directory = await mkdtemp(join(tmpdir(), "review-mesh-config-tui-"));
    roots.push(directory);
    const file = join(directory, "config.toml");
    const loaded = await loadManagedConfig(file, true);
    loaded.config.adapters.gateway = {
      type: "openai_compatible",
      base_url_env: "BASE",
      api_key_env: "KEY",
    };
    let transcript = "";
    const output = new PassThrough();
    output.on("data", (chunk) => (transcript += chunk.toString()));
    await runConfigMenu({
      configFile: file,
      config: loaded.config,
      snapshot: loaded.snapshot,
      prompt: new Answers([
        "a",
        "architecture",
        "gateway",
        "multi",
        "2",
        "same",
        "inherit",
        "opus",
        "high",
        "same",
        "q",
      ]),
      output,
    });
    expect(loaded.config.agents).toEqual({});
    expect(transcript).toContain("duplicate model run id: same");
  });

  it("rolls back a failed menu mutation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "review-mesh-config-tui-"));
    roots.push(directory);
    const file = join(directory, "config.toml");
    const loaded = await loadManagedConfig(file, true);
    const prompt = new Answers(["a", "bad id!", "q"]);
    const output = new PassThrough();
    await runConfigMenu({
      configFile: file,
      config: loaded.config,
      snapshot: loaded.snapshot,
      prompt,
      output,
    });
    expect(loaded.config).toEqual<ManagedConfig>({
      schema_version: "7",
      execution: {
        max_concurrency: 2,
        heartbeat_interval_ms: 30000,
        shutdown_grace_period_ms: 5000,
        distribute_primaries: true,
        allow_provider_concentration: false,
        default_provider_concurrency: 2,
        provider_limits: {},
        circuit_breaker_threshold: 2,
        circuit_breaker_cooldown_ms: 30000,
        retry_attempts: 2,
        continuation_attempts: 2,
        retry_backoff_ms: 1000,
        deadline_mode: "adaptive",
        no_progress_timeout_ms: 300000,
      },
      diagnostics: { persist_runs: true, max_runs: 50 },
      adapters: {},
      agents: {},
      defaults: { agents: [] },
      projects: {},
    });
  });

  it("refuses to remove the last configured agent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "review-mesh-config-tui-"));
    roots.push(directory);
    const file = join(directory, "config.toml");
    const loaded = await loadManagedConfig(file, true);
    loaded.config.adapters.gateway = {
      type: "openai_compatible",
      base_url_env: "BASE",
      api_key_env: "KEY",
    };
    loaded.config.agents.only = {
      adapter: "gateway",
      model: "model",
      purpose: "purpose",
      instructions: "review",
      isolation: "prefer_enforced",
      timeout_ms: 1000,
    };
    loaded.config.defaults = { agents: ["only"] };
    const prompt = new Answers(["r", "only", "q"]);
    const output = new PassThrough();
    await runConfigMenu({
      configFile: file,
      config: loaded.config,
      snapshot: loaded.snapshot,
      prompt,
      output,
    });
    expect(loaded.config.agents.only).toBeDefined();
  });

  it("removes a stored project by name", async () => {
    const directory = await mkdtemp(join(tmpdir(), "review-mesh-config-tui-"));
    roots.push(directory);
    const stored = "deleted-project";
    const file = join(directory, "config.toml");
    const initial: ManagedConfig = {
      schema_version: "5",
      execution: {
        max_concurrency: 1,
        heartbeat_interval_ms: 1_000,
        shutdown_grace_period_ms: 100,
      },
      diagnostics: { persist_runs: false, max_runs: 1 },
      adapters: {
        gateway: {
          type: "openai_compatible",
          base_url_env: "BASE",
          api_key_env: "KEY",
        },
      },
      agents: {
        one: {
          adapter: "gateway",
          model: "model",
          purpose: "purpose",
          instructions: "review",
          isolation: "prefer_enforced",
          timeout_ms: 1000,
        },
      },
      defaults: { agents: ["one"] },
      projects: { [stored]: { agents: ["one"] } },
    };
    await writeFile(
      file,
      serializeManagedConfig(normalizeManagedConfig(initial)),
    );
    const loaded = await loadManagedConfig(file);
    await runConfigMenu({
      configFile: file,
      config: loaded.config,
      snapshot: loaded.snapshot,
      prompt: new Answers(["d", stored, "y", "q"]),
      output: new PassThrough(),
    });
    expect((await loadManagedConfig(file)).config.projects).toEqual({});
  });

  it("stops a pending menu prompt when aborted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "review-mesh-config-tui-"));
    roots.push(directory);
    const loaded = await loadManagedConfig(
      join(directory, "config.toml"),
      true,
    );
    const controller = new AbortController();
    const prompt: ConfigPrompter = {
      ask: async () => await new Promise<string>(() => undefined),
      close: () => undefined,
    };
    const running = runConfigMenu({
      configFile: join(directory, "config.toml"),
      config: loaded.config,
      snapshot: loaded.snapshot,
      prompt,
      output: new PassThrough(),
      signal: controller.signal,
    });
    controller.abort(new Error("interrupted"));
    await expect(running).rejects.toThrow(/interrupted/i);
  });

  it("stops a nested add-agent prompt when aborted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "review-mesh-config-tui-"));
    roots.push(directory);
    const loaded = await loadManagedConfig(
      join(directory, "config.toml"),
      true,
    );
    const controller = new AbortController();
    let calls = 0;
    const prompt: ConfigPrompter = {
      ask: async (_question, signal) => {
        calls += 1;
        if (calls === 1) return "a";
        return await new Promise<string>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(signal.reason ?? new Error("interrupted")),
            { once: true },
          );
        });
      },
      close: () => undefined,
    };
    const running = runConfigMenu({
      configFile: join(directory, "config.toml"),
      config: loaded.config,
      snapshot: loaded.snapshot,
      prompt,
      output: new PassThrough(),
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort(new Error("nested interrupted"));
    await expect(running).rejects.toThrow(/nested interrupted/i);
  });
});
