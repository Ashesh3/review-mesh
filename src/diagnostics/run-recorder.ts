import { constants, type Dirent } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
  stat,
  type FileHandle,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { PublicEvent } from "../protocol/schemas.js";

const REDACTED = "[redacted]";
const TRUNCATED = "[truncated]";
const MAX_STRING_BYTES = 64 * 1024;
const SENSITIVE_KEY = /token|secret|password|authorization|api[_-]?key/i;
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_OWNER_NONCE = /^[A-Za-z0-9-]{1,128}$/;
const ACTIVE_RUN_FILE =
  /^(?<runId>.+)\.jsonl\.active\.(?<pid>\d+)\.(?<startedAtMs>\d+)\.(?<nonce>[A-Za-z0-9-]{1,128})$/;
const STALE_ACTIVE_MIN_AGE_MS = 60 * 60 * 1_000;
const STALE_ACTIVE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;

export type RunRecorderOperation = "open" | "link" | "scavenge" | "retention";

export interface RunRecorderProcessIdentity {
  pid: number;
  startedAtMs: number;
  nonce: string;
}

export interface RunRecorderFileSystem {
  mkdir(
    path: string,
    options: { recursive: true },
  ): Promise<string | undefined>;
  readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>;
  stat(path: string): Promise<{ mtimeMs: number }>;
  rm(path: string): Promise<void>;
  link(existingPath: string, newPath: string): Promise<void>;
}

export interface RunRecorder {
  ready(): Promise<void>;
  onEvent(event: PublicEvent): Promise<void>;
  onRecord(record: unknown): Promise<void>;
  close(): Promise<void>;
}

export interface CreateRunRecorderOptions {
  applicationDataRoot: string;
  runsDirectory: string;
  runId: string;
  maxRuns: number;
  resolution: unknown;
  fileSystem?: RunRecorderFileSystem;
  processIdentity?: RunRecorderProcessIdentity;
  now?: () => number;
  isProcessAlive?: (identity: RunRecorderProcessIdentity) => boolean;
  beforeOperation?: (operation: RunRecorderOperation) => Promise<void>;
  publish?: boolean;
}

export interface PathSemantics {
  relative(from: string, to: string): string;
  isAbsolute(path: string): boolean;
  sep: string;
  dirname(path: string): string;
}

const nativePathSemantics: PathSemantics = {
  relative,
  isAbsolute,
  sep,
  dirname,
};

export function isWithinDirectory(
  directory: string,
  target: string,
  pathSemantics: PathSemantics = nativePathSemantics,
): boolean {
  const path = pathSemantics.relative(directory, target);
  return (
    path === "" ||
    (path !== ".." &&
      !path.startsWith(`..${pathSemantics.sep}`) &&
      !pathSemantics.isAbsolute(path))
  );
}

function pathsEqual(
  left: string,
  right: string,
  pathSemantics: PathSemantics,
): boolean {
  if (pathSemantics.sep === "\\") {
    return left.toLocaleLowerCase() === right.toLocaleLowerCase();
  }
  return left === right;
}

export function directoriesBelow(
  root: string,
  target: string,
  pathSemantics: PathSemantics = nativePathSemantics,
): string[] {
  const pending: string[] = [];
  for (let current = target; !pathsEqual(current, root, pathSemantics);) {
    pending.push(current);
    const parent = pathSemantics.dirname(current);
    if (pathsEqual(parent, current, pathSemantics)) {
      throw new Error(
        "could not reach application-data root while walking runs directory",
      );
    }
    current = parent;
  }
  return pending.reverse();
}

function requireSafeRunId(runId: string): void {
  if (!SAFE_RUN_ID.test(runId) || runId === "." || runId === "..") {
    throw new Error("run id must be a safe single filename component");
  }
}

