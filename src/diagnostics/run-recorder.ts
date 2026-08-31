import { constants, type Dirent } from "node:fs";
import {
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

export interface RunRecorderFileSystem {
  mkdir(
    path: string,
    options: { recursive: true },
  ): Promise<string | undefined>;
  readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>;
  stat(path: string): Promise<{ mtimeMs: number }>;
  rm(path: string): Promise<void>;
}

export interface RunRecorder {
  onEvent(event: PublicEvent): Promise<void>;
  close(): Promise<void>;
}

export interface CreateRunRecorderOptions {
  applicationDataRoot: string;
  runsDirectory: string;
  runId: string;
  maxRuns: number;
  resolution: unknown;
  fileSystem?: RunRecorderFileSystem;
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

function boundedText(value: string, suffix = ""): string {
  if (
    Buffer.byteLength(value, "utf8") + Buffer.byteLength(suffix, "utf8") <=
    MAX_STRING_BYTES
  ) {
    return value + suffix;
  }
  const marker = `${TRUNCATED}${suffix}`;
  const markerBytes = Buffer.byteLength(marker, "utf8");
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes + markerBytes > MAX_STRING_BYTES) break;
    result += character;
    bytes += characterBytes;
  }
  return result + marker;
}

function sanitize(value: unknown): unknown {
  if (typeof value === "string") return boundedText(value);
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
): Promise<void> {
  for (;;) {
    const entries = await fileSystem.readdir(runsDirectory, {
      withFileTypes: true,
    });
    const candidates = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
        .map(async (entry) => {
          const path = join(runsDirectory, entry.name);
          try {
            return { path, mtimeMs: (await fileSystem.stat(path)).mtimeMs };
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
      await fileSystem.rm(oldest.path);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
}

const nodeFileSystem: RunRecorderFileSystem = { mkdir, readdir, stat, rm };

export function createRunRecorder({
  applicationDataRoot,
  runsDirectory,
  runId,
  maxRuns,
  resolution,
  fileSystem = nodeFileSystem,
}: CreateRunRecorderOptions): RunRecorder {
  requireSafeRunId(runId);
  const resolvedRunsDirectory = resolve(runsDirectory);
  const resolvedRoot = resolve(applicationDataRoot);
  if (!isWithinDirectory(resolvedRoot, resolvedRunsDirectory)) {
    throw new Error("runs directory must be within the application-data root");
  }
  const runFile = join(resolvedRunsDirectory, `${runId}.jsonl`);
  let initialized: Promise<FileHandle> | undefined;
  let tail = Promise.resolve();

  const initialize = (): Promise<FileHandle> => {
    initialized ??= (async () => {
      await ensureSafeRunsDirectory(resolvedRoot, resolvedRunsDirectory);
      if ((await lstatIfPresent(runFile)) !== undefined) {
        throw new Error("run record already exists or is a symlink");
      }
      const canonicalRoot = await realpath(resolvedRoot);
      const canonicalRunsDirectory = await realpath(resolvedRunsDirectory);
      if (!isWithinDirectory(canonicalRoot, canonicalRunsDirectory)) {
        throw new Error(
          "runs directory resolved outside application-data root",
        );
      }
      const flags =
        constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW;
      const handle = await open(runFile, flags, 0o600);
      try {
        await handle.appendFile(
          line({ record: "resolution", run_id: runId, resolution }),
        );
        await removeExpiredRuns(fileSystem, resolvedRunsDirectory, maxRuns);
        return handle;
      } catch (error) {
        await handle.close().catch(() => undefined);
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
    onEvent(event) {
      return enqueue(async () => {
        const handle = await initialize();
        await handle.appendFile(line(event));
      });
    },
    async close(): Promise<void> {
      await tail;
      if (initialized === undefined) return;
      const handle = await initialized;
      await handle.close();
    },
  };
}
