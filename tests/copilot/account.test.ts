import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCopilotAccountService,
  resolveCopilotLoginCommand,
} from "../../src/copilot/account.js";
import type {
  CopilotClientFacade,
  CopilotClientFactory,
} from "../../src/adapters/copilot.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function fakeClient() {
  const options: Parameters<CopilotClientFactory>[0][] = [];
  const client: CopilotClientFacade = {
    start: vi.fn(async () => undefined),
    getStatus: vi.fn(async () => ({ version: "1.0.11", protocolVersion: 3 })),
    getAuthStatus: vi.fn(async () => ({
      isAuthenticated: true,
      authType: "gh-cli" as const,
      login: "octocat",
      host: "https://github.com",
    })),
    listModels: vi.fn(async () => [
      {
        id: "gpt-test",
        name: "GPT Test",
        capabilities: { supports: { reasoningEffort: true } },
        policy: { state: "enabled" as const },
        supportedReasoningEfforts: ["low", "high"],
      },
    ]),
    createSession: vi.fn(async () => {
      throw new Error("not used");
    }),
    stop: vi.fn(async () => undefined),
    forceStop: vi.fn(async () => undefined),
  };
  const createClient: CopilotClientFactory = (input) => {
    options.push(input);
    return client;
  };
  return { client, createClient, options };
}

describe("Copilot account service", () => {
  it("queries auth and account-specific models through the SDK runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-mesh-copilot-account-"));
    roots.push(root);
    const fake = fakeClient();
    const service = createCopilotAccountService({
      applicationDataDirectory: root,
      environment: { PATH: "safe", GH_TOKEN: "token", SECRET: "no" },
      createClient: fake.createClient,
    });

    await expect(service.models()).resolves.toMatchObject({
      status: { isAuthenticated: true, login: "octocat" },
      models: [
        {
          id: "gpt-test",
          supportedReasoningEfforts: ["low", "high"],
        },
      ],
    });
    expect(fake.options[0]).toMatchObject({
      mode: "empty",
      useLoggedInUser: true,
      baseDirectory: join(root, "runtime", "copilot"),
      env: { PATH: "safe", GH_TOKEN: "token" },
    });
    expect(fake.options[0]?.env).not.toHaveProperty("SECRET");
    expect(fake.client.start).toHaveBeenCalledOnce();
    expect(fake.client.stop).toHaveBeenCalledOnce();
  });

  it("runs Copilot OAuth login with an isolated COPILOT_HOME", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-mesh-copilot-login-"));
    roots.push(root);
    const launches: unknown[] = [];
    const service = createCopilotAccountService({
      applicationDataDirectory: root,
      environment: { PATH: "safe", SECRET: "no" },
      resolveLoginCommand: () => ({ command: "copilot", args: [] }),
      launchLogin: async (command, args, options) => {
        launches.push({ command, args, env: options.env });
        return 0;
      },
    });

    await service.login({ flow: "device-code", host: "https://github.com" });

    expect(launches).toEqual([
      {
        command: { command: "copilot", args: [] },
        args: ["login", "--device-code", "--host", "https://github.com"],
        env: {
          PATH: "safe",
          COPILOT_HOME: join(root, "runtime", "copilot"),
        },
      },
    ]);
  });

  it("resolves a packaged Copilot login executable", () => {
    const command = resolveCopilotLoginCommand();
    expect(command.command.length).toBeGreaterThan(0);
  });
});
