import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeTool } from "../../src/discovery/description.js";
import {
  serializeManagedConfig,
  type ManagedConfig,
} from "../../src/config/manage.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture(retired: boolean) {
  const root = await mkdtemp(join(tmpdir(), "mesh-native-description-"));
  roots.push(root);
  const workspace = join(root, "project");
  await mkdir(workspace);
  const file = join(root, "config.toml");
  const config: ManagedConfig = {
    schema_version: "7",
    execution: {
      max_concurrency: 1,
      heartbeat_interval_ms: 1000,
      shutdown_grace_period_ms: 1000,
      allow_provider_concentration: true,
      deadline_mode: "adaptive",
      no_progress_timeout_ms: 10000,
    },
    diagnostics: { persist_runs: true, max_runs: 10 },
    adapters: {
      selected: retired
        ? {
            type: "openai_compatible",
            base_url_env: "PRIVATE_URL_REF",
            api_key_env: "PRIVATE_KEY_REF",
          }
        : { type: "sdk", api_key_env: "PRIVATE_KEY_REF" },
    },
    agents: {
      review: {
        adapter: "selected",
        model_runs: [
          { id: "openai", model: "gpt-5.6" },
          { id: "anthropic", model: "claude-opus-4.6" },
          { id: "other", model: "gemini-3-pro" },
        ],
        purpose: "Review",
        instructions: "SECRET_INSTRUCTIONS",
        isolation: "prefer_enforced",
        timeout_ms: 10000,
        applicability: { mode: "always" },
        kind: "generic",
        required_input: [],
        allow_zero_outage_tolerance: true,
        change_coverage: {
          relevant_paths: ["**"],
          minimum_inspection: "full_file",
          proof: retired ? "observed" : "native_attested",
        },
      },
    },
    defaults: { agents: ["review"] },
    projects: {},
  };
  await writeFile(file, serializeManagedConfig(config));
  return { workspace, configFile: file };
}

describe("native discovery contract", () => {
  it("describes effective vendor routing and SDK ownership without promising model access", async () => {
    const output = await describeTool(await fixture(false));
    expect(output.configuration).toMatchObject({
      valid: true,
      reviewers: [
        { adapter_type: "codex", model: "gpt-5.6" },
        { adapter_type: "claude", model: "claude-opus-4.6" },
        { adapter_type: "copilot", model: "gemini-3-pro" },
      ],
    });
    expect(output.protocol).toMatchObject({
      sdk_execution: {
        inference_owner: "vendor_sdk",
        tool_execution_owner: "vendor_sdk",
        context_management_owner: "vendor_sdk",
        in_turn_retry_owner: "vendor_sdk",
        mesh_session_attempts: 1,
        mesh_exact_output_continuation: false,
      },
      model_support: {
        source: "vendor_runtime",
        availability: "not_probed",
        exact_model_identifier_preserved: true,
      },
      retry: {
        native_inheritance: "rerun_all",
        native_coverage_basis: "model_attested",
      },
    });
    expect(output.protocol).not.toHaveProperty("provider_transport");
    expect(output.readiness.status).toBe("not_probed");
    expect(JSON.stringify(output)).not.toContain("SECRET_INSTRUCTIONS");
  });
  it("leaves retired configurations inspectable but directs migration instead of starting a rejected review", async () => {
    const output = await describeTool(await fixture(true));
    expect(output.configuration.valid).toBe(true);
    expect(output.readiness).toMatchObject({
      status: "migration_required",
      review_supported: false,
    });
    expect(output.next_actions[0]?.command).toBe(
      "review-mesh config export --json",
    );
    expect(output.next_actions[0]?.reason).toContain("native_attested");
  });
});
