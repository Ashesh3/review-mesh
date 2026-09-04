import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { parse, stringify } from "smol-toml";
import type {
  AdapterRegistration,
  ModelRun,
  ReasoningEffort,
  TrustedConfigV2,
  TrustedConfigV3,
  TrustedConfigV4,
  TrustedConfigV5,
  TrustedConfigV6,
  TrustedConfigV7,
} from "./schemas.js";
import type { JsonValue } from "../protocol/schemas.js";
import {
  trustedConfigSchema,
  trustedConfigV4Schema,
  trustedConfigV7Schema,
  validateAdapterEffort,
} from "./schemas.js";
import { validateProjectKeys } from "./project-paths.js";
import {
  projectNameFromLegacyPath,
  resolveProjectName,
  validateProjectNames,
} from "./project-names.js";

export const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CONFIG_LOCK_TIMEOUT_MS = 15_000;
const CONFIG_LOCK_RETRY_MS = 25;

interface ManagedAgentBase {
  adapter: string;
  purpose: string;
  instructions?: string | undefined;
  instructions_file?: string | undefined;
  isolation: "prefer_enforced" | "require_enforced";
  timeout_ms: number;
  runtime?: Record<string, JsonValue> | undefined;
  applicability?:
    | { mode: "always" }
    | {
        mode: "changed_paths";
        any_changed_paths: string[];
        case_sensitive?: boolean | undefined;
      }
    | undefined;
  kind?: "generic" | "change_readiness" | undefined;
  required_input?: string[] | undefined;
  required_context?: string[] | undefined;
  lens_deadline_ms?: number | undefined;
  change_coverage?: {
    relevant_paths: string[];
    minimum_inspection: "full_file" | "diff";
    proof: "observed" | "attested";
  };
  pass_quorum?: number | undefined;
  minimum_provider_groups?: number | undefined;
  allow_zero_outage_tolerance?: boolean | undefined;
  adjudication?: "off" | "required" | undefined;
  gate_minimum_severity?: "critical" | "high" | "medium" | "low" | undefined;
  gate_minimum_confidence?: "high" | "medium" | "low" | undefined;
}

export type ManagedModelRun = {
  id: ModelRun["id"];
  adapter?: string | undefined;
  model: ModelRun["model"];
  effort?: ReasoningEffort | undefined;
  provider_group?: string | undefined;
  timeout_ms?: number | undefined;
};

export type ManagedAgent = ManagedAgentBase &
  (
    | {
        model: string;
        effort?: ReasoningEffort | undefined;
        provider_group?: string | undefined;
        model_runs?: never;
      }
    | {
        model_runs: ManagedModelRun[];
        model?: never;
        effort?: never;
      }
  );

export interface ManagedProject {
  agents?: string[] | undefined;
  instructions?: string | undefined;
  instructions_file?: string | undefined;
  context?: JsonValue | undefined;
}

export interface ManagedConfig {
  schema_version: "5" | "6" | "7";
  execution: {
    max_concurrency: number;
    heartbeat_interval_ms: number;
    shutdown_grace_period_ms: number;
    distribute_primaries?: boolean | undefined;
    allow_provider_concentration?: boolean | undefined;
    default_provider_concurrency?: number | undefined;
    provider_limits?: Record<string, number> | undefined;
    circuit_breaker_threshold?: number | undefined;
    circuit_breaker_cooldown_ms?: number | undefined;
    retry_attempts?: number | undefined;
    continuation_attempts?: number | undefined;
    retry_backoff_ms?: number | undefined;
    deadline_mode?: "adaptive" | "fixed" | undefined;
    run_deadline_ms?: number | undefined;
    no_progress_timeout_ms?: number | undefined;
  };
  diagnostics: {
    persist_runs: boolean;
    max_runs: number;
    activity_detail?: "condensed" | "full" | undefined;
  };
  adapters: Record<string, AdapterRegistration>;
  agents: Record<string, ManagedAgent>;
  defaults?: { agents: string[] } | undefined;
  projects?: Record<string, ManagedProject> | undefined;
}

export interface ConfigSnapshot {
  exists: boolean;
  hash?: string;
  device?: bigint;
  inode?: bigint;
}

export class ConfigConflictError extends Error {
  constructor() {
    super("configuration changed on disk; reload before saving");
    this.name = "ConfigConflictError";
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolveWait) =>
    setTimeout(resolveWait, milliseconds),
  );
}

