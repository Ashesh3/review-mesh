import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runConfigCommand } from "../../src/config/command.js";
import type { CopilotAccountService } from "../../src/copilot/account.js";
import {
  serializeManagedConfig,
  type ManagedConfig,
} from "../../src/config/manage.js";

const roots: string[] = [];

function config(): ManagedConfig {
  return {
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
    expect(shown.stdout()).toContain('schema_version = "2"');

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
      schema_version: "2",
      agents: [{ id: "gemini", default: true }],
      projects: [],
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
