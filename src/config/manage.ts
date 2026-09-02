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
  stat,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { parse, stringify } from "smol-toml";
import type {
  AdapterRegistration,
  ModelRun,
  ReasoningEffort,
  TrustedConfigV2,
} from "./schemas.js";
import type { JsonValue } from "../protocol/schemas.js";
import {
  trustedConfigSchema,
  trustedConfigV3Schema,
  validateAdapterEffort,
} from "./schemas.js";
import { validateProjectKeys } from "./project-paths.js";

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
}

export type ManagedModelRun = {
  id: ModelRun["id"];
  adapter?: string | undefined;
  model: ModelRun["model"];
  effort?: ReasoningEffort | undefined;
};

export type ManagedAgent = ManagedAgentBase &
  (
    | {
        model: string;
        effort?: ReasoningEffort | undefined;
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
  schema_version: "3";
  execution: {
    max_concurrency: number;
    heartbeat_interval_ms: number;
    shutdown_grace_period_ms: number;
  };
  diagnostics: { persist_runs: boolean; max_runs: number };
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

function requireManagedConfig(value: unknown): ManagedConfig {
  const record = asRecord(value);
  if (
    record?.schema_version !== "3" ||
    asRecord(record.execution) === undefined ||
    asRecord(record.diagnostics) === undefined ||
    asRecord(record.adapters) === undefined ||
    asRecord(record.agents) === undefined
  ) {
    throw new Error("configuration is not a Review Mesh v3 configuration");
  }
  const config = clone(
    trustedConfigV3Schema.parse(value) as unknown as ManagedConfig,
  );
  validateProjectKeys(config.projects);
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
export function migrateV1Config(value: unknown): ManagedConfig {
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

  return requireManagedConfig({
    schema_version: "3",
    execution: clone(record.execution as ManagedConfig["execution"]),
    diagnostics: clone(record.diagnostics as ManagedConfig["diagnostics"]),
    adapters: clone(record.adapters as ManagedConfig["adapters"]),
    agents,
    defaults: { agents: defaults },
    projects: {},
  });
}

/** Promotes a scalar-agent v2 document to the current managed shape. */
export function migrateV2Config(value: unknown): ManagedConfig {
  const parsed = trustedConfigSchema.parse(value);
  if (parsed.schema_version !== "2") {
    throw new Error("configuration is not a Review Mesh v2 configuration");
  }
  return requireManagedConfig({
    ...(clone(parsed) as TrustedConfigV2),
    schema_version: "3",
  });
}

export function parseManagedConfig(text: string): {
  config: ManagedConfig;
  migrated: boolean;
} {
  const parsed = parse(text);
  const version = asRecord(parsed)?.schema_version;
  if (version === "1")
    return { config: migrateV1Config(parsed), migrated: true };
  if (version === "2")
    return { config: migrateV2Config(parsed), migrated: true };
  return { config: requireManagedConfig(parsed), migrated: false };
}

export function serializeManagedConfig(config: ManagedConfig): string {
  requireAssignments(config);
  const validated = requireManagedConfig(config);
  const text = `${stringify(validated)}\n`;
  if (Buffer.byteLength(text, "utf8") > MAX_CONFIG_BYTES) {
    throw new Error("configuration file exceeds the 4 MiB limit");
  }
  requireManagedConfig(parse(text));
  return text;
}

export function emptyManagedConfig(): ManagedConfig {
  return {
    schema_version: "3",
    execution: {
      max_concurrency: 2,
      heartbeat_interval_ms: 15_000,
      shutdown_grace_period_ms: 5_000,
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
    };
  }
  const sourceText = current.text!;
  const parsed = parseManagedConfig(sourceText);
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

export async function canonicalProjectPath(
  candidate: string,
  cwd = process.cwd(),
): Promise<string> {
  const canonical = await realpath(resolve(cwd, candidate));
  if (!(await stat(canonical)).isDirectory()) {
    throw new Error("project path must identify an existing directory");
  }
  const slashNormalized = canonical.replaceAll("\\", "/");
  return process.platform === "win32"
    ? slashNormalized.toLowerCase()
    : slashNormalized;
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
      .map(([path, project]) => ({ path, agents: project.agents ?? [] })),
  };
}
