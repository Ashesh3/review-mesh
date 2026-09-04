import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runConfigCommand } from "../../src/config/command.js";
import type { CopilotAccountService } from "../../src/copilot/account.js";
import {
  loadManagedConfig,
  serializeManagedConfig,
  type ManagedConfig,
} from "../../src/config/manage.js";

const roots: string[] = [];

function config(): ManagedConfig {
  return {
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
      gemini: {
        adapter: "gateway",
        model: "gemini",
        purpose: "correctness",
        instructions: "review",
        isolation: "prefer_enforced",
        timeout_ms: 1000,
      },
    },
    defaults: { agents: ["gemini"] },
    projects: {},
  };
}

async function fixture() {
  const directory = await mkdtemp(
    join(tmpdir(), "review-mesh-config-command-"),
  );
  roots.push(directory);
  const file = join(directory, "config.toml");
  await writeFile(file, serializeManagedConfig(config()));
  return { directory, file };
}

function streams() {
  const input = new PassThrough() as PassThrough & { isTTY?: boolean };
  const output = new PassThrough() as PassThrough & { isTTY?: boolean };
  const error = new PassThrough();
  let stdout = "";
  let stderr = "";
  output.on("data", (chunk) => (stdout += chunk.toString()));
  error.on("data", (chunk) => (stderr += chunk.toString()));
  return { input, output, error, stdout: () => stdout, stderr: () => stderr };
}

