import { realpath, stat } from "node:fs/promises";
import type { AdapterRegistration } from "./schemas.js";
import { loadConfigFiles } from "./load.js";
import {
  configRevision,
  loadManagedConfig,
  readConfigRevision,
} from "./manage.js";
import { getAppPaths } from "./paths.js";
import { resolveConfig } from "./resolve.js";
import { providerOutageTolerance } from "../orchestrator/lens-policy.js";

export interface DescribeEffectiveConfigInput {
  configFile?: string;
  workspace: string;
  environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface DescribeResolvedConfigInput {
  configFile: string;
  revision: string;
  configSchemaVersion: "1" | "2" | "3" | "4" | "5" | "6";
  migrated: boolean;
  workspace: string;
  resolved: ReturnType<typeof resolveConfig>;
  environment?: NodeJS.ProcessEnv;
}

export interface EffectiveConfigFailure {
  valid: false;
  config_path: string;
  revision?: string;
  error: {
    code:
      "configuration_missing" | "invalid_configuration" | "invalid_workspace";
    message: string;
  };
}

export interface EffectiveConfigDescription {
  valid: true;
  config_path: string;
  revision: string;
  config_schema_version: "1" | "2" | "3" | "4" | "5" | "6";
  migrated: boolean;
  workspace: string;
  selection: {
    source: "legacy" | "defaults" | "project";
    project_name?: string;
    project_name_source?:
      "git_remote" | "git_common_directory" | "git_root" | "workspace";
    matched_project_name?: string;
  };
  execution: {
    max_concurrency: number;
    heartbeat_interval_ms: number;
    shutdown_grace_period_ms: number;
    distribute_primaries: boolean;
    default_provider_concurrency: number;
    provider_limits: Record<string, number>;
    circuit_breaker_threshold: number;
    circuit_breaker_cooldown_ms: number;
    retry_attempts: number;
    continuation_attempts: number;
    retry_backoff_ms: number;
  };
  diagnostics: { persist_runs: boolean; max_runs: number };
  reviewers: Array<{
    id: string;
    agent_id: string;
    model_index: number;
    configured_model_index: number;
    model_count: number;
    previous_reviewer_id?: string;
    activation: "immediate" | "after_clear_pass" | "after_lens_progress";
    purpose: string;
    adapter_id: string;
    adapter_type: AdapterRegistration["type"];
    streaming?: "auto" | "required" | "disabled";
    model: string;
    effort?: string;
    isolation_policy: "prefer_enforced" | "require_enforced";
    timeout_ms: number;
    instruction_sources: Array<"trusted" | "project">;
    provider_group: string;
    attempt_timeout_ms: number;
    provider_topology: {
      provider_groups: string[];
      distinct_provider_groups: number;
      outage_tolerance: number;
      zero_outage_tolerance_acknowledged: boolean;
    };
    policy?: NonNullable<
      ReturnType<typeof resolveConfig>["reviewers"][number]["policy"]
    >;
  }>;
  credential_environment: Array<{ name: string; present: boolean }>;
  warnings: Array<{
    code: "provider_concentration" | "zero_outage_tolerance_quorum";
    message: string;
    lens_ids: string[];
    provider_groups: string[];
  }>;
}

export type EffectiveConfigResult =
  EffectiveConfigDescription | EffectiveConfigFailure;

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted.", "AbortError");
}

async function knownRevision(configFile: string): Promise<string | undefined> {
  try {
    return await readConfigRevision(configFile);
  } catch {
    return undefined;
  }
}

function environmentNames(adapter: AdapterRegistration): string[] {
  if (adapter.type === "openai_compatible") {
    return [adapter.base_url_env, adapter.api_key_env];
  }
  return adapter.env_allowlist ?? [];
}

