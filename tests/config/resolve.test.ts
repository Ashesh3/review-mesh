import { describe, expect, it } from "vitest";
import {
  mkdtemp,
  mkdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  adapterRegistrationSchema,
  repositoryPolicySchema,
  trustedConfigSchema,
  type RepositoryPolicy,
} from "../../src/config/schemas.js";
import { resolveConfig } from "../../src/config/resolve.js";
import {
  loadConfigFiles,
  maximumRepositoryPolicyBytes,
} from "../../src/config/load.js";
import { repositoryPolicy, trustedConfig } from "../helpers/fixtures.js";

const validTrustedToml = `schema_version = "1"

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

[reviewer_profiles.security]
adapter = "command"
model = "trusted-model"
purpose = "Find defects"
instructions = "Review carefully."
isolation = "prefer_enforced"
timeout_ms = 1000

[[reviewers]]
id = "baseline"
profile = "security"
`;

async function configLoadFixture(): Promise<{
  root: string;
  configFile: string;
  workspace: string;
}> {
  const root = await mkdtemp(
    join(process.env.TEMP ?? "C:\\Temp", "review-mesh-policy-"),
  );
  const configFile = join(root, "config.toml");
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(configFile, validTrustedToml);
  return { root, configFile, workspace };
}

describe("resolveConfig", () => {
  it("requires at least one trusted reviewer", () => {
    expect(() =>
      trustedConfigSchema.parse(trustedConfig({ reviewers: [] })),
    ).toThrow();
  });

  it("bounds timer-backed configuration at the Node timer maximum", () => {
    const maximumTimerMs = 2_147_483_647;
    expect(() =>
      trustedConfigSchema.parse(
        trustedConfig({
          execution: {
            heartbeat_interval_ms: maximumTimerMs,
            shutdown_grace_period_ms: maximumTimerMs,
          },
          reviewer_profiles: {
            "security-profile": { timeout_ms: maximumTimerMs },
          },
        }),
      ),
    ).not.toThrow();

    for (const trusted of [
      trustedConfig({
        execution: { heartbeat_interval_ms: maximumTimerMs + 1 },
      }),
      trustedConfig({
        execution: { shutdown_grace_period_ms: maximumTimerMs + 1 },
      }),
      trustedConfig({
        reviewer_profiles: {
          "security-profile": { timeout_ms: maximumTimerMs + 1 },
        },
      }),
    ]) {
      expect(() => trustedConfigSchema.parse(trusted)).toThrow();
    }
    expect(() =>
      repositoryPolicySchema.parse(
        repositoryPolicy({
          reviewer_overrides: [
            { id: "baseline", timeout_ms: maximumTimerMs + 1 },
          ],
        }),
      ),
    ).toThrow();
  });

  it("accepts only the trusted OpenAI-compatible registration shape", () => {
    expect(
      adapterRegistrationSchema.parse({
        type: "openai_compatible",
        base_url_env: "REVIEW_MESH_OPENAI_BASE_URL",
        api_key_env: "REVIEW_MESH_OPENAI_API_KEY",
      }),
    ).toEqual({
      type: "openai_compatible",
      base_url_env: "REVIEW_MESH_OPENAI_BASE_URL",
      api_key_env: "REVIEW_MESH_OPENAI_API_KEY",
    });
    expect(() =>
      adapterRegistrationSchema.parse({
        type: "openai_compatible",
        base_url_env: "",
        api_key_env: "REVIEW_MESH_OPENAI_API_KEY",
      }),
    ).toThrow();
    expect(() =>
      adapterRegistrationSchema.parse({
        type: "openai_compatible",
        base_url_env: "REVIEW_MESH_OPENAI_BASE_URL",
        api_key_env: "REVIEW_MESH_OPENAI_API_KEY",
        command: "node",
      }),
    ).toThrow();
  });

  it("keeps baseline reviewers mandatory and appends repository instructions", () => {
    const resolved = resolveConfig({
      trusted: trustedConfig({
        reviewer_profiles: {
          security: {
            adapter: "claude-main",
            model: "claude-model",
            purpose: "Find security defects",
            instructions: "Find security bugs.",
            isolation: "prefer_enforced",
            timeout_ms: 1_800_000,
            runtime: {},
          },
        },
        reviewers: [{ id: "security-claude", profile: "security" }],
      }),
      repository: repositoryPolicy({
        reviewer_overrides: [
          {
            id: "security-claude",
            append_instructions: "Check tenant isolation.",
          },
        ],
      }),
    });

    expect(resolved.reviewers).toHaveLength(1);
    expect(resolved.reviewers[0]?.instruction_layers).toEqual([
      { source: "trusted", content: "Find security bugs." },
      { source: "repository", content: "Check tenant isolation." },
    ]);
  });

  it.each([
    ["adapter", "command"],
    ["model", "different-model"],
    ["disabled", true],
  ])("rejects repository attempts to override baseline %s", (key, value) => {
    expect(() =>
      resolveConfig({
        trusted: trustedConfig(),
        repository: {
          schema_version: "1",
          reviewer_overrides: [{ id: "baseline", [key]: value }],
        } as unknown as RepositoryPolicy,
      }),
    ).toThrow(/repository policy/i);
  });

  it("namespaces repository reviewer ids and forbids executable registration", () => {
    const resolved = resolveConfig({
      trusted: trustedConfig(),
      repository: repositoryPolicy({
        reviewers: [
          {
            id: "project-security",
            profile: "security-profile",
            instructions: "Review project policy.",
          },
        ],
      }),
    });

    expect(resolved.reviewers.at(-1)?.id).toBe("repo:project-security");
    expect(() =>
      repositoryPolicySchema.parse({
        schema_version: "1",
        adapters: { evil: { command: "malware.exe" } },
      }),
    ).toThrow();
  });

  it("adds repository reviewer instructions and append instructions once in order", () => {
    const resolved = resolveConfig({
      trusted: trustedConfig(),
      repository: repositoryPolicy({
        reviewers: [
          {
            id: "project-security",
            profile: "security-profile",
            instructions: "Review project policy.",
            append_instructions: "Check project boundaries.",
          },
        ],
      }),
    });

    expect(resolved.reviewers.at(-1)?.instruction_layers).toEqual([
      { source: "trusted", content: "Find security bugs." },
      { source: "repository", content: "Review project policy." },
      { source: "repository", content: "Check project boundaries." },
    ]);
  });

  it("accepts repository timeouts up to the trusted timeout and enforcement promotion", () => {
    const resolved = resolveConfig({
      trusted: trustedConfig(),
      repository: repositoryPolicy({
        reviewer_overrides: [
          {
            id: "baseline",
            timeout_ms: 60_000,
            require_enforced: true,
          },
        ],
      }),
    });

    expect(resolved.reviewers[0]).toMatchObject({
      timeoutMs: 60_000,
      isolationPolicy: "require_enforced",
    });
    expect(
      resolveConfig({
        trusted: trustedConfig(),
        repository: repositoryPolicy({
          reviewer_overrides: [{ id: "baseline", timeout_ms: 900_000 }],
        }),
      }).reviewers[0]?.timeoutMs,
    ).toBe(900_000);
    expect(() =>
      resolveConfig({
        trusted: trustedConfig(),
        repository: repositoryPolicy({
          reviewer_overrides: [{ id: "baseline", timeout_ms: 900_001 }],
        }),
      }),
    ).toThrow(/must not exceed trusted timeout/i);
  });

  it("preserves trusted execution and repository context without admitting roster collisions", () => {
    const trusted = trustedConfig({
      execution: {
        max_concurrency: 3,
        heartbeat_interval_ms: 4_000,
        shutdown_grace_period_ms: 8_000,
      },
    });
    const resolved = resolveConfig({
      trusted,
      repository: repositoryPolicy({ context: { policy: "strict" } }),
    });

    expect(resolved.execution).toEqual(trusted.execution);
    expect(resolved.repository_context).toEqual({ policy: "strict" });
    expect(() =>
      resolveConfig({
        trusted,
        repository: repositoryPolicy({
          reviewers: [{ id: "baseline", profile: "security-profile" }],
        }),
      }),
    ).toThrow(/collision/i);
  });

  it("rejects duplicate repository identities and unknown trusted profiles", () => {
    expect(() =>
      resolveConfig({
        trusted: trustedConfig(),
        repository: repositoryPolicy({
          reviewers: [
            { id: "project", profile: "security-profile" },
            { id: "project", profile: "security-profile" },
          ],
        }),
      }),
    ).toThrow(/collision/i);
    expect(() =>
      resolveConfig({
        trusted: trustedConfig(),
        repository: repositoryPolicy({
          reviewers: [{ id: "project", profile: "not-registered" }],
        }),
      }),
    ).toThrow(/unknown profile/i);
  });
});

