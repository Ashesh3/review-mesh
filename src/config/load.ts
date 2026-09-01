import { constants } from "node:fs";
import { open, realpath, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { parse } from "smol-toml";
import {
  trustedConfigSchema,
  trustedConfigV1Schema,
  trustedConfigV2Schema,
  type ProjectConfig,
  type ReviewerProfile,
  type TrustedConfig,
} from "./schemas.js";
import { getAppPaths } from "./paths.js";

const maximumTrustedTextBytes = 4 * 1024 * 1024;
const readChunkBytes = 64 * 1024;
const defaultReadTimeoutMs = 15_000;

export interface LoadConfigFilesInput {
  configFile?: string;
  workspace: string;
  signal?: AbortSignal;
}

export interface LoadConfigFilesDependencies {
  trustedRead?: ConfigFileRead;
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
  workspace: string;
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
  read: ConfigFileRead = defaultFileRead,
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
      read,
    );
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
  const resolveEntries = async <T extends ReviewerProfile | ProjectConfig>(
    entries: Array<[string, T]>,
  ) =>
    Promise.all(
      entries.map(async ([id, profile]) => {
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
  if (trusted.schema_version === "1") {
    return trustedConfigV1Schema.parse({
      ...trusted,
      reviewer_profiles: Object.fromEntries(
        await resolveEntries(Object.entries(trusted.reviewer_profiles)),
      ),
    });
  }
  return trustedConfigV2Schema.parse({
    ...trusted,
    agents: Object.fromEntries(
      await resolveEntries(Object.entries(trusted.agents)),
    ),
    projects: Object.fromEntries(
      await resolveEntries(Object.entries(trusted.projects ?? {})),
    ),
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
    parse(
      await readTrustedText(
        configFile,
        input.signal,
        readTimeoutMs,
        dependencies.trustedRead,
      ),
    ),
  );
  const resolvedTrusted = await resolveInstructionFiles(
    trusted,
    configFile,
    input.signal,
    readTimeoutMs,
  );

  return {
    trusted: resolvedTrusted,
    workspace: await realpath(input.workspace),
  };
}
