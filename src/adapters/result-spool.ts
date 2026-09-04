import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  readdir,
  rename,
  realpath,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

export const MAX_RESULT_SPOOL_BYTES = 16 * 1024 * 1024;

export type ResultSpoolErrorCode =
  "identity_changed" | "invalid_utf8" | "result_too_large" | "unsafe_directory";

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
  lifecycle(): {
    persisted(): Promise<void>;
    abandoned(): Promise<void>;
  };
  cleanup(): Promise<void>;
}

export interface CreateResultSpoolOptions {
  directory: string;
  id: string;
  reviewedWorkspace?: string;
  /** Test seam for deterministic pathname-replacement races after open. */
  afterCreateOpen?(path: string): void | Promise<void>;
  /** Test seam for deterministic pathname replacement before handle wipe. */
  beforeCleanupWipe?(path: string): void | Promise<void>;
}

export interface WipeStaleResultSpoolsOptions {
  directory: string;
  now?: () => number;
  minimumAgeMs?: number;
  maximumEntries?: number;
}

const OWNED_DIRECTORY =
  /^\.spool-([A-Za-z0-9][A-Za-z0-9_-]{0,127})-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;
const SCAN_CURSOR = ".scan-cursor";
const SCAN_INDEX = ".scan-index";
const MAX_SCAN_RECORD_BYTES = 256;
const MAX_SCAN_INDEX_BYTES = 16 * 1024 * 1024;