async function acquireConfigLock(
  path: string,
  pinned: { path: string; device: bigint; inode: bigint },
): Promise<() => Promise<void>> {
  const startedAt = Date.now();
  for (;;) {
    await assertStableParent(dirname(path), pinned);
    try {
      const handle = await open(
        path,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      await handle.writeFile(
        `${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })}\n`,
        "utf8",
      );
      await handle.sync();
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await handle.close();
        await rm(path, { force: true });
      };
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      if (Date.now() - startedAt >= CONFIG_LOCK_TIMEOUT_MS) {
        throw new ConfigConflictError();
      }
      await wait(CONFIG_LOCK_RETRY_MS);
    }
  }
}

export interface LoadedManagedConfig {
  config: ManagedConfig;
  snapshot: ConfigSnapshot;
  sourceText?: string;
  migrated: boolean;
  warnings: ConfigMigrationWarning[];
}

export interface ConfigMigrationWarning {
  code:
    | "implicit_v9_deadline"
    | "implicit_v9_change_coverage"
    | "attested_coverage_requires_adapter_upgrade";
  message: string;
  lens_ids: string[];
}

export interface ManagedConfigMigration {
  config: ManagedConfig;
  warnings: ConfigMigrationWarning[];
}

interface ReadSnapshot {
  snapshot: ConfigSnapshot;
  text?: string;
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function preserveLegacyPrimaryOrder<T extends { execution: object }>(
  value: T,
): T & { execution: T["execution"] & { distribute_primaries: false } } {
  return {
    ...value,
    execution: { ...value.execution, distribute_primaries: false },
  };
}

function requireManagedConfig(value: unknown): ManagedConfig {
  const record = asRecord(value);
  if (
    record?.schema_version !== "7" ||
    asRecord(record.execution) === undefined ||
    asRecord(record.diagnostics) === undefined ||
    asRecord(record.adapters) === undefined ||
    asRecord(record.agents) === undefined
  ) {
    throw new Error("configuration is not a Review Mesh v7 configuration");
  }
  const config = clone(
    trustedConfigV7Schema.parse(value) as unknown as ManagedConfig,
  );
  config.execution.allow_provider_concentration ??= false;
  config.execution.continuation_attempts ??= 2;
  validateProjectNames(config.projects);
  requireAssignments(config);
  const expandedReviewerIds = new Set<string>();
  for (const [id, agent] of Object.entries(config.agents)) {
    const expandedIds =
      "model_runs" in agent
        ? agent.model_runs.map((run) => `${id}::${run.id}`)
        : [id];
    for (const expandedId of expandedIds) {
      if (expandedReviewerIds.has(expandedId)) {
        throw new Error(`expanded reviewer id collision: ${expandedId}`);
      }
      expandedReviewerIds.add(expandedId);
    }
    const parentAdapter = Object.hasOwn(config.adapters, agent.adapter)
      ? config.adapters[agent.adapter]
      : undefined;
    if (parentAdapter === undefined) {
      throw new Error(
        `agent ${id} references unknown adapter ${agent.adapter}`,
      );
    }
    if ("model_runs" in agent) {
      for (const run of agent.model_runs) {
        const adapterId = run.adapter ?? agent.adapter;
        const adapter = Object.hasOwn(config.adapters, adapterId)
          ? config.adapters[adapterId]
          : undefined;
        if (adapter === undefined) {
          throw new Error(
            `agent ${id} model run ${run.id} references unknown adapter ${adapterId}`,
          );
        }
        validateAdapterEffort(
          adapter.type,
          run.effort,
          `agent ${id} model run ${run.id}`,
        );
      }
    } else {
      validateAdapterEffort(parentAdapter.type, agent.effort, `agent ${id}`);
    }
  }
  const assignmentLists = [
    ...(config.defaults === undefined ? [] : [config.defaults.agents]),
    ...Object.values(config.projects ?? {}).flatMap((project) =>
      project.agents === undefined ? [] : [project.agents],
    ),
  ];
  for (const ids of assignmentLists) {
    for (const id of ids) {
      if (!Object.hasOwn(config.agents, id)) {
        throw new Error(`assignment references unknown agent ${id}`);
      }
    }
  }
  return config;
}

type LegacyAgent =
  TrustedConfigV5["agents"][string] | TrustedConfigV6["agents"][string];

function legacyProviderGroups(agent: LegacyAgent): string[] {
  if (!("model_runs" in agent)) {
    return [agent.provider_group ?? agent.adapter];
  }
  return agent.model_runs.map(
    (run) => run.provider_group ?? run.adapter ?? agent.adapter,
  );
}

function toleratesOneProviderOutage(
  providerGroups: readonly string[],
  passQuorum: number,
  minimumProviderGroups: number,
): boolean {
  if (new Set(providerGroups).size <= 1) return true;
  for (const providerGroup of new Set(providerGroups)) {
    const remaining = providerGroups.filter(
      (candidate) => candidate !== providerGroup,
    );
    if (
      remaining.length < passQuorum ||
      new Set(remaining).size < minimumProviderGroups
    ) {
      return false;
    }
  }
  return true;
}

function observedAdapter(adapter: AdapterRegistration | undefined): boolean {
  return (
    adapter?.type === "openai_compatible" ||
    adapter?.type === "claude" ||
    adapter?.type === "copilot"
  );
}

function migrateLegacyAgent(
  agent: LegacyAgent,
  adapters: ManagedConfig["adapters"],
  sourceVersion: "5" | "6",
): { agent: ManagedAgent; attested: boolean } {
  const legacyApplicability = agent.applicability;
  const migrated = clone(agent) as unknown as ManagedAgent & {
    required_context?: string[];
  };
  migrated.applicability =
    legacyApplicability === undefined
      ? { mode: "always" }
      : "mode" in legacyApplicability
        ? clone(legacyApplicability)
        : {
            mode: "changed_paths",
            any_changed_paths: [...legacyApplicability.any_changed_paths],
            ...(legacyApplicability.case_sensitive === undefined
              ? {}
              : { case_sensitive: legacyApplicability.case_sensitive }),
          };
  const requiredContext = [...(migrated.required_context ?? [])];
  delete migrated.required_context;
  migrated.kind = "generic";
  migrated.required_input = requiredContext.map(
    (selector) =>
      `/context${selector.startsWith("/") ? selector : `/${selector}`}`,
  );
  const relevantPaths =
    migrated.applicability.mode === "changed_paths"
      ? [...migrated.applicability.any_changed_paths]
      : ["**"];
  const adapterIds =
    "model_runs" in migrated
      ? migrated.model_runs.map((run) => run.adapter ?? migrated.adapter)
      : [migrated.adapter];
  const attested = adapterIds.some(
    (adapterId) => !observedAdapter(adapters[adapterId]),
  );
  migrated.change_coverage = {
    relevant_paths: relevantPaths,
    minimum_inspection: "full_file",
    proof: attested ? "attested" : "observed",
  };
  if ("model_runs" in migrated) {
    const providerGroups = legacyProviderGroups(agent);
    const passQuorum =
      migrated.pass_quorum ??
      (sourceVersion === "6" && migrated.model_runs.length === 5
        ? 3
        : Math.min(2, migrated.model_runs.length));
    const minimumProviderGroups =
      migrated.minimum_provider_groups ??
      (sourceVersion === "6" && migrated.model_runs.length === 5
        ? 3
        : Math.min(2, new Set(providerGroups).size));
    migrated.pass_quorum = passQuorum;
    migrated.minimum_provider_groups = minimumProviderGroups;
    if (
      !toleratesOneProviderOutage(
        providerGroups,
        passQuorum,
        minimumProviderGroups,
      )
    ) {
      migrated.allow_zero_outage_tolerance = true;
    }
  }
  return { agent: migrated, attested };
}

function migrateLegacyAdapters(
  adapters: TrustedConfigV5["adapters"],
): ManagedConfig["adapters"] {
  return Object.fromEntries(
    Object.entries(adapters).map(([id, adapter]) => [
      id,
      adapter.type === "openai_compatible" && adapter.streaming === undefined
        ? { ...clone(adapter), streaming: "disabled" as const }
        : clone(adapter),
    ]),
  );
}

function primaryProviderGroups(
  agents: ManagedConfig["agents"],
  roster: readonly string[],
  distributePrimaries: boolean,
): { all: Set<string>; primary: Set<string> } | undefined {
  const all = new Set<string>();
  const primary = new Set<string>();
  let rotatableLensIndex = 0;
  for (const agentId of roster) {
    const agent = agents[agentId];
    if (agent === undefined) return undefined;
    if ("model_runs" in agent) {
      const groups = agent.model_runs.map(
        (run) => run.provider_group ?? run.adapter ?? agent.adapter,
      );
      for (const group of groups) all.add(group);
      primary.add(
        groups[distributePrimaries ? rotatableLensIndex++ % groups.length : 0]!,
      );
    } else {
      const group = agent.provider_group ?? agent.adapter;
      all.add(group);
      primary.add(group);
    }
  }
  return { all, primary };
}

function legacyNeedsProviderConcentrationAcknowledgement(
  config: Omit<ManagedConfig, "schema_version">,
): boolean {
  const rosters = [
    ...(config.defaults === undefined ? [] : [config.defaults.agents]),
    ...Object.values(config.projects ?? {}).flatMap((project) =>
      project.agents === undefined ? [] : [project.agents],
    ),
  ];
  const distributePrimaries = config.execution.distribute_primaries ?? true;
  return rosters.some((roster) => {
    if (roster.length < 2) return false;
    const groups = primaryProviderGroups(
      config.agents,
      roster,
      distributePrimaries,
    );
    return (
      groups !== undefined && groups.all.size > 1 && groups.primary.size === 1
    );
  });
}

function migrateLegacyShape(
  config: Omit<TrustedConfigV5 | TrustedConfigV6, "schema_version">,
  sourceVersion: "5" | "6" = "5",
): { config: ManagedConfig; warnings: ConfigMigrationWarning[] } {
  const adapters = migrateLegacyAdapters(config.adapters);
  const migratedAgents = Object.entries(config.agents).map(
    ([id, agent]) =>
      [id, migrateLegacyAgent(agent, adapters, sourceVersion)] as const,
  );
  const migrated: Omit<ManagedConfig, "schema_version"> = {
    ...clone(config),
    execution: { ...clone(config.execution) },
    adapters,
    agents: Object.fromEntries(
      migratedAgents.map(([id, migrated]) => [id, migrated.agent]),
    ),
  };
  migrated.execution.deadline_mode = "adaptive";
  migrated.execution.no_progress_timeout_ms = 300_000;
  migrated.execution.heartbeat_interval_ms = Math.max(
    1000,
    Math.min(300000, migrated.execution.heartbeat_interval_ms),
  );
  migrated.execution.continuation_attempts ??= 2;
  if (legacyNeedsProviderConcentrationAcknowledgement(migrated)) {
    migrated.execution.allow_provider_concentration = true;
  }
  return {
    config: requireManagedConfig({ ...migrated, schema_version: "7" }),
    warnings: [
      {
        code: "implicit_v9_deadline",
        message:
          "Schema v7 derives an adaptive run deadline and five-minute no-progress timeout.",
        lens_ids: Object.keys(migrated.agents),
      },
      {
        code: "implicit_v9_change_coverage",
        message:
          "Schema v7 derives full-file change coverage for every migrated lens.",
        lens_ids: Object.keys(migrated.agents),
      },
      ...migratedAgents
        .filter(([, migrated]) => migrated.attested)
        .map(([id]) => ({
          code: "attested_coverage_requires_adapter_upgrade" as const,
          message:
            "One or more configured candidates cannot provide Review Mesh-mediated reads; coverage proof is attested.",
          lens_ids: [id],
        })),
    ],
  };
}

function requireAssignments(config: ManagedConfig): void {
  const hasDefaultAssignment = (config.defaults?.agents.length ?? 0) > 0;
  const hasProjectAssignment = Object.values(config.projects ?? {}).some(
    (project) => (project.agents?.length ?? 0) > 0,
  );
  if (!hasDefaultAssignment && !hasProjectAssignment) {
    throw new Error(
      "configuration must assign agents by default or to a project",
    );
  }
}

function appendInstructions(
  agent: ManagedAgent,
  append: unknown,
  reviewerId: string,
): ManagedAgent {
  if (typeof append !== "string" || append.length === 0) return agent;
  if (agent.instructions === undefined) {
    throw new Error(
      `v1 reviewer ${reviewerId} combines instructions_file with append_instructions and cannot be migrated automatically`,
    );
  }
  return { ...agent, instructions: `${agent.instructions}\n\n${append}` };
}

/** Converts the former adapter/profile/roster layout without writing it. */
function migrateV1ConfigResult(value: unknown): ManagedConfigMigration {
  const record = asRecord(value);
  if (record?.schema_version !== "1") {
    throw new Error("configuration is not a Review Mesh v1 configuration");
  }
  // Validate the legacy document before translating it.
  trustedConfigSchema.parse(value);
  const profiles = asRecord(record.reviewer_profiles) ?? {};
  const reviewers = Array.isArray(record.reviewers) ? record.reviewers : [];
  const agents: Record<string, ManagedAgent> = {};
  const defaults: string[] = [];

  for (const definitionValue of reviewers) {
    const definition = asRecord(definitionValue);
    const id = definition?.id;
    const profileId = definition?.profile;
    if (typeof id !== "string" || typeof profileId !== "string") {
      throw new Error("legacy reviewer definition is invalid");
    }
    const profile = asRecord(profiles[profileId]);
    if (profile === undefined) {
      throw new Error(
        `legacy reviewer ${id} references unknown profile ${profileId}`,
      );
    }
    const agent = appendInstructions(
      clone(profile as unknown as ManagedAgent),
      definition?.append_instructions,
      id,
    );
    if (agents[id] !== undefined) {
      throw new Error(`duplicate legacy reviewer id: ${id}`);
    }
    agents[id] = agent;
    defaults.push(id);
  }

  return migrateLegacyShape({
    execution: {
      ...clone(record.execution as ManagedConfig["execution"]),
      distribute_primaries: false,
    },
    diagnostics: clone(record.diagnostics as ManagedConfig["diagnostics"]),
    adapters: clone(record.adapters as TrustedConfigV5["adapters"]),
    agents: agents as unknown as TrustedConfigV5["agents"],
    defaults: { agents: defaults },
    projects: {},
  });
}

export function migrateV1Config(value: unknown): ManagedConfig {
  return migrateV1ConfigResult(value).config;
}

/** Promotes a scalar-agent v2 document to the current managed shape. */
function migrateV2ConfigResult(value: unknown): ManagedConfigMigration {
  const parsed = trustedConfigSchema.parse(value);
  if (parsed.schema_version !== "2") {
    throw new Error("configuration is not a Review Mesh v2 configuration");
  }
  return migrateLegacyShape({
    ...(preserveLegacyPrimaryOrder(
      clone(parsed) as TrustedConfigV2,
    ) as unknown as Omit<TrustedConfigV5, "schema_version">),
    projects: migrateLegacyProjects(parsed.projects),
  });
}

export function migrateV2Config(value: unknown): ManagedConfig {
  return migrateV2ConfigResult(value).config;
}

function migrateLegacyProjects(
  projects: TrustedConfigV2["projects"] | TrustedConfigV3["projects"],
): ManagedConfig["projects"] {
  const migrated: Record<string, ManagedProject> = {};
  const sources = new Map<string, string>();
  for (const [path, project] of Object.entries(projects ?? {})) {
    const name = projectNameFromLegacyPath(path);
    const normalized = name.toLocaleLowerCase("en-US");
    const previous = sources.get(normalized);
    if (previous !== undefined) {
      throw new Error(
        `legacy project paths ${previous} and ${path} both migrate to project name ${name}`,
      );
    }
    sources.set(normalized, path);
    migrated[name] = clone(project);
  }
  return migrated;
}

async function migrateLegacyProjectsByIdentity(
  projects: TrustedConfigV2["projects"] | TrustedConfigV3["projects"],
): Promise<ManagedConfig["projects"]> {
  const migrated: Record<string, ManagedProject> = {};
  const sources = new Map<string, string>();
  for (const [path, project] of Object.entries(projects ?? {})) {
    let name: string;
    try {
      name = (await resolveProjectName(path)).name;
    } catch {
      name = projectNameFromLegacyPath(path);
    }
    const normalized = name.toLocaleLowerCase("en-US");
    const previous = sources.get(normalized);
    if (previous !== undefined) {
      throw new Error(
        `legacy project paths ${previous} and ${path} both migrate to project name ${name}`,
      );
    }
    sources.set(normalized, path);
    migrated[name] = clone(project);
  }
  return migrated;
}

/** Promotes path-keyed multi-model v3 projects to name-keyed v4 projects. */
function migrateV3ConfigResult(value: unknown): ManagedConfigMigration {
  const parsed = trustedConfigSchema.parse(value);
  if (parsed.schema_version !== "3") {
    throw new Error("configuration is not a Review Mesh v3 configuration");
  }
  validateProjectKeys(parsed.projects);
  return migrateLegacyShape({
    ...(preserveLegacyPrimaryOrder(
      clone(parsed) as TrustedConfigV3,
    ) as unknown as Omit<TrustedConfigV5, "schema_version">),
    projects: migrateLegacyProjects(parsed.projects),
  });
}

export function migrateV3Config(value: unknown): ManagedConfig {
  return migrateV3ConfigResult(value).config;
}

export async function migrateLegacyConfigWithWarnings(
  value: unknown,
): Promise<ManagedConfigMigration> {
  const parsed = trustedConfigSchema.parse(value);
  if (parsed.schema_version === "1") return migrateV1ConfigResult(parsed);
  if (parsed.schema_version === "2") {
    validateProjectKeys(parsed.projects);
    return migrateLegacyShape({
      ...(preserveLegacyPrimaryOrder(
        clone(parsed) as TrustedConfigV2,
      ) as unknown as Omit<TrustedConfigV5, "schema_version">),
      projects: await migrateLegacyProjectsByIdentity(parsed.projects),
    });
  }
  if (parsed.schema_version === "3") {
    validateProjectKeys(parsed.projects);
    return migrateLegacyShape({
      ...(preserveLegacyPrimaryOrder(
        clone(parsed) as TrustedConfigV3,
      ) as unknown as Omit<TrustedConfigV5, "schema_version">),
      projects: await migrateLegacyProjectsByIdentity(parsed.projects),
    });
  }
  if (parsed.schema_version === "4") {
    return migrateLegacyShape(
      preserveLegacyPrimaryOrder(
        clone(parsed) as TrustedConfigV4,
      ) as unknown as Omit<TrustedConfigV5, "schema_version">,
    );
  }
  if (parsed.schema_version === "5") {
    const { schema_version: _schemaVersion, ...legacy } = clone(parsed);
    return migrateLegacyShape(legacy, "5");
  }
  if (parsed.schema_version === "6") {
    const { schema_version: _schemaVersion, ...legacy } = clone(parsed);
    return migrateLegacyShape(legacy, "6");
  }
  return { config: requireManagedConfig(parsed), warnings: [] };
}

/** Migrates legacy path keys using repository identity for paths that still exist. */
export async function migrateLegacyConfig(
  value: unknown,
): Promise<ManagedConfig> {
  return (await migrateLegacyConfigWithWarnings(value)).config;
}

export function parseManagedConfig(text: string): {
  config: ManagedConfig;
  migrated: boolean;
  warnings: ConfigMigrationWarning[];
} {
  const parsed = parse(text);
  const version = asRecord(parsed)?.schema_version;
  if (version === "1")
    return { ...migrateV1ConfigResult(parsed), migrated: true };
  if (version === "2")
    return { ...migrateV2ConfigResult(parsed), migrated: true };
  if (version === "3")
    return { ...migrateV3ConfigResult(parsed), migrated: true };
  if (version === "4") {
    const legacy = trustedConfigV4Schema.parse(parsed);
    return {
      ...migrateLegacyShape(
        preserveLegacyPrimaryOrder(
          clone(legacy) as TrustedConfigV4,
        ) as unknown as Omit<TrustedConfigV5, "schema_version">,
      ),
      migrated: true,
    };
  }
  if (version === "5") {
    const legacy = trustedConfigSchema.parse(parsed);
    if (legacy.schema_version !== "5") throw new Error("invalid v5 config");
    const { schema_version: _schemaVersion, ...shape } = clone(legacy);
    const migrated = migrateLegacyShape(shape, "5");
    return { ...migrated, migrated: true };
  }
  if (version === "6") {
    const legacy = trustedConfigSchema.parse(parsed);
    if (legacy.schema_version !== "6") throw new Error("invalid v6 config");
    const { schema_version: _schemaVersion, ...shape } = clone(legacy);
    const migrated = migrateLegacyShape(shape, "6");
    return { ...migrated, migrated: true };
  }
  return {
    config: requireManagedConfig(parsed),
    migrated: false,
    warnings: [],
  };
}

export function serializeManagedConfig(config: ManagedConfig): string {
  const normalized = normalizeManagedConfig(config);
  requireAssignments(normalized);
  const validated = requireManagedConfig(normalized);
  const text = `${stringify(validated)}\n`;
  if (Buffer.byteLength(text, "utf8") > MAX_CONFIG_BYTES) {
    throw new Error("configuration file exceeds the 4 MiB limit");
  }
  requireManagedConfig(parse(text));
  return text;
}

/** Normalizes an in-memory managed shape before a v7-only save. */
export function normalizeManagedConfig(config: ManagedConfig): ManagedConfig {
  if (config.schema_version === "7") {
    const normalized = clone(config);
    normalized.execution.allow_provider_concentration ??= false;
    return normalized;
  }
  const parsed = trustedConfigSchema.parse(config);
  if (parsed.schema_version !== "5" && parsed.schema_version !== "6") {
    throw new Error("configuration is not a Review Mesh legacy configuration");
  }
  const { schema_version: _schemaVersion, ...legacy } = clone(parsed);
  return migrateLegacyShape(legacy, parsed.schema_version === "6" ? "6" : "5")
    .config;
}

export function emptyManagedConfig(): ManagedConfig {
  return {
    schema_version: "7",
    execution: {
      max_concurrency: 2,
      heartbeat_interval_ms: 30_000,
      shutdown_grace_period_ms: 5_000,
      distribute_primaries: true,
      allow_provider_concentration: false,
      default_provider_concurrency: 2,
      provider_limits: {},
      circuit_breaker_threshold: 2,
      circuit_breaker_cooldown_ms: 30_000,
      retry_attempts: 2,
      continuation_attempts: 2,
      retry_backoff_ms: 1_000,
      deadline_mode: "adaptive",
      no_progress_timeout_ms: 300_000,
    },
    diagnostics: { persist_runs: true, max_runs: 50 },
    adapters: {},
    agents: {},
    defaults: { agents: [] },
    projects: {},
  };
}

async function readSnapshot(path: string): Promise<ReadSnapshot> {
  let pathMetadata;
  try {
    pathMetadata = await lstat(path, { bigint: true });
  } catch (error) {
    if (isMissing(error)) return { snapshot: { exists: false } };
    throw error;
  }
  if (pathMetadata.isSymbolicLink() || !pathMetadata.isFile()) {
    throw new Error("configuration path must be a regular file, not a symlink");
  }
  if (pathMetadata.size > BigInt(MAX_CONFIG_BYTES)) {
    throw new Error("configuration file exceeds the 4 MiB limit");
  }
  const flags =
    constants.O_RDONLY |
    (constants.O_NONBLOCK ?? 0) |
    (constants.O_NOFOLLOW ?? 0);
  const handle = await open(path, flags);
  try {
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isFile() ||
      opened.dev !== pathMetadata.dev ||
      opened.ino !== pathMetadata.ino ||
      opened.size > BigInt(MAX_CONFIG_BYTES)
    ) {
      throw new Error("configuration changed while opening");
    }
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= MAX_CONFIG_BYTES) {
      const buffer = Buffer.allocUnsafe(
        Math.min(READ_CHUNK_BYTES, MAX_CONFIG_BYTES + 1 - total),
      );
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const bytes = Buffer.concat(chunks, total);
    const [after, pathAfter] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(path, { bigint: true }),
    ]);
    if (
      bytes.byteLength > MAX_CONFIG_BYTES ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs ||
      pathAfter.isSymbolicLink() ||
      !pathAfter.isFile() ||
      pathAfter.dev !== opened.dev ||
      pathAfter.ino !== opened.ino
    ) {
      throw new Error("configuration changed while reading");
    }
    return {
      snapshot: {
        exists: true,
        hash: sha256(bytes),
        device: opened.dev,
        inode: opened.ino,
      },
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    };
  } finally {
    await handle.close();
  }
}

