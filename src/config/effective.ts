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

export interface DescribeEffectiveConfigInput {
  configFile?: string;
  workspace: string;
  environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface DescribeResolvedConfigInput {
  configFile: string;
  revision: string;
  configSchemaVersion: "1" | "2" | "3" | "4";
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
  config_schema_version: "1" | "2" | "3" | "4";
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
  };
  diagnostics: { persist_runs: boolean; max_runs: number };
  reviewers: Array<{
    id: string;
    agent_id: string;
    model_index: number;
    model_count: number;
    previous_reviewer_id?: string;
    activation: "immediate" | "after_clear_pass";
    purpose: string;
    adapter_id: string;
    adapter_type: AdapterRegistration["type"];
    model: string;
    effort?: string;
    isolation_policy: "prefer_enforced" | "require_enforced";
    timeout_ms: number;
    instruction_sources: Array<"trusted" | "project">;
  }>;
  credential_environment: Array<{ name: string; present: boolean }>;
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
    reviewers: input.resolved.reviewers.map((reviewer) => ({
      id: reviewer.id,
      agent_id: reviewer.agentId ?? reviewer.id,
      model_index: reviewer.modelIndex ?? 0,
      model_count: reviewer.modelCount ?? 1,
      ...(reviewer.previousReviewerId === undefined
        ? {}
        : { previous_reviewer_id: reviewer.previousReviewerId }),
      activation:
        (reviewer.modelIndex ?? 0) === 0 ? "immediate" : "after_clear_pass",
      purpose: reviewer.purpose,
      adapter_id: reviewer.adapterId,
      adapter_type: reviewer.adapter.type,
      model: reviewer.model,
      ...(reviewer.effort === undefined ? {} : { effort: reviewer.effort }),
      isolation_policy: reviewer.isolationPolicy,
      timeout_ms: reviewer.timeoutMs,
      instruction_sources: reviewer.instruction_layers.map(
        (layer) => layer.source,
      ),
    })),
    credential_environment: names.map((name) => ({
      name,
      present:
        Object.hasOwn(environment, name) &&
        typeof environment[name] === "string" &&
        environment[name]!.length > 0,
    })),
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
