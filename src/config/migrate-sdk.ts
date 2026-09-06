import type { ManagedConfig } from "./manage.js";
import { trustedConfigV7Schema } from "./schemas.js";

/** Explicit migration preview; does not read credentials or mutate configuration. */
export function migrateSdkConfig(config: ManagedConfig): ManagedConfig {
  const next = structuredClone(config);
  if (next.schema_version !== "7")
    throw new Error(
      "Migrate the configuration to schema 7 before SDK migration.",
    );
  const referenced = Object.values(next.agents).flatMap(
    (agent) =>
      agent.model_runs?.map((run) => run.adapter ?? agent.adapter) ?? [
        agent.adapter,
      ],
  );
  const hasCommand = referenced.some(
    (id) => next.adapters[id]?.type === "command",
  );
  const hasSdk = referenced.some((id) => next.adapters[id]?.type !== "command");
  if (hasCommand && hasSdk)
    throw new Error(
      "Mixed command and SDK configuration requires separate review rosters before migration.",
    );
  if (hasCommand) return next;
  for (const [id, adapter] of Object.entries(next.adapters)) {
    if (adapter.type === "openai_compatible")
      next.adapters[id] = {
        type: "sdk",
        base_url_env: adapter.base_url_env,
        api_key_env: adapter.api_key_env,
      };
  }
  for (const agent of Object.values(next.agents)) {
    const ids = agent.model_runs?.map(
      (run) => run.adapter ?? agent.adapter,
    ) ?? [agent.adapter];
    if (ids.some((id) => next.adapters[id]?.type === "command")) continue;
    agent.change_coverage = {
      relevant_paths: agent.change_coverage?.relevant_paths ?? ["**"],
      minimum_inspection:
        agent.change_coverage?.minimum_inspection ?? "full_file",
      proof: "native_attested",
    };
  }
  delete next.execution.retry_attempts;
  delete next.execution.retry_backoff_ms;
  delete next.execution.continuation_attempts;
  delete next.execution.circuit_breaker_threshold;
  delete next.execution.circuit_breaker_cooldown_ms;
  return trustedConfigV7Schema.parse(next);
}