/** Converts an already-resolved configuration to its safe public description. */
export function describeResolvedConfig(
  input: DescribeResolvedConfigInput,
): EffectiveConfigDescription {
  const environment = input.environment ?? process.env;
  const names = [
    ...new Set(
      input.resolved.reviewers.flatMap((reviewer) =>
        environmentNames(reviewer.adapter),
      ),
    ),
  ].sort((left, right) => left.localeCompare(right));
  const selection = input.resolved.selection ?? {
    source: input.configSchemaVersion === "1" ? "legacy" : "defaults",
  };
  const lenses = new Map<string, typeof input.resolved.reviewers>();
  for (const reviewer of input.resolved.reviewers) {
    const id = reviewer.agentId ?? reviewer.id;
    const members = lenses.get(id) ?? [];
    members.push(reviewer);
    lenses.set(id, members);
  }
  const primaryGroups = new Set(
    [...lenses.values()].map((members) => {
      const primary = members.find(
        (reviewer) => (reviewer.modelIndex ?? 0) === 0,
      );
      return primary?.providerGroup ?? primary?.adapterId ?? "unknown";
    }),
  );
  const warnings: EffectiveConfigDescription["warnings"] = [];
  if (lenses.size > 1 && primaryGroups.size === 1) {
    warnings.push({
      code: "provider_concentration",
      message:
        "Every logical lens starts on the same provider group; one provider incident can amplify across the suite.",
      lens_ids: [...lenses.keys()],
      provider_groups: [...primaryGroups],
    });
  }
  const zeroToleranceLenses = [...lenses.entries()]
    .filter(([, members]) => {
      if (members.length < 2) return false;
      const policy = members[0]?.policy;
      const providerGroups = members.map(
        (reviewer) => reviewer.providerGroup ?? reviewer.adapterId,
      );
      return (
        new Set(providerGroups).size > 1 &&
        providerOutageTolerance(
          {
            passQuorum: policy?.passQuorum ?? members.length,
            minimumProviderGroups: policy?.minimumProviderGroups ?? 1,
          },
          providerGroups,
        ) === 0
      );
    })
    .map(([id]) => id);
  if (zeroToleranceLenses.length > 0) {
    warnings.push({
      code: "zero_outage_tolerance_quorum",
      message:
        "One or more multi-model lenses cannot tolerate one provider-group outage while still satisfying clean-pass quorum.",
      lens_ids: zeroToleranceLenses,
      provider_groups: [
        ...new Set(
          zeroToleranceLenses.flatMap((id) =>
            (lenses.get(id) ?? []).map(
              (reviewer) => reviewer.providerGroup ?? reviewer.adapterId,
            ),
          ),
        ),
      ],
    });
  }
  return {
    valid: true,
    config_path: input.configFile,
    revision: input.revision,
    config_schema_version: input.configSchemaVersion,
    migrated: input.migrated,
    workspace: input.workspace,
    selection: {
      source: selection.source,
      ...(selection.projectName === undefined
        ? {}
        : { project_name: selection.projectName }),
      ...(selection.projectNameSource === undefined
        ? {}
        : { project_name_source: selection.projectNameSource }),
      ...(selection.matchedProjectName === undefined
        ? {}
        : { matched_project_name: selection.matchedProjectName }),
    },
    execution: structuredClone(input.resolved.execution),
    diagnostics: structuredClone(input.resolved.diagnostics),
    reviewers: input.resolved.reviewers.map((reviewer) => {
      const lensMembers = lenses.get(reviewer.agentId ?? reviewer.id) ?? [
        reviewer,
      ];
      const providerGroups = lensMembers.map(
        (member) => member.providerGroup ?? member.adapterId,
      );
      const policy = reviewer.policy;
      const pass = {
        passQuorum: policy?.passQuorum ?? lensMembers.length,
        minimumProviderGroups: policy?.minimumProviderGroups ?? 1,
      };
      return {
        id: reviewer.id,
        agent_id: reviewer.agentId ?? reviewer.id,
        model_index: reviewer.modelIndex ?? 0,
        configured_model_index:
          reviewer.configuredModelIndex ?? reviewer.modelIndex ?? 0,
        model_count: reviewer.modelCount ?? 1,
        ...(reviewer.previousReviewerId === undefined
          ? {}
          : { previous_reviewer_id: reviewer.previousReviewerId }),
        activation:
          (reviewer.modelIndex ?? 0) === 0
            ? "immediate"
            : reviewer.policy === undefined
              ? "after_clear_pass"
              : "after_lens_progress",
        purpose: reviewer.purpose,
        adapter_id: reviewer.adapterId,
        adapter_type: reviewer.adapter.type,
        ...(reviewer.adapter.type === "openai_compatible"
          ? { streaming: reviewer.adapter.streaming ?? "disabled" }
          : {}),
        model: reviewer.model,
        ...(reviewer.effort === undefined ? {} : { effort: reviewer.effort }),
        isolation_policy: reviewer.isolationPolicy,
        timeout_ms: reviewer.timeoutMs,
        instruction_sources: reviewer.instruction_layers.map(
          (layer) => layer.source,
        ),
        provider_group: reviewer.providerGroup ?? reviewer.adapterId,
        attempt_timeout_ms: reviewer.attemptTimeoutMs ?? reviewer.timeoutMs,
        provider_topology: {
          provider_groups: [...providerGroups],
          distinct_provider_groups: new Set(providerGroups).size,
          outage_tolerance: providerOutageTolerance(pass, providerGroups),
          zero_outage_tolerance_acknowledged:
            policy?.allowZeroOutageTolerance ?? false,
        },
        ...(reviewer.policy === undefined
          ? {}
          : { policy: structuredClone(reviewer.policy) }),
      };
    }),
    credential_environment: names.map((name) => ({
      name,
      present:
        Object.hasOwn(environment, name) &&
        typeof environment[name] === "string" &&
        environment[name]!.length > 0,
    })),
    warnings,
  };
}