function requireSafeProcessIdentity(
  identity: RunRecorderProcessIdentity,
): void {
  if (
    !Number.isSafeInteger(identity.pid) ||
    identity.pid <= 0 ||
    !Number.isSafeInteger(identity.startedAtMs) ||
    identity.startedAtMs < 0 ||
    !SAFE_OWNER_NONCE.test(identity.nonce)
  ) {
    throw new Error("run recorder process identity is invalid");
  }
}

function currentProcessIdentity(): RunRecorderProcessIdentity {
  return {
    pid: process.pid,
    startedAtMs: Math.max(0, Math.floor(Date.now() - process.uptime() * 1_000)),
    nonce: randomUUID(),
  };
}

function activeRunFileName(
  runId: string,
  identity: RunRecorderProcessIdentity,
): string {
  return `${runId}.jsonl.active.${identity.pid}.${identity.startedAtMs}.${identity.nonce}`;
}

function parseActiveRunFileName(
  name: string,
): RunRecorderProcessIdentity | undefined {
  const match = ACTIVE_RUN_FILE.exec(name);
  if (match?.groups === undefined || !SAFE_RUN_ID.test(match.groups.runId!)) {
    return undefined;
  }
  const identity = {
    pid: Number(match.groups.pid),
    startedAtMs: Number(match.groups.startedAtMs),
    nonce: match.groups.nonce!,
  };
  try {
    requireSafeProcessIdentity(identity);
    return identity;
  } catch {
    return undefined;
  }
}

