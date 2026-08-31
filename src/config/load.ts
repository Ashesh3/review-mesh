import { constants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { parse } from "smol-toml";
import {
  repositoryPolicySchema,
  trustedConfigSchema,
  type RepositoryPolicy,
  type TrustedConfig,
} from "./schemas.js";
import { getAppPaths } from "./paths.js";

export const maximumRepositoryPolicyBytes = 1024 * 1024;
const maximumTrustedTextBytes = 4 * 1024 * 1024;
const readChunkBytes = 64 * 1024;
const defaultReadTimeoutMs = 15_000;

export interface LoadConfigFilesInput {
  configFile?: string;
  workspace: string;
  signal?: AbortSignal;
}

export interface LoadConfigFilesDependencies {
  /** Test seam used to exercise path replacement and cancellation races. */
  afterRepositoryOpen?: (path: string) => void | Promise<void>;
  repositoryRead?: ConfigFileRead;
  readTimeoutMs?: number;
}

export type ConfigFileRead = (
  handle: FileHandle,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number | null,
) => Promise<{ bytesRead: number }>;

export interface LoadedConfigFiles {
  trusted: TrustedConfig;
  repository?: RepositoryPolicy;
}

function isWithinDirectory(directory: string, target: string): boolean {
  const path = relative(directory, target);
  return (
    path === "" ||
    (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted.", "AbortError");
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

type FileSnapshot = Awaited<ReturnType<FileHandle["stat"]>>;

function isSameObject(left: FileSnapshot, right: FileSnapshot): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isSameSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
  return (
    isSameObject(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

interface FileHandleLease {
  handle: FileHandle;
  close: () => Promise<void>;
  interrupt: () => void;
}

function leaseFileHandle(handle: FileHandle): FileHandleLease {
  let interrupted = false;
  let closePromise: Promise<void> | undefined;
  const beginClose = (): Promise<void> => {
    closePromise ??= handle.close();
    void closePromise.catch(() => undefined);
    return closePromise;
  };
  return {
    handle,
    interrupt: () => {
      interrupted = true;
      void beginClose();
    },
    close: async () => {
      const closing = beginClose();
      if (!interrupted) await closing;
    },
  };
}

const defaultFileRead: ConfigFileRead = async (
  handle,
  buffer,
  offset,
  length,
  position,
) => handle.read(buffer, offset, length, position);

async function readOnce(
  lease: FileHandleLease,
  buffer: Buffer,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  read: ConfigFileRead,
): Promise<{ bytesRead: number }> {
  throwIfAborted(signal);
  const reading = Promise.resolve().then(() =>
    read(lease.handle, buffer, 0, buffer.length, null),
  );
  // Promise.race observes the operation while it is pending; this additional
  // observer also contains a rejection that arrives after cancellation wins.
  void reading.catch(() => undefined);

  let timer: NodeJS.Timeout | undefined;
  let abortListener: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    abortListener = () => {
      lease.interrupt();
      try {
        throwIfAborted(signal);
      } catch (error: unknown) {
        reject(error);
      }
    };
    signal?.addEventListener("abort", abortListener, { once: true });
    if (signal?.aborted) abortListener();
    timer = setTimeout(() => {
      lease.interrupt();
      reject(
        new Error(`configuration file read timed out after ${timeoutMs}ms`),
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([reading, interrupted]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abortListener !== undefined) {
      signal?.removeEventListener("abort", abortListener);
    }
  }
}

async function readHandleBounded(
  lease: FileHandleLease,
  maximumBytes: number,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  read: ConfigFileRead,
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    throwIfAborted(signal);
    const buffer = Buffer.allocUnsafe(
      Math.min(readChunkBytes, maximumBytes + 1 - total),
    );
    const { bytesRead } = await readOnce(
      lease,
      buffer,
      signal,
      timeoutMs,
      read,
    );
    throwIfAborted(signal);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maximumBytes) {
      throw new Error(`configuration file exceeds ${maximumBytes} bytes`);
    }
    chunks.push(buffer.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

async function readTrustedText(
  path: string,
  signal: AbortSignal | undefined,
  readTimeoutMs: number,
): Promise<string> {
  throwIfAborted(signal);
  const canonicalPath = await realpath(path);
  const lease = leaseFileHandle(await open(canonicalPath, constants.O_RDONLY));
  try {
    const snapshot = await lease.handle.stat();
    if (!snapshot.isFile()) {
      throw new Error("trusted configuration text must be a regular file");
    }
    if (snapshot.size > maximumTrustedTextBytes) {
      throw new Error("trusted configuration text is too large");
    }
    return await readHandleBounded(
      lease,
      maximumTrustedTextBytes,
      signal,
      readTimeoutMs,
      defaultFileRead,
    );
  } finally {
    await lease.close();
  }
}

async function readRepositoryPolicy(
  workspacePath: string,
  signal: AbortSignal | undefined,
  dependencies: LoadConfigFilesDependencies,
  readTimeoutMs: number,
): Promise<string | undefined> {
  throwIfAborted(signal);
  const workspace = await realpath(workspacePath);
  const repositoryFile = resolve(workspace, ".review-mesh.toml");
  if (!isWithinDirectory(workspace, repositoryFile)) {
    throw new Error("repository policy escapes the workspace");
  }

  let before: FileSnapshot;
  try {
    before = await lstat(repositoryFile);
  } catch (error: unknown) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error("repository policy must be a regular file");
  }
  if (before.size > maximumRepositoryPolicyBytes) {
    throw new Error("repository policy is too large");
  }

  const canonicalBefore = await realpath(repositoryFile);
  if (!isWithinDirectory(workspace, canonicalBefore)) {
    throw new Error("repository policy escapes the workspace");
  }

  const flags =
    constants.O_RDONLY |
    (constants.O_NONBLOCK ?? 0) |
    (constants.O_NOFOLLOW ?? 0);
  const lease = leaseFileHandle(await open(repositoryFile, flags));
  try {
    const opened = await lease.handle.stat();
    if (
      !opened.isFile() ||
      !isSameSnapshot(before, opened) ||
      opened.size > maximumRepositoryPolicyBytes
    ) {
      throw new Error("repository policy changed while it was opened");
    }

    await dependencies.afterRepositoryOpen?.(repositoryFile);
    throwIfAborted(signal);
    const text = await readHandleBounded(
      lease,
      maximumRepositoryPolicyBytes,
      signal,
      readTimeoutMs,
      dependencies.repositoryRead ?? defaultFileRead,
    );

    const [openedAfter, pathAfter, canonicalAfter] = await Promise.all([
      lease.handle.stat(),
      lstat(repositoryFile),
      realpath(repositoryFile),
    ]);
    if (
      !openedAfter.isFile() ||
      !pathAfter.isFile() ||
      pathAfter.isSymbolicLink() ||
      !isSameSnapshot(opened, openedAfter) ||
      !isSameObject(openedAfter, pathAfter) ||
      canonicalAfter !== canonicalBefore ||
      !isWithinDirectory(workspace, canonicalAfter)
    ) {
      throw new Error("repository policy changed while it was read");
    }
    return text;
  } finally {
    await lease.close();
  }
}

async function resolveInstructionFiles(
  trusted: TrustedConfig,
  configFile: string,
  signal: AbortSignal | undefined,
  readTimeoutMs: number,
): Promise<TrustedConfig> {
  const trustedDirectory = dirname(await realpath(configFile));
  const profiles = await Promise.all(
    Object.entries(trusted.reviewer_profiles).map(async ([id, profile]) => {
      if (profile.instructions_file === undefined) {
        return [id, profile] as const;
      }
      const instructionFile = await realpath(
        resolve(trustedDirectory, profile.instructions_file),
      );
      if (!isWithinDirectory(trustedDirectory, instructionFile)) {
        throw new Error(
          `instruction file escapes trusted configuration directory: ${profile.instructions_file}`,
        );
      }
      const { instructions_file: _instructionsFile, ...remainingProfile } =
        profile;
      return [
        id,
        {
          ...remainingProfile,
          instructions: await readTrustedText(
            instructionFile,
            signal,
            readTimeoutMs,
          ),
        },
      ] as const;
    }),
  );

  return trustedConfigSchema.parse({
    ...trusted,
    reviewer_profiles: Object.fromEntries(profiles),
  });
}

export async function loadConfigFiles(
  input: LoadConfigFilesInput,
  dependencies: LoadConfigFilesDependencies = {},
): Promise<LoadedConfigFiles> {
  const readTimeoutMs = dependencies.readTimeoutMs ?? defaultReadTimeoutMs;
  if (!Number.isSafeInteger(readTimeoutMs) || readTimeoutMs <= 0) {
    throw new Error("configuration read timeout must be a positive integer");
  }
  const configFile = input.configFile ?? getAppPaths().configFile;
  const trusted = trustedConfigSchema.parse(
    parse(await readTrustedText(configFile, input.signal, readTimeoutMs)),
  );
  const repositoryText = await readRepositoryPolicy(
    input.workspace,
    input.signal,
    dependencies,
    readTimeoutMs,
  );
  const repository =
    repositoryText === undefined
      ? undefined
      : repositoryPolicySchema.parse(parse(repositoryText));

  return {
    trusted: await resolveInstructionFiles(
      trusted,
      configFile,
      input.signal,
      readTimeoutMs,
    ),
    ...(repository === undefined ? {} : { repository }),
  };
}