function sameSnapshot(left: ConfigSnapshot, right: ConfigSnapshot): boolean {
  if (left.exists !== right.exists) return false;
  if (!left.exists) return true;
  return (
    left.hash === right.hash &&
    left.device === right.device &&
    left.inode === right.inode
  );
}

export function configRevision(snapshot: ConfigSnapshot): string {
  return snapshot.exists ? snapshot.hash! : "missing";
}

export async function readConfigRevision(path: string): Promise<string> {
  return configRevision((await readSnapshot(path)).snapshot);
}

export async function loadManagedConfig(
  configFile: string,
  allowMissing = false,
): Promise<LoadedManagedConfig> {
  const current = await readSnapshot(configFile);
  if (!current.snapshot.exists) {
    if (!allowMissing)
      throw new Error(`configuration file does not exist: ${configFile}`);
    return {
      config: emptyManagedConfig(),
      snapshot: current.snapshot,
      migrated: false,
      warnings: [],
    };
  }
  const sourceText = current.text!;
  const source = parse(sourceText);
  const version = asRecord(source)?.schema_version;
  const parsed =
    version === "2" || version === "3"
      ? {
          ...(await migrateLegacyConfigWithWarnings(source)),
          migrated: true,
        }
      : parseManagedConfig(sourceText);
  return { ...parsed, snapshot: current.snapshot, sourceText };
}