describe("loadConfigFiles", () => {
  it("loads trusted instructions only from the trusted config directory", async () => {
    const root = await mkdtemp(
      join(process.env.TEMP ?? "C:\\Temp", "review-mesh-"),
    );
    const configDirectory = join(root, "trusted");
    const workspace = join(root, "workspace");
    await mkdir(join(configDirectory, "reviewers"), { recursive: true });
    await mkdir(workspace);
    await writeFile(
      join(configDirectory, "config.toml"),
      `schema_version = "1"\n\n[execution]\nmax_concurrency = 1\nheartbeat_interval_ms = 1000\nshutdown_grace_period_ms = 1000\n\n[diagnostics]\npersist_runs = false\nmax_runs = 1\n\n[adapters.command]\ntype = "command"\ncommand = "reviewer"\nprotocol = "review-mesh-command-v1"\n\n[reviewer_profiles.security]\nadapter = "command"\nmodel = "trusted-model"\npurpose = "Find defects"\ninstructions_file = "reviewers/security.md"\nisolation = "prefer_enforced"\ntimeout_ms = 1000\n\n[[reviewers]]\nid = "baseline"\nprofile = "security"\n`,
    );
    await writeFile(
      join(configDirectory, "reviewers", "security.md"),
      "Trusted instructions.",
    );
    await writeFile(
      join(workspace, ".review-mesh.toml"),
      'schema_version = "1"\ncontext = { repository = "demo" }\n',
    );

    try {
      const loaded = await loadConfigFiles({
        configFile: join(configDirectory, "config.toml"),
        workspace,
      });

      expect(loaded.trusted.reviewer_profiles.security?.instructions).toBe(
        "Trusted instructions.",
      );
      expect(loaded.repository?.context).toEqual({ repository: "demo" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects instruction files that canonically escape the trusted directory", async () => {
    const root = await mkdtemp(
      join(process.env.TEMP ?? "C:\\Temp", "review-mesh-"),
    );
    const configDirectory = join(root, "trusted");
    const workspace = join(root, "workspace");
    await mkdir(configDirectory, { recursive: true });
    await mkdir(workspace);
    await writeFile(join(root, "outside.md"), "Untrusted instructions.");
    await writeFile(
      join(configDirectory, "config.toml"),
      `schema_version = "1"\n\n[execution]\nmax_concurrency = 1\nheartbeat_interval_ms = 1000\nshutdown_grace_period_ms = 1000\n\n[diagnostics]\npersist_runs = false\nmax_runs = 1\n\n[adapters.command]\ntype = "command"\ncommand = "reviewer"\nprotocol = "review-mesh-command-v1"\n\n[reviewer_profiles.security]\nadapter = "command"\nmodel = "trusted-model"\npurpose = "Find defects"\ninstructions_file = "../outside.md"\nisolation = "prefer_enforced"\ntimeout_ms = 1000\n\n[[reviewers]]\nid = "baseline"\nprofile = "security"\n`,
    );

    try {
      await expect(
        loadConfigFiles({
          configFile: join(configDirectory, "config.toml"),
          workspace,
        }),
      ).rejects.toThrow(/escape/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a repository policy symlink instead of following it", async () => {
    const fixture = await configLoadFixture();
    const outside = join(fixture.root, "outside.toml");
    await writeFile(outside, 'schema_version = "1"\n');
    await symlink(
      outside,
      join(fixture.workspace, ".review-mesh.toml"),
      process.platform === "win32" ? "file" : undefined,
    );

    try {
      await expect(loadConfigFiles(fixture)).rejects.toThrow(/regular file/i);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects an oversized repository policy before parsing it", async () => {
    const fixture = await configLoadFixture();
    await writeFile(
      join(fixture.workspace, ".review-mesh.toml"),
      Buffer.alloc(maximumRepositoryPolicyBytes + 1, 0x20),
    );

    try {
      await expect(loadConfigFiles(fixture)).rejects.toThrow(/too large/i);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("fails closed when the repository policy path is replaced after open", async () => {
    const fixture = await configLoadFixture();
    const policy = join(fixture.workspace, ".review-mesh.toml");
    const displaced = join(fixture.workspace, "original.toml");
    await writeFile(policy, 'schema_version = "1"\n');

    try {
      await expect(
        loadConfigFiles(fixture, {
          afterRepositoryOpen: async () => {
            await rename(policy, displaced);
            await writeFile(
              policy,
              'schema_version = "1"\ncontext = { swapped = true }\n',
            );
          },
        }),
      ).rejects.toThrow(/changed/i);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("honors cancellation while loading repository policy", async () => {
    const fixture = await configLoadFixture();
    await writeFile(
      join(fixture.workspace, ".review-mesh.toml"),
      'schema_version = "1"\n',
    );
    const controller = new AbortController();

    try {
      await expect(
        loadConfigFiles(
          { ...fixture, signal: controller.signal },
          {
            afterRepositoryOpen: () => {
              controller.abort(new Error("cancelled policy read"));
            },
          },
        ),
      ).rejects.toThrow(/cancelled policy read/i);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("interrupts a stuck descriptor read promptly when cancelled", async () => {
    const fixture = await configLoadFixture();
    await writeFile(
      join(fixture.workspace, ".review-mesh.toml"),
      'schema_version = "1"\n',
    );
    const controller = new AbortController();
    let readStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      readStarted = resolve;
    });

    try {
      const loading = loadConfigFiles(
        { ...fixture, signal: controller.signal },
        {
          readTimeoutMs: 10_000,
          repositoryRead: async () => {
            readStarted();
            return await new Promise<never>(() => undefined);
          },
        },
      );
      await started;
      controller.abort(new Error("cancel stuck policy read"));

      await expect(
        Promise.race([
          loading,
          new Promise<never>((_resolve, reject) =>
            setTimeout(
              () => reject(new Error("cancellation was not prompt")),
              250,
            ),
          ),
        ]),
      ).rejects.toThrow(/cancel stuck policy read/i);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("applies a hard deadline to a stuck descriptor read", async () => {
    const fixture = await configLoadFixture();
    await writeFile(
      join(fixture.workspace, ".review-mesh.toml"),
      'schema_version = "1"\n',
    );

    try {
      await expect(
        Promise.race([
          loadConfigFiles(fixture, {
            readTimeoutMs: 20,
            repositoryRead: async () =>
              await new Promise<never>(() => undefined),
          }),
          new Promise<never>((_resolve, reject) =>
            setTimeout(
              () => reject(new Error("read deadline was not prompt")),
              500,
            ),
          ),
        ]),
      ).rejects.toThrow(/read timed out after 20ms/i);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "opens a repository FIFO nonblocking and rejects it as a special file",
    async () => {
      const fixture = await configLoadFixture();
      const policy = join(fixture.workspace, ".review-mesh.toml");
      const created = spawnSync("mkfifo", [policy]);
      expect(created.status).toBe(0);

      try {
        const result = Promise.race([
          loadConfigFiles(fixture),
          new Promise<never>((_resolve, reject) =>
            setTimeout(() => reject(new Error("FIFO read blocked")), 1_000),
          ),
        ]);
        await expect(result).rejects.toThrow(/regular file/i);
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    },
  );
});