async function readScanCursor(root: string): Promise<number> {
  const path = resolve(root, SCAN_CURSOR);
  const metadata = await lstat(path, { bigint: true }).catch(() => undefined);
  if (
    metadata === undefined ||
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.size > 512n
  ) {
    return 0;
  }
  const value = (await readFile(path, "utf8").catch(() => "")).trim();
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

async function writeScanCursor(root: string, value: number): Promise<void> {
  const path = resolve(root, SCAN_CURSOR);
  const temporary = resolve(root, `${SCAN_CURSOR}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${value}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
      flush: true,
    });
    const target = await lstat(path, { bigint: true }).catch(() => undefined);
    if (target !== undefined && (target.isSymbolicLink() || !target.isFile())) {
      return;
    }
    await rename(temporary, path);
  } finally {
    const temporaryHandle = await open(
      temporary,
      constants.O_RDWR |
        ((constants as unknown as Record<string, number>).O_NOFOLLOW ?? 0),
    ).catch(() => undefined);
    if (temporaryHandle !== undefined) {
      const identity = await temporaryHandle
        .stat({ bigint: true })
        .catch(() => undefined);
      if (identity !== undefined) {
        await wipeOwnedHandle(temporaryHandle, identity).catch(() => undefined);
      } else await temporaryHandle.close().catch(() => undefined);
    }
  }
}

async function appendScanIndex(root: string, name: string): Promise<void> {
  const path = resolve(root, SCAN_INDEX);
  const handle = await open(
    path,
    constants.O_CREAT |
      constants.O_APPEND |
      constants.O_WRONLY |
      ((constants as unknown as Record<string, number>).O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    const opened = await handle.stat({ bigint: true });
    const target = await lstat(path, { bigint: true });
    if (
      !opened.isFile() ||
      target.isSymbolicLink() ||
      !target.isFile() ||
      !sameIdentity(opened, target)
    ) {
      throw new ResultSpoolError(
        "unsafe_directory",
        "The result spool scan index is unsafe.",
      );
    }
    const appendedBytes = Buffer.byteLength(`${name}\n`, "utf8");
    if (opened.size + BigInt(appendedBytes) > BigInt(MAX_SCAN_INDEX_BYTES)) {
      throw new ResultSpoolError(
        "unsafe_directory",
        "The result spool scan index reached its fixed size limit.",
      );
    }
    await handle.write(`${name}\n`, undefined, "utf8");
    await handle.sync();
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function indexedSpoolNames(
  root: string,
  maximumEntries: number,
): Promise<{ names: string[]; nextOffset: number }> {
  const path = resolve(root, SCAN_INDEX);
  const handle = await open(
    path,
    constants.O_RDONLY |
      ((constants as unknown as Record<string, number>).O_NOFOLLOW ?? 0),
  ).catch(() => undefined);
  if (handle === undefined) return { names: [], nextOffset: 0 };
  try {
    const opened = await handle.stat({ bigint: true });
    const target = await lstat(path, { bigint: true }).catch(() => undefined);
    if (
      target === undefined ||
      !opened.isFile() ||
      target.isSymbolicLink() ||
      !target.isFile() ||
      !sameIdentity(opened, target) ||
      opened.size > BigInt(MAX_SCAN_INDEX_BYTES)
    ) {
      return { names: [], nextOffset: 0 };
    }
    const size = Number(opened.size);
    let offset = await readScanCursor(root);
    if (offset >= size) offset = 0;
    if (offset > 0) {
      const boundary = Buffer.alloc(1);
      const { bytesRead } = await handle.read(boundary, 0, 1, offset - 1);
      if (bytesRead !== 1 || boundary[0] !== 0x0a) offset = 0;
    }
    const maximumBytes = maximumEntries * MAX_SCAN_RECORD_BYTES;
    const bytes = Buffer.alloc(
      Math.min(maximumBytes, Math.max(0, size - offset)),
    );
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, offset);
    const text = bytes.subarray(0, bytesRead).toString("utf8");
    const names: string[] = [];
    let consumed = 0;
    for (const record of text.split("\n")) {
      const encodedBytes = Buffer.byteLength(record, "utf8") + 1;
      if (
        consumed + encodedBytes > bytesRead ||
        names.length >= maximumEntries
      ) {
        break;
      }
      consumed += encodedBytes;
      if (OWNED_DIRECTORY.test(record)) names.push(record);
    }
    const next = offset + consumed;
    return { names, nextOffset: next >= size ? 0 : next };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Bounded crash recovery for owned spool placeholders. Portable Node cannot
 * identity-bind a recursive pathname delete, so recovery wipes verified stale
 * file handles and deliberately leaves empty directories/files behind.
 */
export async function wipeStaleResultSpools(
  options: WipeStaleResultSpoolsOptions,
): Promise<{ inspected: number; wiped: number }> {
  const now = options.now ?? Date.now;
  const minimumAgeMs = options.minimumAgeMs ?? 24 * 60 * 60 * 1_000;
  const maximumEntries = options.maximumEntries ?? 64;
  if (minimumAgeMs < 0 || !Number.isSafeInteger(minimumAgeMs)) {
    throw new Error("minimumAgeMs must be a non-negative safe integer");
  }
  if (maximumEntries < 1 || !Number.isSafeInteger(maximumEntries)) {
    throw new Error("maximumEntries must be a positive safe integer");
  }
  const root = resolve(options.directory);
  const rootMetadata = await lstat(root, { bigint: true }).catch(
    () => undefined,
  );
  const canonicalRoot = await realpath(root).catch(() => undefined);
  const canonicalRootMetadata =
    canonicalRoot === undefined
      ? undefined
      : await lstat(canonicalRoot, { bigint: true }).catch(() => undefined);
  if (
    rootMetadata === undefined ||
    canonicalRoot === undefined ||
    canonicalRootMetadata === undefined ||
    rootMetadata.isSymbolicLink() ||
    !rootMetadata.isDirectory() ||
    canonicalRootMetadata.isSymbolicLink() ||
    !canonicalRootMetadata.isDirectory() ||
    !sameIdentity(rootMetadata, canonicalRootMetadata)
  ) {
    return { inspected: 0, wiped: 0 };
  }
  const indexed = await indexedSpoolNames(canonicalRoot, maximumEntries);
  let inspected = 0;
  let wiped = 0;
  for (const name of indexed.names) {
    inspected += 1;
    const matched = OWNED_DIRECTORY.exec(name);
    if (matched === null) continue;
    const directory = resolve(canonicalRoot, name);
    const directoryMetadata = await lstat(directory, { bigint: true }).catch(
      () => undefined,
    );
    if (
      directoryMetadata === undefined ||
      directoryMetadata.isSymbolicLink() ||
      !directoryMetadata.isDirectory() ||
      now() - Number(directoryMetadata.mtimeMs) < minimumAgeMs
    ) {
      continue;
    }
    const expectedFile = `${matched[1]}.spool`;
    const childStream = await opendir(directory).catch(() => undefined);
    if (childStream === undefined) continue;
    const children: string[] = [];
    for await (const child of childStream) {
      children.push(child.name);
      if (children.length > 1) break;
    }
    if (children.length !== 1 || children[0] !== expectedFile) {
      continue;
    }
    const path = resolve(directory, expectedFile);
    const pathMetadata = await lstat(path, { bigint: true }).catch(
      () => undefined,
    );
    if (
      pathMetadata === undefined ||
      pathMetadata.isSymbolicLink() ||
      !pathMetadata.isFile()
    ) {
      continue;
    }
    if (pathMetadata.size === 0n) continue;
    const handle = await open(
      path,
      constants.O_RDWR |
        ((constants as unknown as Record<string, number>).O_NOFOLLOW ?? 0),
    ).catch(() => undefined);
    if (handle === undefined) continue;
    const opened = await handle.stat({ bigint: true }).catch(() => undefined);
    const currentDirectory = await lstat(directory, { bigint: true }).catch(
      () => undefined,
    );
    const currentRoot = await lstat(canonicalRoot, { bigint: true }).catch(
      () => undefined,
    );
    if (
      opened === undefined ||
      currentRoot === undefined ||
      !sameIdentity(rootMetadata, currentRoot) ||
      !sameIdentity(pathMetadata, opened)
    ) {
      await handle.close().catch(() => undefined);
      continue;
    }
    if (
      currentDirectory === undefined ||
      currentDirectory.isSymbolicLink() ||
      !sameIdentity(directoryMetadata, currentDirectory)
    ) {
      await handle.close().catch(() => undefined);
      continue;
    }
    await wipeOwnedHandle(handle, opened).catch(() => undefined);
    const [wipedMetadata, afterDirectory, afterRoot] = await Promise.all([
      lstat(path, { bigint: true }).catch(() => undefined),
      lstat(directory, { bigint: true }).catch(() => undefined),
      lstat(canonicalRoot, { bigint: true }).catch(() => undefined),
    ]);
    if (
      wipedMetadata !== undefined &&
      afterDirectory !== undefined &&
      afterRoot !== undefined &&
      sameIdentity(pathMetadata, wipedMetadata) &&
      sameIdentity(directoryMetadata, afterDirectory) &&
      sameIdentity(rootMetadata, afterRoot) &&
      wipedMetadata.size === 0n
    ) {
      wiped += 1;
    }
  }
  await writeScanCursor(canonicalRoot, indexed.nextOffset).catch(
    () => undefined,
  );
  return { inspected, wiped };
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev !== 0n &&
    left.ino !== 0n &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
}

function pathIsInside(root: string, target: string): boolean {
  const candidate = relative(root, target);
  return (
    candidate === "" ||
    (!isAbsolute(candidate) &&
      candidate !== ".." &&
      !candidate.startsWith(`..${sep}`))
  );
}

async function wipeOwnedHandle(
  handle: FileHandle,
  identity: BigIntStats,
): Promise<void> {
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || !sameIdentity(identity, before)) {
      throw new ResultSpoolError(
        "identity_changed",
        "The owned result spool handle changed identity.",
      );
    }
    await handle.truncate(0);
    await handle.sync();
    const after = await handle.stat({ bigint: true });
    if (
      !after.isFile() ||
      !sameIdentity(identity, after) ||
      after.size !== 0n
    ) {
      throw new ResultSpoolError(
        "identity_changed",
        "The owned result spool could not be verified empty.",
      );
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
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
    private readonly beforeCleanupWipe:
      ((path: string) => void | Promise<void>) | undefined,
  ) {}

  get byteLength(): number {
    return this.length;
  }

  private async verifyIdentity(): Promise<void> {
    if (this.closed) {
      throw new ResultSpoolError(
        "identity_changed",
        "The result spool is closed.",
      );
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
        : Buffer.from(
            fragment.buffer,
            fragment.byteOffset,
            fragment.byteLength,
          );
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
      return new TextDecoder("utf-8", { fatal: true }).decode(
        await this.read(),
      );
    } catch (error) {
      if (error instanceof ResultSpoolError) throw error;
      throw new ResultSpoolError(
        "invalid_utf8",
        "The assembled reviewer result is not valid UTF-8.",
      );
    }
  }

  lifecycle(): { persisted(): Promise<void>; abandoned(): Promise<void> } {
    let pending: Promise<void> | undefined;
    return {
      persisted: () => (pending ??= this.cleanup()),
      abandoned: () =>
        (pending ??= (async () => {
          if (this.closed) return;
          this.closed = true;
          await this.handle.close();
        })()),
    };
  }

  async cleanup(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.beforeCleanupWipe?.(this.path);
    await wipeOwnedHandle(this.handle, this.fileIdentity);
    this.length = 0;
  }
}

/** Creates an exclusive, identity-pinned spool outside the reviewed workspace. */
export async function createResultSpool(
  options: CreateResultSpoolOptions,
): Promise<ResultSpool> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(options.id)) {
    throw new ResultSpoolError(
      "unsafe_directory",
      "The result spool id is invalid.",
    );
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
  await wipeStaleResultSpools({ directory: canonicalDirectory }).catch(
    () => undefined,
  );
  const afterScavenge = await lstat(canonicalDirectory, { bigint: true });
  if (!sameIdentity(canonicalMetadata, afterScavenge)) {
    throw new ResultSpoolError(
      "unsafe_directory",
      "The result spool directory changed during stale cleanup.",
    );
  }
  const scanIndexMetadata = await lstat(
    resolve(canonicalDirectory, SCAN_INDEX),
    {
      bigint: true,
    },
  ).catch(() => undefined);
  if (
    scanIndexMetadata !== undefined &&
    (scanIndexMetadata.isSymbolicLink() ||
      !scanIndexMetadata.isFile() ||
      scanIndexMetadata.size >= BigInt(MAX_SCAN_INDEX_BYTES))
  ) {
    throw new ResultSpoolError(
      "unsafe_directory",
      "The result spool scan index is unsafe or full.",
    );
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
  // Index the owned directory before any sensitive bytes can be written so a
  // crash cannot leave an undiscoverable nonempty spool.
  await appendScanIndex(canonicalDirectory, basename(ownedDirectory));
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
      options.beforeCleanupWipe,
    );
  } catch (error) {
    if (createdIdentity !== undefined) {
      await wipeOwnedHandle(handle, createdIdentity).catch(() => undefined);
    } else await handle.close().catch(() => undefined);
    throw error;
  }
}
