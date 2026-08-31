import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  adapterRegistrationSchema,
  repositoryPolicySchema,
  type RepositoryPolicy,
} from "../../src/config/schemas.js";
import { resolveConfig } from "../../src/config/resolve.js";
import { loadConfigFiles } from "../../src/config/load.js";
import { repositoryPolicy, trustedConfig } from "../helpers/fixtures.js";

describe("resolveConfig", () => {
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

  it("accepts only lower repository timeouts and enforcement promotion", () => {
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
    expect(() =>
      resolveConfig({
        trusted: trustedConfig(),
        repository: repositoryPolicy({
          reviewer_overrides: [{ id: "baseline", timeout_ms: 1_800_000 }],
        }),
      }),
    ).toThrow(/lower than trusted timeout/i);
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
});