async function requireStableParent(parent: string): Promise<{
  path: string;
  device: bigint;
  inode: bigint;
}> {
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const canonical = await realpath(parent);
  const [pathMetadata, metadata] = await Promise.all([
    lstat(parent, { bigint: true }),
    lstat(canonical, { bigint: true }),
  ]);
  if (
    pathMetadata.isSymbolicLink() ||
    !pathMetadata.isDirectory() ||
    !metadata.isDirectory() ||
    pathMetadata.dev !== metadata.dev ||
    pathMetadata.ino !== metadata.ino
  ) {
    throw new Error("configuration directory must be a real directory");
  }
  return { path: canonical, device: metadata.dev, inode: metadata.ino };
}

async function assertStableParent(
  parent: string,
  pinned: { path: string; device: bigint; inode: bigint },
): Promise<void> {
  const canonical = await realpath(parent);
  const [pathMetadata, metadata] = await Promise.all([
    lstat(parent, { bigint: true }),
    lstat(canonical, { bigint: true }),
  ]);
  const samePath =
    process.platform === "win32"
      ? canonical.toLowerCase() === pinned.path.toLowerCase()
      : canonical === pinned.path;
  if (
    !samePath ||
    pathMetadata.isSymbolicLink() ||
    !pathMetadata.isDirectory() ||
    !metadata.isDirectory() ||
    pathMetadata.dev !== metadata.dev ||
    pathMetadata.ino !== metadata.ino ||
    metadata.dev !== pinned.device ||
    metadata.ino !== pinned.inode
  ) {
    throw new Error("configuration directory changed while saving");
  }
}