function processIsAlive(identity: RunRecorderProcessIdentity): boolean {
  try {
    process.kill(identity.pid, 0);
    return true;
  } catch (error) {
    return !(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    );
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

interface FileIdentity {
  dev: number;
  ino: number;
}

interface PinnedDirectory extends FileIdentity {
  canonicalPath: string;
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function pinRunsDirectory(
  canonicalRoot: string,
  runsDirectory: string,
): Promise<PinnedDirectory> {
  const canonicalPath = await realpath(runsDirectory);
  if (!isWithinDirectory(canonicalRoot, canonicalPath)) {
    throw new Error("runs directory resolved outside application-data root");
  }
  const directory = await lstat(runsDirectory);
  if (directory.isSymbolicLink() || !directory.isDirectory()) {
    throw new Error("runs directory identity is unsafe");
  }
  return { canonicalPath, dev: directory.dev, ino: directory.ino };
}

async function assertPinnedRunsDirectory(
  runsDirectory: string,
  pinned: PinnedDirectory,
): Promise<void> {
  const [canonicalPath, directory] = await Promise.all([
    realpath(runsDirectory),
    lstat(runsDirectory),
  ]);
  if (
    !pathsEqual(canonicalPath, pinned.canonicalPath, nativePathSemantics) ||
    directory.isSymbolicLink() ||
    !directory.isDirectory() ||
    !sameFileIdentity(directory, pinned)
  ) {
    throw new Error("runs directory changed during record persistence");
  }
}

async function regularFileIdentity(path: string): Promise<FileIdentity> {
  const entry = await lstat(path);
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new Error("run record path is not a regular file");
  }
  return { dev: entry.dev, ino: entry.ino };
}

async function removeFromPinnedDirectory(
  fileSystem: RunRecorderFileSystem,
  runsDirectory: string,
  pinned: PinnedDirectory,
  path: string,
): Promise<void> {
  await assertPinnedRunsDirectory(runsDirectory, pinned);
  try {
    await fileSystem.rm(path);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  await assertPinnedRunsDirectory(runsDirectory, pinned);
}

function boundedText(value: string, suffix = ""): string {
  const encodedValue = Buffer.from(value, "utf8");
  const encodedSuffix = Buffer.from(suffix, "utf8");
  if (encodedValue.length + encodedSuffix.length <= MAX_STRING_BYTES) {
    return value + suffix;
  }
  const marker = `${TRUNCATED}${suffix}`;
  const markerBytes = Buffer.byteLength(marker, "utf8");
  let end = Math.max(0, MAX_STRING_BYTES - markerBytes);
  end = Math.min(end, encodedValue.length);
  while (end > 0 && ((encodedValue[end] ?? 0) & 0xc0) === 0x80) {
    end -= 1;
  }
  return encodedValue.subarray(0, end).toString("utf8") + marker;
}

function redactString(value: string): string {
  return value
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu, "$1[redacted]@")
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gu,
      REDACTED,
    )
    .replace(
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
      REDACTED,
    )
    .replace(/\bauthorization\s*[:=]\s*bearer\s+[^\s,;]+/giu, REDACTED)
    .replace(
      /\b(?:authorization|api[_-]?key|access[_-]?token|client[_-]?secret|password|secret|accountkey)\s*[:=]\s*[^\s,;]+/giu,
      REDACTED,
    )
    .replace(
      /\b(?:DefaultEndpointsProtocol|AccountName|AccountKey|EndpointSuffix)=[^;\s]+(?:;[^\s]*)?/giu,
      REDACTED,
    )
    .replace(/\bBearer\s+[^\s,;]+/giu, REDACTED)
    .replace(/(https?:\/\/[^\s/?#]+\/[^\s?#]*)\?[^\s#]*/giu, "$1?[redacted]");
}

function sanitize(value: unknown): unknown {
  if (typeof value === "string") return boundedText(redactString(value));
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(sanitize);
  if (typeof value === "object") {
    const record = Object.create(null) as Record<string, unknown>;
    for (const [originalKey, child] of Object.entries(value)) {
      let key = boundedText(originalKey);
      let occurrence = 1;
      while (Object.hasOwn(record, key)) {
        occurrence += 1;
        key = boundedText(originalKey, `~${occurrence}`);
      }
      record[key] = SENSITIVE_KEY.test(originalKey)
        ? REDACTED
        : sanitize(child);
    }
    return record;
  }
  return null;
}

function line(value: unknown): string {
  return `${JSON.stringify(sanitize(value))}\n`;
}

function recordLine(value: unknown): string {
  if (
    typeof value === "object" &&
    value !== null &&
    "record" in value &&
    value.record === "reviewer.result"
  ) {
    return `${JSON.stringify(value)}\n`;
  }
  return line(value);
}

async function lstatIfPresent(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function ensureSafeRunsDirectory(
  applicationDataRoot: string,
  runsDirectory: string,
): Promise<void> {
  const root = resolve(applicationDataRoot);
  const runs = resolve(runsDirectory);
  if (!isWithinDirectory(root, runs)) {
    throw new Error("runs directory must be within the application-data root");
  }
  await mkdir(root, { recursive: true });
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink()) {
    throw new Error("application-data root must not be a symlink");
  }

  for (const directory of directoriesBelow(root, runs)) {
    const existing = await lstatIfPresent(directory);
    if (existing !== undefined) {
      if (existing.isSymbolicLink() || !existing.isDirectory()) {
        throw new Error("runs directory must not contain a symlink");
      }
      continue;
    }
    await mkdir(directory);
    const created = await lstat(directory);
    if (created.isSymbolicLink() || !created.isDirectory()) {
      throw new Error("runs directory must not contain a symlink");
    }
  }
}

async function removeExpiredRuns(
  fileSystem: RunRecorderFileSystem,
  runsDirectory: string,
  maxRuns: number,
  pinned: PinnedDirectory,
  beforeOperation: (operation: RunRecorderOperation) => Promise<void>,
): Promise<void> {
  for (;;) {
    await beforeOperation("retention");
    await assertPinnedRunsDirectory(runsDirectory, pinned);
    const entries = await fileSystem.readdir(runsDirectory, {
      withFileTypes: true,
    });
    await assertPinnedRunsDirectory(runsDirectory, pinned);
    const candidates = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
        .map(async (entry) => {
          const path = join(runsDirectory, entry.name);
          try {
            await assertPinnedRunsDirectory(runsDirectory, pinned);
            const mtimeMs = (await fileSystem.stat(path)).mtimeMs;
            await assertPinnedRunsDirectory(runsDirectory, pinned);
            return { path, mtimeMs };
          } catch (error) {
            if (isNotFound(error)) return undefined;
            throw error;
          }
        }),
    );
    const records = candidates
      .filter((candidate) => candidate !== undefined)
      .sort(
        (left, right) =>
          left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path),
      );
    if (records.length <= maxRuns) return;
    const oldest = records[0];
    if (oldest === undefined) return;
    try {
      await removeFromPinnedDirectory(
        fileSystem,
        runsDirectory,
        pinned,
        oldest.path,
      );
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
}

async function removeStaleActiveRuns(
  fileSystem: RunRecorderFileSystem,
  runsDirectory: string,
  now: number,
  isProcessAlive: (identity: RunRecorderProcessIdentity) => boolean,
  pinned: PinnedDirectory,
  beforeOperation: (operation: RunRecorderOperation) => Promise<void>,
): Promise<void> {
  await beforeOperation("scavenge");
  await assertPinnedRunsDirectory(runsDirectory, pinned);
  const entries = await fileSystem.readdir(runsDirectory, {
    withFileTypes: true,
  });
  await assertPinnedRunsDirectory(runsDirectory, pinned);
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isFile()) return;
      const identity = parseActiveRunFileName(entry.name);
      if (identity === undefined) return;
      const path = join(runsDirectory, entry.name);
      let mtimeMs: number;
      try {
        await assertPinnedRunsDirectory(runsDirectory, pinned);
        mtimeMs = (await fileSystem.stat(path)).mtimeMs;
        await assertPinnedRunsDirectory(runsDirectory, pinned);
      } catch (error) {
        if (isNotFound(error)) return;
        throw error;
      }
      const age = now - mtimeMs;
      if (age < STALE_ACTIVE_MIN_AGE_MS) return;
      if (age < STALE_ACTIVE_MAX_AGE_MS && isProcessAlive(identity)) return;
      try {
        await removeFromPinnedDirectory(
          fileSystem,
          runsDirectory,
          pinned,
          path,
        );
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }),
  );
}

const nodeFileSystem: RunRecorderFileSystem = {
  mkdir,
  readdir,
  stat,
  rm,
  link,
};

export function createRunRecorder({
  applicationDataRoot,
  runsDirectory,
  runId,
  maxRuns,
  resolution,
  fileSystem = nodeFileSystem,
  processIdentity = currentProcessIdentity(),
  now = Date.now,
  isProcessAlive = processIsAlive,
  beforeOperation = async () => undefined,
  publish = true,
}: CreateRunRecorderOptions): RunRecorder {
  requireSafeRunId(runId);
  requireSafeProcessIdentity(processIdentity);
  const resolvedRunsDirectory = resolve(runsDirectory);
  const resolvedRoot = resolve(applicationDataRoot);
  if (!isWithinDirectory(resolvedRoot, resolvedRunsDirectory)) {
    throw new Error("runs directory must be within the application-data root");
  }
  const runFile = join(resolvedRunsDirectory, `${runId}.jsonl`);
  const activeRunFile = join(
    resolvedRunsDirectory,
    activeRunFileName(runId, processIdentity),
  );
  let initialized: Promise<FileHandle> | undefined;
  let tail = Promise.resolve();
  let closePromise: Promise<void> | undefined;
  let pinnedRunsDirectory: PinnedDirectory | undefined;
  let state: "open" | "closing" | "closed" = "open";

  const initialize = (): Promise<FileHandle> => {
    initialized ??= (async () => {
      await ensureSafeRunsDirectory(resolvedRoot, resolvedRunsDirectory);
      if ((await lstatIfPresent(runFile)) !== undefined) {
        throw new Error("run record already exists or is a symlink");
      }
      const canonicalRoot = await realpath(resolvedRoot);
      const pinned = await pinRunsDirectory(
        canonicalRoot,
        resolvedRunsDirectory,
      );
      pinnedRunsDirectory = pinned;
      await removeStaleActiveRuns(
        fileSystem,
        resolvedRunsDirectory,
        now(),
        isProcessAlive,
        pinned,
        beforeOperation,
      );
      const flags =
        constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0);
      await beforeOperation("open");
      await assertPinnedRunsDirectory(resolvedRunsDirectory, pinned);
      const handle = await open(activeRunFile, flags, 0o600);
      try {
        await assertPinnedRunsDirectory(resolvedRunsDirectory, pinned);
        const handleIdentity = await handle.stat();
        const activeIdentity = await regularFileIdentity(activeRunFile);
        if (
          !handleIdentity.isFile() ||
          !sameFileIdentity(handleIdentity, activeIdentity)
        ) {
          throw new Error("active run record identity changed during open");
        }
        await handle.appendFile(
          line({ record: "resolution", run_id: runId, resolution }),
        );
        return handle;
      } catch (error) {
        await handle.close().catch(() => undefined);
        await removeFromPinnedDirectory(
          fileSystem,
          resolvedRunsDirectory,
          pinned,
          activeRunFile,
        ).catch(() => undefined);
        throw error;
      }
    })();
    return initialized;
  };

  const enqueue = (operation: () => Promise<void>): Promise<void> => {
    const result = tail.then(operation);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  return {
    async ready() {
      await initialize();
    },
    onEvent(event) {
      if (state !== "open") {
        return Promise.reject(new Error("Run recorder is closing or closed"));
      }
      return enqueue(async () => {
        const handle = await initialize();
        await handle.appendFile(line(event));
      });
    },
    onRecord(record) {
      if (state !== "open") {
        return Promise.reject(new Error("Run recorder is closing or closed"));
      }
      return enqueue(async () => {
        const handle = await initialize();
        await handle.appendFile(recordLine(record));
      });
    },
    close(): Promise<void> {
      if (closePromise !== undefined) return closePromise;
      state = "closing";
      const pending = tail;
      closePromise = (async () => {
        try {
          await pending;
          if (initialized === undefined) return;
          const handle = await initialized;
          const pinned = pinnedRunsDirectory;
          if (pinned === undefined) {
            throw new Error("runs directory identity was not initialized");
          }
          let published = false;
          try {
            if (publish) {
              await beforeOperation("link");
              await assertPinnedRunsDirectory(resolvedRunsDirectory, pinned);
              await fileSystem.link(activeRunFile, runFile);
              published = true;
              await assertPinnedRunsDirectory(resolvedRunsDirectory, pinned);
              const [handleIdentity, activeIdentity, finalIdentity] =
                await Promise.all([
                  handle.stat(),
                  regularFileIdentity(activeRunFile),
                  regularFileIdentity(runFile),
                ]);
              if (
                !handleIdentity.isFile() ||
                !sameFileIdentity(handleIdentity, activeIdentity) ||
                !sameFileIdentity(handleIdentity, finalIdentity)
              ) {
                throw new Error(
                  "published run record identity does not match active handle",
                );
              }
            }
          } catch (error) {
            if (published) {
              await removeFromPinnedDirectory(
                fileSystem,
                resolvedRunsDirectory,
                pinned,
                runFile,
              ).catch(() => undefined);
            }
            await removeFromPinnedDirectory(
              fileSystem,
              resolvedRunsDirectory,
              pinned,
              activeRunFile,
            ).catch(() => undefined);
            await handle.close().catch(() => undefined);
            throw error;
          }
          await handle.close();
          await removeFromPinnedDirectory(
            fileSystem,
            resolvedRunsDirectory,
            pinned,
            activeRunFile,
          );
          await removeStaleActiveRuns(
            fileSystem,
            resolvedRunsDirectory,
            now(),
            isProcessAlive,
            pinned,
            beforeOperation,
          );
          await removeExpiredRuns(
            fileSystem,
            resolvedRunsDirectory,
            maxRuns,
            pinned,
            beforeOperation,
          );
        } finally {
          state = "closed";
        }
      })();
      return closePromise;
    },
  };
}