function inputJson(io: ReturnType<typeof streams>, value: unknown): void {
  io.input.end(JSON.stringify(value));
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("config command", () => {
  const copilotAccount = (): CopilotAccountService => ({
    status: vi.fn(async () => ({
      isAuthenticated: true,
      authType: "gh-cli" as const,
      login: "octocat",
      host: "https://github.com",
      runtimeVersion: "1.0.11",
    })),
    models: vi.fn(async () => ({
      status: {
        isAuthenticated: true,
        authType: "gh-cli" as const,
        login: "octocat",
        host: "https://github.com",
        runtimeVersion: "1.0.11",
      },
      models: [
        {
          id: "gpt-test",
          name: "GPT Test",
          capabilities: { supports: { reasoningEffort: true } },
          policy: { state: "enabled" as const },
          supportedReasoningEfforts: ["low", "high"],
        },
      ],
    })),
    login: vi.fn(async () => undefined),
  });

  it("prints the configuration path without reading stdin", async () => {
    const { file } = await fixture();
    const io = streams();
    expect(
      await runConfigCommand({ args: ["path"], configFile: file, ...io }),
    ).toBe(0);
    expect(io.stdout()).toBe(`${file}\n`);
  });

  it("shows and validates the configured file", async () => {
    const { file } = await fixture();
    const shown = streams();
    expect(
      await runConfigCommand({ args: ["show"], configFile: file, ...shown }),
    ).toBe(0);
    expect(shown.stdout()).toContain('schema_version = "7"');

    const validated = streams();
    expect(
      await runConfigCommand({
        args: ["validate"],
        configFile: file,
        ...validated,
      }),
    ).toBe(0);
    expect(validated.stdout()).toMatch(/Configuration is valid/);
  });

  it("returns stable JSON for list --json", async () => {
    const { file } = await fixture();
    const io = streams();
    expect(
      await runConfigCommand({
        args: ["list", "--json"],
        configFile: file,
        ...io,
      }),
    ).toBe(0);
    expect(JSON.parse(io.stdout())).toMatchObject({
      schema_version: "7",
      agents: [{ id: "gemini", default: true }],
      projects: [],
    });
  });

  it("lists every concrete run of a multi-model agent", async () => {
    const { file } = await fixture();
    const updated = config();
    updated.agents.architecture = {
      adapter: "gateway",
      model_runs: [
        { id: "opus", model: "claude-opus", effort: "max" },
        { id: "grok", model: "grok-code" },
      ],
      purpose: "architecture",
      instructions: "review architecture",
      isolation: "prefer_enforced",
      timeout_ms: 1000,
    };
    updated.defaults = { agents: ["architecture"] };
    await writeFile(file, serializeManagedConfig(updated));

    const text = streams();
    expect(
      await runConfigCommand({ args: ["list"], configFile: file, ...text }),
    ).toBe(0);
    expect(text.stdout()).toContain(
      "architecture::opus\tclaude-opus\tmax\tgateway\tdefault\n",
    );
    expect(text.stdout()).toContain(
      "architecture::grok\tgrok-code\tdefault\tgateway\tdefault\n",
    );

    const json = streams();
    expect(
      await runConfigCommand({
        args: ["list", "--json"],
        configFile: file,
        ...json,
      }),
    ).toBe(0);
    expect(JSON.parse(json.stdout())).toMatchObject({
      agents: [
        {
          id: "architecture",
          default: true,
          model_runs: [
            { id: "opus", model: "claude-opus", effort: "max" },
            { id: "grok", model: "grok-code" },
          ],
        },
        { id: "gemini", default: false },
      ],
    });
  });

  it.each([["help"], ["--help"], ["-h"]])(
    "prints detailed configuration help for %s",
    async (argument) => {
      const io = streams();
      expect(await runConfigCommand({ args: [argument], ...io })).toBe(0);
      expect(io.stdout()).toContain("review-mesh config effective");
      expect(io.stdout()).toContain("review-mesh config apply --json");
      expect(io.stdout()).toContain("PROJECT SELECTION");
      expect(io.stderr()).toBe("");
    },
  );

  it("prints help for the Copilot command group without contacting an account", async () => {
    const io = streams();
    expect(await runConfigCommand({ args: ["copilot", "--help"], ...io })).toBe(
      0,
    );
    expect(io.stdout()).toContain("COPILOT ACCOUNT");
    expect(io.stderr()).toBe("");
  });

  it("exports the complete config with a stable revision", async () => {
    const { file } = await fixture();
    const io = streams();
    expect(
      await runConfigCommand({
        args: ["export", "--json"],
        configFile: file,
        ...io,
      }),
    ).toBe(0);
    const exported = JSON.parse(io.stdout());
    expect(exported).toMatchObject({
      schema_version: "1",
      config_schema_version: "7",
      path: file,
      exists: true,
      migrated: false,
      config: { schema_version: "7" },
    });
    expect(exported.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(exported.config.agents.gemini.instructions).toBe("review");
  });

  it("resolves effective configuration for a workspace without disclosing instructions", async () => {
    const { directory, file } = await fixture();
    const project = join(directory, "project");
    await mkdir(project);
    const updated = config();
    updated.projects = {
      project: {
        agents: ["gemini"],
        instructions: "project secret instruction",
        context: { secret: "project secret context" },
      },
    };
    updated.agents.gemini!.runtime = { secret: "runtime secret" };
    await writeFile(file, serializeManagedConfig(updated));
    const io = streams();
    expect(
      await runConfigCommand({
        args: ["resolve", project, "--json"],
        configFile: file,
        ...io,
      }),
    ).toBe(0);
    expect(JSON.parse(io.stdout())).toMatchObject({
      valid: true,
      selection: { source: "project" },
      reviewers: [
        { id: "gemini", instruction_sources: ["trusted", "project"] },
      ],
    });
    expect(io.stdout()).not.toContain("project secret");
    expect(io.stdout()).not.toContain("runtime secret");
  });

  it("resolves a relative workspace against the supplied cwd and requires --json", async () => {
    const { directory, file } = await fixture();
    const project = join(directory, "project");
    await mkdir(project);
    const relative = streams();
    expect(
      await runConfigCommand({
        args: ["effective", "project", "--json"],
        configFile: file,
        cwd: directory,
        ...relative,
      }),
    ).toBe(0);
    expect(JSON.parse(relative.stdout())).toMatchObject({
      valid: true,
      workspace: await realpath(project),
    });

    const missingJson = streams();
    expect(
      await runConfigCommand({
        args: ["effective", project],
        configFile: file,
        ...missingJson,
      }),
    ).toBe(2);
    expect(JSON.parse(missingJson.stderr())).toMatchObject({
      error: "invalid_usage",
    });
  });

  it("applies a full config with revision CAS and is idempotent", async () => {
    const { file } = await fixture();
    const exportedIo = streams();
    await runConfigCommand({
      args: ["export", "--json"],
      configFile: file,
      ...exportedIo,
    });
    const exported = JSON.parse(exportedIo.stdout());
    exported.config.execution.max_concurrency = 3;

    const appliedIo = streams();
    inputJson(appliedIo, {
      schema_version: "1",
      expected_revision: exported.revision,
      config: exported.config,
    });
    expect(
      await runConfigCommand({
        args: ["apply", "--json"],
        configFile: file,
        ...appliedIo,
      }),
    ).toBe(0);
    const applied = JSON.parse(appliedIo.stdout());
    expect(applied).toMatchObject({ status: "applied" });
    expect(applied.revision).not.toBe(exported.revision);
    expect(
      (await loadManagedConfig(file)).config.execution.max_concurrency,
    ).toBe(3);

    const unchangedIo = streams();
    inputJson(unchangedIo, {
      schema_version: "1",
      expected_revision: applied.revision,
      config: exported.config,
    });
    expect(
      await runConfigCommand({
        args: ["apply", "--json"],
        configFile: file,
        ...unchangedIo,
      }),
    ).toBe(0);
    expect(JSON.parse(unchangedIo.stdout())).toMatchObject({
      status: "unchanged",
      revision: applied.revision,
    });
  });

  it("keeps apply protocol v1 compatible with complete v2 configs", async () => {
    const { file } = await fixture();
    const loaded = await loadManagedConfig(file);
    const v2Config = {
      ...config(),
      schema_version: "2" as const,
      execution: { ...config().execution, max_concurrency: 4 },
    };
    const io = streams();
    inputJson(io, {
      schema_version: "1",
      expected_revision: loaded.snapshot.hash,
      config: v2Config,
    });

    expect(
      await runConfigCommand({
        args: ["apply", "--json"],
        configFile: file,
        ...io,
      }),
    ).toBe(0);
    const saved = (await loadManagedConfig(file)).config;
    expect(saved.schema_version).toBe("7");
    expect(saved.execution.max_concurrency).toBe(4);
  });

  it("rejects stale, malformed, oversized, and unsafe apply requests", async () => {
    const { file } = await fixture();
    const stale = streams();
    inputJson(stale, {
      schema_version: "1",
      expected_revision: "0".repeat(64),
      config: config(),
    });
    expect(
      await runConfigCommand({
        args: ["apply", "--json"],
        configFile: file,
        ...stale,
      }),
    ).toBe(2);
    expect(JSON.parse(stale.stderr())).toMatchObject({
      error: "config_conflict",
    });

    const staleInvalid = streams();
    inputJson(staleInvalid, {
      schema_version: "1",
      expected_revision: "0".repeat(64),
      config: { schema_version: "invalid" },
    });
    expect(
      await runConfigCommand({
        args: ["apply", "--json"],
        configFile: file,
        ...staleInvalid,
      }),
    ).toBe(2);
    expect(JSON.parse(staleInvalid.stderr())).toMatchObject({
      error: "config_conflict",
    });

    const malformed = streams();
    malformed.input.end("{");
    expect(
      await runConfigCommand({
        args: ["apply", "--json"],
        configFile: file,
        ...malformed,
      }),
    ).toBe(2);
    expect(JSON.parse(malformed.stderr())).toMatchObject({
      error: "invalid_request",
    });

    const unsafe = streams();
    const unsafeConfig = config();
    unsafeConfig.projects = { "not/a/name": { agents: ["gemini"] } };
    inputJson(unsafe, {
      schema_version: "1",
      expected_revision: (await loadManagedConfig(file)).snapshot.hash,
      config: unsafeConfig,
    });
    expect(
      await runConfigCommand({
        args: ["apply", "--json"],
        configFile: file,
        ...unsafe,
      }),
    ).toBe(2);
    expect(JSON.parse(unsafe.stderr())).toMatchObject({
      error: "invalid_request",
    });

    const oversized = streams();
    oversized.input.end("x".repeat(5 * 1024 * 1024 + 1));
    expect(
      await runConfigCommand({
        args: ["apply", "--json"],
        configFile: file,
        ...oversized,
      }),
    ).toBe(2);
    expect(JSON.parse(oversized.stderr())).toMatchObject({
      error: "request_too_large",
    });
  });

  it("reports Copilot account status and available model efforts", async () => {
    const io = streams();
    expect(
      await runConfigCommand({
        args: ["copilot", "models", "--json"],
        copilotAccount: copilotAccount(),
        ...io,
      }),
    ).toBe(0);
    expect(JSON.parse(io.stdout())).toMatchObject({
      authenticated: true,
      login: "octocat",
      models: [
        {
          id: "gpt-test",
          available: true,
          reasoning_efforts: ["low", "high"],
        },
      ],
    });
  });

  it("forwards Copilot login flow options and verifies the account", async () => {
    const account = copilotAccount();
    const io = streams();
    expect(
      await runConfigCommand({
        args: [
          "copilot",
          "login",
          "--device-code",
          "--host",
          "https://github.com",
        ],
        copilotAccount: account,
        ...io,
      }),
    ).toBe(0);
    expect(account.login).toHaveBeenCalledWith(
      expect.objectContaining({
        flow: "device-code",
        host: "https://github.com",
      }),
    );
    expect(io.stdout()).toContain("octocat");
  });

  it("refuses an interactive menu on redirected streams", async () => {
    const { file } = await fixture();
    const io = streams();
    expect(await runConfigCommand({ args: [], configFile: file, ...io })).toBe(
      2,
    );
    expect(JSON.parse(io.stderr())).toMatchObject({
      error: "interactive_terminal_required",
    });
  });

  it("returns interrupted when an interactive menu is aborted", async () => {
    const { file } = await fixture();
    const io = streams();
    const controller = new AbortController();
    const running = runConfigCommand({
      args: [],
      configFile: file,
      ...io,
      interactive: true,
      signal: controller.signal,
    });
    controller.abort(new Error("stop"));
    expect(await running).toBe(4);
    expect(JSON.parse(io.stderr())).toMatchObject({ error: "interrupted" });
  });

  it("reports invalid configuration without exposing stored values", async () => {
    const { file } = await fixture();
    await writeFile(
      file,
      'schema_version = "not-valid"\nsecret = "do-not-print"\n',
    );
    const io = streams();
    expect(
      await runConfigCommand({ args: ["validate"], configFile: file, ...io }),
    ).toBe(2);
    expect(JSON.parse(io.stderr())).toMatchObject({
      error: "configuration_error",
    });
    expect(io.stderr()).not.toContain("do-not-print");
  });

  it("refuses to show an invalid file that may contain secrets", async () => {
    const { file } = await fixture();
    const text = 'schema_version = "broken"\nsecret = "do-not-print"\n';
    await writeFile(file, text);
    const io = streams();
    expect(
      await runConfigCommand({ args: ["show"], configFile: file, ...io }),
    ).toBe(2);
    expect(io.stdout()).toBe("");
    expect(io.stderr()).not.toContain("do-not-print");
  });
});
