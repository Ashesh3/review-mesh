import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const MAX_RESULT_SPOOL_BYTES = 16 * 1024 * 1024;

export type ResultSpoolErrorCode =
  | "identity_changed"
  | "invalid_utf8"
  | "result_too_large"
  | "unsafe_directory";

export class ResultSpoolError extends Error {
  constructor(
    readonly code: ResultSpoolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ResultSpoolError";
  }
}

export interface ResultSpool {
  readonly path: string;
  readonly byteLength: number;
  append(fragment: string | Uint8Array): Promise<void>;
  read(): Promise<Buffer>;
  readText(): Promise<string>;
  cleanup(): Promise<void>;
}

export interface CreateResultSpoolOptions {
  directory: string;
  id: string;
  reviewedWorkspace?: string;
  /** Test seam for deterministic pathname-replacement races after open. */
  afterCreateOpen?(path: string): void | Promise<void>;
  /** Test seam for deterministic replacement after cleanup quarantine. */
  beforeCleanupRemove?(path: string): void | Promise<void>;
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev !== 0n && left.ino !== 0n && left.dev === right.dev && left.ino === right.ino;
}

function pathIsInside(root: string, target: string): boolean {
  const candidate = relative(root, target);
  return (
    candidate === "" ||
    (!isAbsolute(candidate) && candidate !== ".." && !candidate.startsWith(`..${sep}`))
  );
}

class FileResultSpool implements ResultSpool {
  private length = 0;
  private closed = false;

  constructor(
    readonly path: string,
    private readonly ownedDirectory: string,
    private readonly ownedDirectoryIdentity: BigIntStats,
    private readonly handle: FileHandle,
    private readonly fileIdentity: BigIntStats,
    private readonly beforeCleanupRemove:
      | ((path: string) => void | Promise<void>)
      | undefined,
  ) {}

  get byteLength(): number {
    return this.length;
  }

  private async verifyIdentity(): Promise<void> {
    if (this.closed) {
      throw new ResultSpoolError("identity_changed", "The result spool is closed.");
    }
    let directory: BigIntStats;
    let file: BigIntStats;
    let opened: BigIntStats;
    try {
      [directory, file, opened] = await Promise.all([
        lstat(this.ownedDirectory, { bigint: true }),
        lstat(this.path, { bigint: true }),
        this.handle.stat({ bigint: true }),
      ]);
    } catch {
      throw new ResultSpoolError(
        "identity_changed",
        "The result spool path changed identity.",
      );
    }
    if (
      directory.isSymbolicLink() ||
      !directory.isDirectory() ||
      file.isSymbolicLink() ||
      !file.isFile() ||
      !opened.isFile() ||
      !sameIdentity(this.ownedDirectoryIdentity, directory) ||
      !sameIdentity(this.fileIdentity, file) ||
      !sameIdentity(this.fileIdentity, opened)
    ) {
      throw new ResultSpoolError(
        "identity_changed",
        "The result spool path changed identity.",
      );
    }
  }

  async append(fragment: string | Uint8Array): Promise<void> {
    const bytes =
      typeof fragment === "string"
        ? Buffer.from(fragment, "utf8")
        : Buffer.from(fragment.buffer, fragment.byteOffset, fragment.byteLength);
    if (this.length + bytes.byteLength > MAX_RESULT_SPOOL_BYTES) {
      throw new ResultSpoolError(
        "result_too_large",
        "The assembled reviewer result exceeds the 16 MiB limit.",
      );
    }
    await this.verifyIdentity();
    let written = 0;
    while (written < bytes.byteLength) {
      const result = await this.handle.write(
        bytes,
        written,
        bytes.byteLength - written,
        this.length + written,
      );
      if (result.bytesWritten < 1) {
        throw new ResultSpoolError(
          "identity_changed",
          "The result spool could not accept the complete fragment.",
        );
      }
      written += result.bytesWritten;
    }
    this.length += written;
    await this.verifyIdentity();
  }

  async read(): Promise<Buffer> {
    await this.verifyIdentity();
    const opened = await this.handle.stat({ bigint: true });
    if (opened.size !== BigInt(this.length)) {
      throw new ResultSpoolError(
        "identity_changed",
        "The result spool size changed unexpectedly.",
      );
    }
    const bytes = Buffer.allocUnsafe(this.length);
    let read = 0;
    while (read < bytes.byteLength) {
      const result = await this.handle.read(
        bytes,
        read,
        bytes.byteLength - read,
        read,
      );
      if (result.bytesRead === 0) {
        throw new ResultSpoolError(
          "identity_changed",
          "The result spool ended before all accepted bytes were read.",
        );
      }
      read += result.bytesRead;
    }
    await this.verifyIdentity();
    return bytes;
  }

