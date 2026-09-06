import { expect, it } from "vitest";
import { migrateSdkConfig } from "../../src/config/migrate-sdk.js";
import { emptyManagedConfig } from "../../src/config/manage.js";

it("previews an explicit SDK migration without changing the stored config or expanding credentials", () => {
  const config = emptyManagedConfig();
  config.adapters.gateway = {
    type: "openai_compatible",
    base_url_env: "BASE",
    api_key_env: "KEY",
    semantic_checkpoints: true,
  };
  config.agents.review = {
    adapter: "gateway",
    model: "kimi-k3",
    purpose: "Review",
    instructions: "Review",
    isolation: "prefer_enforced",
    timeout_ms: 60000,
    kind: "generic",
    required_input: [],
    applicability: { mode: "always" },
    change_coverage: {
      relevant_paths: ["src/**"],
      minimum_inspection: "full_file",
      proof: "observed",
    },
    adjudication: "off",
  };
  config.defaults = { agents: ["review"] };
  const migrated = migrateSdkConfig(config);
  expect(migrated.adapters.gateway).toEqual({
    type: "sdk",
    base_url_env: "BASE",
    api_key_env: "KEY",
  });
  expect(migrated.agents.review?.change_coverage).toMatchObject({
    proof: "native_attested",
    relevant_paths: ["src/**"],
  });
  expect(migrated.execution.retry_attempts).toBeUndefined();
  expect(config.adapters.gateway.type).toBe("openai_compatible");
});

it("leaves command-only retry settings intact", () => {
  const config = emptyManagedConfig();
  config.adapters.legacy = {
    type: "command",
    command: "reviewer",
    protocol: "review-mesh-command-v2",
  };
  config.agents.review = {
    adapter: "legacy",
    model: "fixture",
    purpose: "Review",
    instructions: "Review",
    isolation: "prefer_enforced",
    timeout_ms: 60000,
    kind: "generic",
    required_input: [],
    applicability: { mode: "always" },
    change_coverage: {
      relevant_paths: ["**"],
      minimum_inspection: "full_file",
      proof: "attested",
    },
    adjudication: "off",
  };
  config.defaults = { agents: ["review"] };
  config.execution.retry_attempts = 3;
  expect(migrateSdkConfig(config).execution.retry_attempts).toBe(3);
});
