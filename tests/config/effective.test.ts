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
import { describeTool } from "../../src/discovery/description.js";
import { renderHelp } from "../../src/discovery/help.js";
import { jsonSchema } from "../../src/discovery/schema.js";
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
  const projectName = "project";
  const config: ManagedConfig = {
    schema_version: "6",
    execution: {
      max_concurrency: 2,
      heartbeat_interval_ms: 5000,
      shutdown_grace_period_ms: 1000,
      allow_provider_concentration: false,
    },
    diagnostics: { persist_runs: true, max_runs: 20 },
    adapters: {
      gateway: {
        type: "openai_compatible",
        base_url_env: "MESH_BASE_URL",
        api_key_env: "MESH_API_KEY",
        streaming: "required",
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
        applicability: { mode: "always" },
        required_context: [],
      },
    },
    defaults: { agents: ["reviewer"] },
    projects: {
      [projectName]: {
        instructions: "SECRET PROJECT INSTRUCTION",
        context: { secret: "SECRET PROJECT CONTEXT" },
      },
    },
  };
  const file = join(root, "config.toml");
  await writeFile(file, serializeManagedConfig(config));
  return { file, workspace, projectName };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("effective configuration description", () => {
  it("returns the effective ordered suite without secret or instruction contents", async () => {
    const { file, workspace, projectName } = await fixture();
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
        project_name: projectName,
        project_name_source: "workspace",
        matched_project_name: projectName,
      },
      execution: {
        max_concurrency: 2,
        heartbeat_interval_ms: 5000,
        continuation_attempts: 2,
      },
      reviewers: [
        {
          id: "reviewer",
          adapter_id: "gateway",
          adapter_type: "openai_compatible",
          streaming: "required",
          model: "private-model",
          instruction_sources: ["trusted", "project"],
          policy: {
            applicability: { mode: "always" },
            requiredCallerContext: [],
            passQuorum: 1,
            minimumProviderGroups: 1,
            allowZeroOutageTolerance: false,
          },
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

  it("surfaces topology, outage tolerance, applicability, and required context in effective and discovery output", async () => {
    const { file, workspace } = await fixture();
    const effective = await describeEffectiveConfig({
      configFile: file,
      workspace,
      environment: {},
    });
    expect(effective).toMatchObject({
      valid: true,
      config_schema_version: "7",
      execution: { allow_provider_concentration: false },
      reviewers: [
        {
          provider_group: "gateway",
          policy: {
            applicability: { mode: "always" },
            requiredCallerContext: [],
            allowZeroOutageTolerance: false,
          },
        },
      ],
    });

    const described = await describeTool({ configFile: file, workspace });
    expect(described.configuration).toMatchObject(effective);
    const configSchema = JSON.stringify(jsonSchema("config"));
    expect(configSchema).toContain('"6"');
    expect(configSchema).toContain("allow_provider_concentration");
    expect(configSchema).toContain("allow_zero_outage_tolerance");
    expect(configSchema).toContain("required_context");
    expect(configSchema).toContain("changed_paths");
    const help = `${renderHelp("config")}\n${renderHelp("schema")}\n${renderHelp("adapters")}`;
    expect(help).toContain("schema-v7");
    expect(help).toContain("allow_provider_concentration");
    expect(help).toContain("allow_zero_outage_tolerance");
    expect(help).toContain("applicability.mode");
    expect(help).toContain("required_context");
  });

  it("describes each expanded model run with its fallback activation", async () => {
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
        {
          id: "reviewer::opus",
          agent_id: "reviewer",
          model_index: 0,
          model_count: 2,
          activation: "immediate",
          model: "claude-opus",
        },
        {
          id: "reviewer::grok",
          agent_id: "reviewer",
          model_index: 1,
          model_count: 2,
          previous_reviewer_id: "reviewer::opus",
          activation: "after_lens_progress",
          model: "grok-code",
          effort: "high",
        },
      ],
    });
  });

  it("warns whenever the reported topology has zero provider-outage tolerance", async () => {
    const { file, workspace } = await fixture();
    const source = await readFile(file, "utf8");
    await writeFile(
      file,
      source
        .replace('model = "private-model"\n', "")
        .replace(
          'purpose = "Correctness"',
          'model_runs = [{ id = "a1", model = "a1", provider_group = "a" }, { id = "a2", model = "a2", provider_group = "a" }, { id = "a3", model = "a3", provider_group = "a" }, { id = "b", model = "b", provider_group = "b" }, { id = "c", model = "c", provider_group = "c" }]\npass_quorum = 3\nminimum_provider_groups = 2\nallow_zero_outage_tolerance = true\npurpose = "Correctness"',
        ),
    );

    const result = await describeEffectiveConfig({
      configFile: file,
      workspace,
      environment: {},
    });
    expect(result.valid).toBe(true);
    if (!result.valid) throw new Error("expected valid effective config");
    expect(result.reviewers[0]?.provider_topology.outage_tolerance).toBe(0);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "zero_outage_tolerance",
          lens_ids: ["reviewer"],
        }),
      ]),
    );
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