  async readText(): Promise<string> {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(await this.read());
    } catch (error) {
      if (error instanceof ResultSpoolError) throw error;
      throw new ResultSpoolError(
        "invalid_utf8",
        "The assembled reviewer result is not valid UTF-8.",
      );
    }
  }

  async cleanup(): Promise<void> {
    if (this.closed) return;
    try {
      await this.verifyIdentity();
    } catch (error) {
      this.closed = true;
      await this.handle.close().catch(() => undefined);
      throw error;
    }
    this.closed = true;
    await this.handle.close();
    const quarantineDirectory = `${this.ownedDirectory}.cleanup-${randomUUID()}`;
    await rename(this.ownedDirectory, quarantineDirectory);
    const quarantinePath = resolve(
      quarantineDirectory,
      this.path.slice(this.ownedDirectory.length + 1),
    );
    const verifyQuarantine = async () => {
      const [directory, file] = await Promise.all([
        lstat(quarantineDirectory, { bigint: true }).catch(() => undefined),
        lstat(quarantinePath, { bigint: true }).catch(() => undefined),
      ]);
      if (
        directory === undefined ||
        file === undefined ||
        directory.isSymbolicLink() ||
        !directory.isDirectory() ||
        file.isSymbolicLink() ||
        !file.isFile() ||
        !sameIdentity(this.ownedDirectoryIdentity, directory) ||
        !sameIdentity(this.fileIdentity, file)
      ) {
        throw new ResultSpoolError(
          "identity_changed",
          "The result spool changed identity during cleanup.",
        );
      }
    };
    await verifyQuarantine();
    await this.beforeCleanupRemove?.(quarantinePath);
    await verifyQuarantine();
    await rm(quarantineDirectory, { recursive: true, force: false });
  }
}

/** Creates an exclusive, identity-pinned spool outside the reviewed workspace. */
export async function createResultSpool(
  options: CreateResultSpoolOptions,
): Promise<ResultSpool> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(options.id)) {
    throw new ResultSpoolError("unsafe_directory", "The result spool id is invalid.");
  }
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const directoryPath = resolve(options.directory);
  const directoryMetadata = await lstat(directoryPath, { bigint: true });
  const canonicalDirectory = await realpath(directoryPath);
  const canonicalMetadata = await lstat(canonicalDirectory, { bigint: true });
  if (
    directoryMetadata.isSymbolicLink() ||
    !directoryMetadata.isDirectory() ||
    !canonicalMetadata.isDirectory() ||
    !sameIdentity(directoryMetadata, canonicalMetadata)
  ) {
    throw new ResultSpoolError(
      "unsafe_directory",
      "The result spool directory must be a stable real directory.",
    );
  }
  if (options.reviewedWorkspace !== undefined) {
    const workspace = await realpath(options.reviewedWorkspace).catch(() =>
      resolve(options.reviewedWorkspace!),
    );
    if (pathIsInside(workspace, canonicalDirectory)) {
      throw new ResultSpoolError(
        "unsafe_directory",
        "The result spool directory cannot be inside the reviewed workspace.",
      );
    }
  }
  const ownedDirectory = resolve(
    canonicalDirectory,
    `.spool-${options.id}-${randomUUID()}`,
  );
  await mkdir(ownedDirectory, { mode: 0o700 });
  const ownedDirectoryIdentity = await lstat(ownedDirectory, { bigint: true });
  if (
    ownedDirectoryIdentity.isSymbolicLink() ||
    !ownedDirectoryIdentity.isDirectory()
  ) {
    throw new ResultSpoolError(
      "unsafe_directory",
      "The owned result spool directory is unsafe.",
    );
  }
  const path = resolve(ownedDirectory, `${options.id}.spool`);
  const flags =
    constants.O_CREAT |
    constants.O_EXCL |
    constants.O_RDWR |
    ((constants as unknown as Record<string, number>).O_NOFOLLOW ?? 0);
  const handle = await open(path, flags, 0o600);
  let createdIdentity: BigIntStats | undefined;
  try {
    const fileIdentity = await handle.stat({ bigint: true });
    createdIdentity = fileIdentity;
    await options.afterCreateOpen?.(path);
    const pathIdentity = await lstat(path, { bigint: true });
    if (
      !fileIdentity.isFile() ||
      pathIdentity.isSymbolicLink() ||
      !pathIdentity.isFile() ||
      !sameIdentity(fileIdentity, pathIdentity)
    ) {
      throw new ResultSpoolError(
        "identity_changed",
        "The result spool path changed while opening.",
      );
    }
    return new FileResultSpool(
      path,
      ownedDirectory,
      ownedDirectoryIdentity,
      handle,
      fileIdentity,
      options.beforeCleanupRemove,
    );
  } catch (error) {
    await handle.close().catch(() => undefined);
    if (createdIdentity !== undefined) {
      const quarantineDirectory = `${ownedDirectory}.failed-${randomUUID()}`;
      try {
        await rename(ownedDirectory, quarantineDirectory);
        const quarantinePath = resolve(
          quarantineDirectory,
          path.slice(ownedDirectory.length + 1),
        );
        const [directory, file] = await Promise.all([
          lstat(quarantineDirectory, { bigint: true }),
          lstat(quarantinePath, { bigint: true }),
        ]);
        if (
          !directory.isSymbolicLink() &&
          directory.isDirectory() &&
          !file.isSymbolicLink() &&
          file.isFile() &&
          sameIdentity(ownedDirectoryIdentity, directory) &&
          sameIdentity(createdIdentity, file)
        ) {
          await rm(quarantineDirectory, { recursive: true, force: false });
        }
      } catch {
        // Ambiguous ownership is preserved for stale-run cleanup.
      }
    }
    throw error;
  }
}