/** Resolves the exact effective suite while omitting instruction and runtime contents. */
export async function describeEffectiveConfig(
  input: DescribeEffectiveConfigInput,
): Promise<EffectiveConfigResult> {
  const configFile = input.configFile ?? getAppPaths().configFile;
  throwIfAborted(input.signal);

  let workspace: string;
  try {
    workspace = await realpath(input.workspace);
    if (!(await stat(workspace)).isDirectory()) {
      throw new Error("not a directory");
    }
  } catch {
    throwIfAborted(input.signal);
    const revision = await knownRevision(configFile);
    const failure: EffectiveConfigFailure = {
      valid: false,
      config_path: configFile,
      ...(revision === undefined ? {} : { revision }),
      error: {
        code: "invalid_workspace",
        message: "The requested workspace is not an existing directory.",
      },
    };
    return failure;
  }

  let managed: Awaited<ReturnType<typeof loadManagedConfig>>;
  try {
    managed = await loadManagedConfig(configFile, true);
  } catch {
    throwIfAborted(input.signal);
    const revision = await knownRevision(configFile);
    return {
      valid: false,
      config_path: configFile,
      ...(revision === undefined ? {} : { revision }),
      error: {
        code: "invalid_configuration",
        message: "The global Review Mesh configuration is invalid.",
      },
    };
  }
  const revision = configRevision(managed.snapshot);
  if (!managed.snapshot.exists) {
    return {
      valid: false,
      config_path: configFile,
      revision,
      error: {
        code: "configuration_missing",
        message: "The global Review Mesh configuration file does not exist.",
      },
    };
  }

  try {
    const loaded = await loadConfigFiles({
      configFile,
      workspace,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    const resolved = resolveConfig({
      trusted: loaded.trusted,
      workspace: loaded.workspace,
      projectName: loaded.projectName,
      projectNameSource: loaded.projectNameSource,
    });
    const after = await loadManagedConfig(configFile);
    if (configRevision(after.snapshot) !== revision) {
      throw new Error("configuration changed while resolving");
    }
    return describeResolvedConfig({
      configFile,
      revision,
      configSchemaVersion: loaded.trusted.schema_version,
      migrated: managed.migrated,
      workspace,
      resolved,
      ...(input.environment === undefined
        ? {}
        : { environment: input.environment }),
    });
  } catch {
    throwIfAborted(input.signal);
    return {
      valid: false,
      config_path: configFile,
      revision,
      error: {
        code: "invalid_configuration",
        message:
          "The global Review Mesh configuration or project assignment is invalid.",
      },
    };
  }
}

export const resolveEffectiveConfig = describeEffectiveConfig;
