import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadManagedConfig,
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
  it("adds the first agent, then assigns it to a canonical project", async () => {
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
      "gemini-flash",
      "Correctness",
      "Review carefully",
      "900000",
      "n",
      "p",
      project,
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
    const canonicalProject =
      process.platform === "win32"
        ? project.replaceAll("\\", "/").toLowerCase()
        : project.replaceAll("\\", "/");
    const file = join(directory, "config.toml");
    const initial: ManagedConfig = {
      schema_version: "2",
      execution: {
        max_concurrency: 1,
        heartbeat_interval_ms: 100,
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
        [canonicalProject]: {
          agents: ["one"],
          instructions: "Original project focus",
          context: { tier: 1 },
        },
      },
    };
    await writeFile(file, serializeManagedConfig(initial));
    const loaded = await loadManagedConfig(file);
    const output = new PassThrough();
    let transcript = "";
    output.on("data", (chunk) => (transcript += chunk.toString()));
    const prompt = new Answers([
      "e",
      "two",
      "gateway",
      "model-two-new",
      "Purpose two new",
      "New agent instructions",
      "require_enforced",
      "2000",
      "y",
      "o",
      project,
      "two",
      "Edited project focus",
      '{"tier":2}',
      "s",
      "3",
      "200",
      "300",
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
      heartbeat_interval_ms: 200,
      shutdown_grace_period_ms: 300,
    });
    expect(saved.diagnostics).toEqual({ persist_runs: false, max_runs: 7 });
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
      schema_version: "2",
      execution: {
        max_concurrency: 2,
        heartbeat_interval_ms: 15000,
        shutdown_grace_period_ms: 5000,
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

  it("removes a stored project after its directory was deleted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "review-mesh-config-tui-"));
    roots.push(directory);
    const stale = join(directory, "deleted-project");
    const stored = stale.replaceAll("\\", "/").toLowerCase();
    const file = join(directory, "config.toml");
    const initial: ManagedConfig = {
      schema_version: "2",
      execution: {
        max_concurrency: 1,
        heartbeat_interval_ms: 100,
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
    await writeFile(file, serializeManagedConfig(initial));
    const loaded = await loadManagedConfig(file);
    await runConfigMenu({
      configFile: file,
      config: loaded.config,
      snapshot: loaded.snapshot,
      prompt: new Answers(["d", stale, "y", "q"]),
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