export async function saveManagedConfig(
  configFile: string,
  config: ManagedConfig,
  expected: ConfigSnapshot,
): Promise<ConfigSnapshot> {
  const text = serializeManagedConfig(config);
  const parent = dirname(resolve(configFile));
  const pinned = await requireStableParent(parent);
  const target = resolve(pinned.path, basename(configFile));
  await assertStableParent(parent, pinned);
  const current = (await readSnapshot(target)).snapshot;
  if (!sameSnapshot(current, expected)) {
    throw new ConfigConflictError();
  }

  const temporary = resolve(
    pinned.path,
    `.${basename(configFile)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const lock = resolve(pinned.path, `.${basename(configFile)}.update.lock`);
  const flags =
    constants.O_WRONLY |
    constants.O_CREAT |
    constants.O_EXCL |
    (constants.O_NOFOLLOW ?? 0);
  let handle;
  let releaseLock: (() => Promise<void>) | undefined;
  try {
    await assertStableParent(parent, pinned);
    handle = await open(temporary, flags, 0o600);
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (process.platform !== "win32") await chmod(temporary, 0o600);
    // Validate the exact bytes that will be published, not just the source
    // object passed to this function.
    parseManagedConfig(await readFile(temporary, "utf8"));
    releaseLock = await acquireConfigLock(lock, pinned);
    await assertStableParent(parent, pinned);
    if (!sameSnapshot((await readSnapshot(target)).snapshot, expected)) {
      throw new ConfigConflictError();
    }
    await rename(temporary, target);
    await assertStableParent(parent, pinned);
    return (await readSnapshot(target)).snapshot;
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    await releaseLock?.().catch(() => undefined);
  }
}

export function requireSafeIdentifier(value: string, label: string): string {
  if (!SAFE_IDENTIFIER.test(value)) {
    throw new Error(
      `${label} must contain only letters, numbers, underscores, and hyphens`,
    );
  }
  return value;
}

export function requireEnvironmentName(value: string): string {
  if (!ENVIRONMENT_NAME.test(value)) {
    throw new Error("environment variable name is invalid");
  }
  return value;
}

export function listConfig(config: ManagedConfig) {
  const defaultAgents = new Set(config.defaults?.agents ?? []);
  return {
    schema_version: config.schema_version,
    agents: Object.entries(config.agents)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, agent]) => ({
        id,
        adapter: agent.adapter,
        ...("model_runs" in agent
          ? { model_runs: clone(agent.model_runs) }
          : {
              model: agent.model,
              ...(agent.effort === undefined ? {} : { effort: agent.effort }),
            }),
        purpose: agent.purpose,
        default: defaultAgents.has(id),
      })),
    projects: Object.entries(config.projects ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, project]) => ({ name, agents: project.agents ?? [] })),
  };
}
