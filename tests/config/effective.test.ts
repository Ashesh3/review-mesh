import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { describeEffectiveConfig } from "../../src/config/effective.js";
import {
  serializeManagedConfig,
  type ManagedConfig,
} from "../../src/config/manage.js";

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "review-mesh-effective-"));
  roots.push(root);
  const workspace = join(root, "project");
  await mkdir(workspace);
  const projectPath = (await realpath(workspace)).replaceAll("\\", "/");
  const config: ManagedConfig = {
    schema_version: "3",
    execution: {
      max_concurrency: 2,
      heartbeat_interval_ms: 5000,
      shutdown_grace_period_ms: 1000,
    },
    diagnostics: { persist_runs: true, max_runs: 20 },
    adapters: {
      gateway: {
        type: "openai_compatible",
        base_url_env: "MESH_BASE_URL",
        api_key_env: "MESH_API_KEY",
      },
    },
    agents: {
      reviewer: {
        adapter: "gateway",
        model: "private-model",
        purpose: "Correctness",
        instructions: "SECRET INSTRUCTION BODY",
        runtime: { private_runtime: "SECRET RUNTIME" },
        isolation: "prefer_enforced",
        timeout_ms: 900000,
      },
    },
    defaults: { agents: ["reviewer"] },
    projects: {
      [projectPath]: {
        instructions: "SECRET PROJECT INSTRUCTION",
        context: { secret: "SECRET PROJECT CONTEXT" },
      },
    },
  };
  const file = join(root, "config.toml");
  await writeFile(file, serializeManagedConfig(config));
  return { file, workspace, projectPath };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("effective configuration description", () => {
  it("returns the effective ordered suite without secret or instruction contents", async () => {
    const { file, workspace, projectPath } = await fixture();
    const result = await describeEffectiveConfig({
      configFile: file,
      workspace,
      environment: { MESH_BASE_URL: "https://secret.example" },
    });
    expect(result).toMatchObject({
      valid: true,
      config_path: file,
      selection: {
        source: "defaults",
        matched_project_path: projectPath,
      },
      execution: { max_concurrency: 2, heartbeat_interval_ms: 5000 },
      reviewers: [
        {
          id: "reviewer",
          adapter_id: "gateway",
          adapter_type: "openai_compatible",
          model: "private-model",
          instruction_sources: ["trusted", "project"],
        },
      ],
      credential_environment: [
        { name: "MESH_API_KEY", present: false },
        { name: "MESH_BASE_URL", present: true },
      ],
    });
    const encoded = JSON.stringify(result);
    expect(encoded).not.toContain("SECRET");
    expect(encoded).not.toContain("https://secret.example");
    expect(encoded).not.toContain("private_runtime");
  });

  it("describes each expanded model run as an independent reviewer", async () => {
    const { file, workspace } = await fixture();
    const source = await readFile(file, "utf8");
    await writeFile(
      file,
      source
        .replace('model = "private-model"\n', "")
        .replace(
          'purpose = "Correctness"',
          'model_runs = [{ id = "opus", model = "claude-opus" }, { id = "grok", model = "grok-code", effort = "high" }]\npurpose = "Correctness"',
        ),
    );

    const result = await describeEffectiveConfig({
      configFile: file,
      workspace,
      environment: {},
    });
    expect(result).toMatchObject({
      valid: true,
      reviewers: [
        { id: "reviewer::opus", model: "claude-opus" },
        { id: "reviewer::grok", model: "grok-code", effort: "high" },
      ],
    });
  });

  it("reports missing and invalid configuration without throwing", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-mesh-effective-"));
    roots.push(root);
    const workspace = join(root, "project");
    await mkdir(workspace);
    const file = join(root, "config.toml");
    expect(
      await describeEffectiveConfig({ configFile: file, workspace }),
    ).toMatchObject({
      valid: false,
      revision: "missing",
      error: { code: "configuration_missing" },
    });
    await writeFile(file, 'schema_version = "broken"\nsecret = "hidden"\n');
    const invalid = await describeEffectiveConfig({
      configFile: file,
      workspace,
    });
    expect(invalid).toMatchObject({
      valid: false,
      error: { code: "invalid_configuration" },
    });
    expect(JSON.stringify(invalid)).not.toContain("hidden");
  });

  it("does not treat inherited process-environment properties as credentials", async () => {
    const { file, workspace } = await fixture();
    const original = await readFile(file, "utf8");
    await writeFile(
      file,
      original
        .replace('base_url_env = "MESH_BASE_URL"', 'base_url_env = "toString"')
        .replace('api_key_env = "MESH_API_KEY"', 'api_key_env = "constructor"'),
    );
    const result = await describeEffectiveConfig({
      configFile: file,
      workspace,
      environment: {},
    });
    expect(result).toMatchObject({
      valid: true,
      credential_environment: [
        { name: "constructor", present: false },
        { name: "toString", present: false },
      ],
    });
  });
});
