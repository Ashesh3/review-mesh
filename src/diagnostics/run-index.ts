import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  link,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rmdir,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { sanitizePublicText } from "../adapters/errors.js";

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const countSchema = z.number().int().nonnegative();
export const artifactReferenceSchema = z.strictObject({
  path: z.string().min(1).max(4096),
  sha256: digestSchema,
  byte_count: countSchema,
  completed_results: countSchema,
});
export type ArtifactReference = z.infer<typeof artifactReferenceSchema>;
export type PublicStreamOutcome = "complete" | "references_only" | "failed";
const identitySchema = z.strictObject({
  dev: z.string().regex(/^\d+$/u),
  ino: z.string().regex(/^\d+$/u),
});
export type ArtifactIdentity = z.infer<typeof identitySchema>;
export interface ArtifactParentIdentity extends ArtifactIdentity {
  path: string;
}
const indexV1Schema = z.strictObject({
  schema_version: z.literal("1"),
  kind: z.literal("review-mesh.run-index"),
  run_id: z.string().regex(SAFE_RUN_ID),
  artifact: artifactReferenceSchema,
  identity: identitySchema,
  observed_public_stream: z
    .enum(["complete", "references_only", "failed"])
    .optional(),
});
const alternateSchema = z.strictObject({
  artifact: artifactReferenceSchema,
  identity: identitySchema,
});
const indexV2Schema = indexV1Schema
  .extend({
    schema_version: z.literal("2"),
    artifact_ownership: z.enum(["managed", "caller"]),
    alternatives: z.array(alternateSchema).max(4),
    recovered_from_unindexed: z.literal(true).optional(),
  })
  .superRefine((document, context) => {
    const paths = new Set([document.artifact.path]);
    for (const alternate of document.alternatives) {
      if (
        alternate.artifact.sha256 !== document.artifact.sha256 ||
        alternate.artifact.byte_count !== document.artifact.byte_count ||
        alternate.artifact.completed_results !==
          document.artifact.completed_results ||
        paths.has(alternate.artifact.path)
      )
        context.addIssue({
          code: "custom",
          message: "Alternate artifact identity is invalid.",
        });
      paths.add(alternate.artifact.path);
    }
  });
const indexSchema = z.union([indexV1Schema, indexV2Schema]);
type IndexDocument = z.infer<typeof indexSchema>;

export interface ArtifactDiagnosticDetails {
  stage?: string;
  native_error_code?: string;
  path?: string;
  run_id?: string;
  recovery_command?: string;
  previous_index_path?: string;
  recovery_artifact?: ArtifactReference;
}

function safeDetails(
  input: ArtifactDiagnosticDetails | undefined,
): ArtifactDiagnosticDetails {
  if (input === undefined) return {};
  const output: Record<string, unknown> = {};
  for (const key of [
    "stage",
    "native_error_code",
    "path",
    "run_id",
    "recovery_command",
    "previous_index_path",
  ] as const) {
    const value = input[key];
    if (typeof value === "string")
      output[key] = (sanitizePublicText(value) ?? "[redacted]")
        .replace(/[\r\n]/gu, " ")
        .slice(0, key.endsWith("path") ? 4096 : 512);
  }
  if (input.recovery_artifact !== undefined)
    output.recovery_artifact = {
      ...input.recovery_artifact,
      path: (
        sanitizePublicText(input.recovery_artifact.path) ?? "[redacted]"
      ).slice(0, 4096),
    };
  return output;
}

export class RunArtifactError extends Error {
  readonly diagnosticDetails: ArtifactDiagnosticDetails;
  constructor(
    public readonly code:
      | "invalid_run_id"
      | "artifact_unavailable"
      | "artifact_identity_changed"
      | "artifact_digest_mismatch"
      | "invalid_artifact_record"
      | "invalid_run_index"
      | "unsupported_schema_version"
      | "index_conflict",
    message: string,
    options?: ErrorOptions & { diagnosticDetails?: ArtifactDiagnosticDetails },
  ) {
    super(message, options);
    this.name = "RunArtifactError";
    this.diagnosticDetails = safeDetails(options?.diagnosticDetails);
  }
}

function runId(value: string): void {
  if (!SAFE_RUN_ID.test(value))
    throw new RunArtifactError("invalid_run_id", "The run ID is invalid.");
}

function nativeCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if (
    "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z][A-Z0-9_]{1,31}$/u.test(error.code)
  )
    return error.code;
  return "cause" in error ? nativeCode(error.cause) : undefined;
}

function detailedError(
  error: unknown,
  details: ArtifactDiagnosticDetails,
): RunArtifactError {
  return new RunArtifactError(
    error instanceof RunArtifactError ? error.code : "artifact_unavailable",
    error instanceof RunArtifactError
      ? error.message
      : "The artifact is unavailable.",
    {
      cause: error,
      diagnosticDetails: {
        ...(error instanceof RunArtifactError ? error.diagnosticDetails : {}),
        ...(nativeCode(error) === undefined
          ? {}
          : { native_error_code: nativeCode(error)! }),
        ...details,
      },
    },
  );
}

export function artifactIdentity(metadata: {
  dev: bigint;
  ino: bigint;
}): ArtifactIdentity {
  return { dev: String(metadata.dev), ino: String(metadata.ino) };
}

export function sameArtifactIdentity(
  a: ArtifactIdentity,
  b: ArtifactIdentity,
): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

export async function safeArtifactParent(
  path: string,
): Promise<ArtifactParentIdentity> {
  const parent = resolve(dirname(path));
  for (let ancestor = parent; ; ancestor = dirname(ancestor)) {
    const metadata = await lstat(ancestor, { bigint: true });
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw new RunArtifactError(
        "artifact_identity_changed",
        "The artifact directory contains a symbolic link.",
      );
    if (dirname(ancestor) === ancestor) break;
  }
  const canonical = await realpath(parent);
  const metadata = await lstat(parent, { bigint: true });
  const canonicalMetadata = await lstat(canonical, { bigint: true });
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    !sameArtifactIdentity(
      artifactIdentity(metadata),
      artifactIdentity(canonicalMetadata),
    )
  )
    throw new RunArtifactError(
      "artifact_identity_changed",
      "The artifact directory identity is unsafe.",
    );
  return { path: canonical, ...artifactIdentity(metadata) };
}

export async function createSafeArtifactParent(
  path: string,
): Promise<ArtifactParentIdentity> {
  const parent = resolve(dirname(path));
  const missing: string[] = [];
  let existing = parent;
  for (;;) {
    try {
      const metadata = await lstat(existing, { bigint: true });
      if (!metadata.isDirectory() || metadata.isSymbolicLink())
        throw new RunArtifactError(
          "artifact_identity_changed",
          "The artifact directory contains a symbolic link.",
        );
      await safeArtifactParent(join(existing, ".review-mesh-parent-check"));
      break;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        const ancestor = dirname(existing);
        if (ancestor === existing) throw error;
        missing.unshift(basename(existing));
        existing = ancestor;
        continue;
      }
      throw error;
    }
  }
  let current = existing;
  for (const segment of missing) {
    current = join(current, segment);
    try {
      await mkdir(current);
    } catch (error) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "EEXIST"
      )
        throw error;
    }
    const metadata = await lstat(current, { bigint: true });
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw new RunArtifactError(
        "artifact_identity_changed",
        "The artifact directory contains a symbolic link.",
      );
    await safeArtifactParent(join(current, ".review-mesh-parent-check"));
  }
  return safeArtifactParent(path);
}

export async function verifyArtifactFile(
  path: string,
  expectedIdentity?: ArtifactIdentity,
  expectedParent?: ArtifactParentIdentity,
  expectedMetadata?: {
    size: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
  },
  maximumBytes?: number,
) {
  if (!isAbsolute(path))
    throw new RunArtifactError(
      "invalid_run_index",
      "The artifact path must be absolute.",
    );
  let handle: FileHandle | undefined;
  try {
    const parent = await safeArtifactParent(path);
    if (
      expectedParent !== undefined &&
      (parent.path !== expectedParent.path ||
        !sameArtifactIdentity(parent, expectedParent))
    )
      throw new RunArtifactError(
        "artifact_identity_changed",
        "The artifact directory identity changed.",
      );
    const before = await lstat(path, { bigint: true });
    if (maximumBytes !== undefined && before.size > BigInt(maximumBytes))
      throw new RunArtifactError(
        "artifact_unavailable",
        "Artifact exceeds the dashboard byte budget.",
      );
    if (!before.isFile() || before.isSymbolicLink())
      throw new RunArtifactError(
        "artifact_identity_changed",
        "The artifact is no longer a regular file.",
      );
    if (
      expectedIdentity !== undefined &&
      !sameArtifactIdentity(artifactIdentity(before), expectedIdentity)
    )
      throw new RunArtifactError(
        "artifact_identity_changed",
        "The artifact file identity changed.",
      );
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat({ bigint: true });
    if (maximumBytes !== undefined && opened.size > BigInt(maximumBytes))
      throw new RunArtifactError(
        "artifact_unavailable",
        "Artifact exceeds the dashboard byte budget.",
      );
    if (
      !opened.isFile() ||
      !sameArtifactIdentity(artifactIdentity(opened), artifactIdentity(before))
    )
      throw new RunArtifactError(
        "artifact_identity_changed",
        "The artifact changed while opening.",
      );
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        maximumBytes === undefined
          ? buffer.length
          : Math.min(buffer.length, maximumBytes - position + 1),
        position,
      );
      if (bytesRead === 0) break;
      if (maximumBytes !== undefined && position + bytesRead > maximumBytes)
        throw new RunArtifactError(
          "artifact_unavailable",
          "Artifact exceeds the dashboard byte budget.",
        );
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    const afterParent = await safeArtifactParent(path);
    if (
      !sameArtifactIdentity(
        artifactIdentity(current),
        artifactIdentity(opened),
      ) ||
      current.isSymbolicLink() ||
      afterParent.path !== parent.path ||
      !sameArtifactIdentity(afterParent, parent) ||
      (expectedParent !== undefined &&
        (afterParent.path !== expectedParent.path ||
          !sameArtifactIdentity(afterParent, expectedParent)))
    )
      throw new RunArtifactError(
        "artifact_identity_changed",
        "The artifact changed while reading.",
      );
    if (
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs ||
      current.size !== opened.size ||
      current.mtimeNs !== opened.mtimeNs ||
      current.ctimeNs !== opened.ctimeNs ||
      (expectedMetadata !== undefined &&
        (opened.size !== expectedMetadata.size ||
          opened.mtimeNs !== expectedMetadata.mtimeNs ||
          opened.ctimeNs !== expectedMetadata.ctimeNs))
    )
      throw new RunArtifactError(
        "artifact_digest_mismatch",
        "The artifact was modified while reading.",
      );
    return {
      sha256: hash.digest("hex"),
      byte_count: position,
      identity: artifactIdentity(opened),
    };
  } catch (error) {
    if (error instanceof RunArtifactError)
      throw detailedError(error, { stage: "verify_artifact", path });
    throw new RunArtifactError(
      "artifact_unavailable",
      "The indexed artifact is unavailable.",
      {
        cause: error,
        diagnosticDetails: {
          stage: "verify_artifact",
          path,
          ...(nativeCode(error) === undefined
            ? {}
            : { native_error_code: nativeCode(error)! }),
        },
      },
    );
  } finally {
    await handle?.close();
  }
}

function indexPath(runsDirectory: string, id: string): string {
  runId(id);
  return join(resolve(runsDirectory), `${id}.index.json`);
}

async function readIndex(
  path: string,
  id: string,
): Promise<IndexDocument | undefined> {
  let handle: FileHandle | undefined;
  try {
    await safeArtifactParent(path);
    const before = await lstat(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.size > 32_768n)
      throw new RunArtifactError(
        "invalid_run_index",
        "The run index is unsafe or oversized.",
      );
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat({ bigint: true });
    if (
      !sameArtifactIdentity(artifactIdentity(before), artifactIdentity(opened))
    )
      throw new RunArtifactError(
        "invalid_run_index",
        "The run index changed while opening.",
      );
    const buffer = Buffer.alloc(32_769);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > 32_768)
      throw new RunArtifactError(
        "invalid_run_index",
        "The run index is oversized.",
      );
    const raw: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        buffer.subarray(0, offset),
      ),
    );
    const after = await handle.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    if (
      !sameArtifactIdentity(
        artifactIdentity(opened),
        artifactIdentity(current),
      ) ||
      after.mtimeNs !== opened.mtimeNs ||
      after.size !== opened.size
    )
      throw new RunArtifactError(
        "invalid_run_index",
        "The run index changed while reading.",
      );
    if (
      typeof raw === "object" &&
      raw !== null &&
      "schema_version" in raw &&
      raw.schema_version !== "1" &&
      raw.schema_version !== "2"
    )
      throw new RunArtifactError(
        "unsupported_schema_version",
        "The run index schema version is unsupported.",
      );
    const parsed = indexSchema.safeParse(raw);
    if (!parsed.success || parsed.data.run_id !== id)
      throw new RunArtifactError(
        "invalid_run_index",
        "The run index does not match the requested run.",
      );
    return parsed.data;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return undefined;
    if (error instanceof RunArtifactError) throw error;
    throw new RunArtifactError(
      "invalid_run_index",
      "The run index is invalid.",
      { cause: error },
    );
  } finally {
    await handle?.close();
  }
}

async function writeIndex(
  path: string,
  document: IndexDocument,
  afterStagingWrite?: (path: string) => void | Promise<void>,
): Promise<void> {
  const parent = await createSafeArtifactParent(path);
  const directory = `${path}.publication-${randomUUID()}`;
  await mkdir(directory, { mode: 0o700 });
  const directoryIdentity = artifactIdentity(
    await lstat(directory, { bigint: true }),
  );
  const target = join(directory, "index.json");
  const handle = await open(
    target,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      (constants.O_NOFOLLOW ?? 0),
    0o600,
  ).catch((error) => {
    throw new RunArtifactError(
      "index_conflict",
      "The run index already exists or is unavailable.",
      { cause: error },
    );
  });
  const identity = artifactIdentity(await handle.stat({ bigint: true }));
  try {
    await handle.writeFile(
      JSON.stringify(indexSchema.parse(document)) + "\n",
      "utf8",
    );
    await handle.sync();
    await afterStagingWrite?.(target);
    const staged = await verifyArtifactFile(target, identity);
    if (staged.sha256 !== indexHash(document))
      throw new RunArtifactError(
        "invalid_run_index",
        "The staged index does not match its complete document.",
      );
    const afterParent = await safeArtifactParent(path);
    if (
      afterParent.path !== parent.path ||
      !sameArtifactIdentity(afterParent, parent)
    )
      throw new RunArtifactError(
        "invalid_run_index",
        "The run index directory changed.",
      );
    const currentDirectory = await lstat(directory, { bigint: true });
    if (
      currentDirectory.isSymbolicLink() ||
      !sameArtifactIdentity(
        directoryIdentity,
        artifactIdentity(currentDirectory),
      )
    )
      throw indexUpdateConflict(path);
    // Publish the complete synced inode without overwriting an existing name.
    // Its private publication alias remains owned; later updates pin this same
    // inode and keep immutable prior documents in their transaction archives.
    await link(target, path).catch((error) => {
      throw new RunArtifactError(
        "index_conflict",
        "The run index already exists or exclusive publication is unavailable.",
        {
          cause: error,
          diagnosticDetails: {
            stage: "publish_index",
            path,
            ...(nativeCode(error)
              ? { native_error_code: nativeCode(error)! }
              : {}),
          },
        },
      );
    });
    await verifyArtifactFile(path, identity, parent);
  } finally {
    await handle.close();
  }
}

interface IndexSnapshot {
  document: IndexDocument;
  identity: ArtifactIdentity;
  sha256: string;
}
const updateJournalSchema = z.strictObject({
  schema_version: z.literal("1"),
  pid: z.number().int().positive(),
  nonce: z.string().uuid(),
  index_identity: identitySchema,
  previous_sha256: digestSchema,
  previous_document: indexSchema,
});
function updateDirectory(path: string): string {
  return `${path}.update`;
}
function indexHash(document: IndexDocument): string {
  return createHash("sha256")
    .update(JSON.stringify(indexSchema.parse(document)) + "\n")
    .digest("hex");
}
function indexUpdateConflict(path: string): RunArtifactError {
  return new RunArtifactError(
    "index_conflict",
    "The run index has a pending update; retry or explicitly recover an interrupted update.",
    {
      diagnosticDetails: {
        stage: "index_update",
        path,
        previous_index_path: join(updateDirectory(path), "previous.json"),
      },
    },
  );
}
async function ensureNoUpdate(path: string): Promise<void> {
  if (
    await lstat(updateDirectory(path)).then(
      () => true,
      (error) => {
        if (nativeCode(error) === "ENOENT") return false;
        throw error;
      },
    )
  )
    throw indexUpdateConflict(path);
}
async function snapshotIndex(
  path: string,
  id: string,
): Promise<IndexSnapshot | undefined> {
  const document = await readIndex(path, id);
  if (document === undefined) return undefined;
  const verified = await verifyArtifactFile(path);
  const second = await readIndex(path, id);
  if (second === undefined || indexHash(document) !== indexHash(second))
    throw indexUpdateConflict(path);
  return { document, identity: verified.identity, sha256: verified.sha256 };
}
async function archiveUpdate(
  path: string,
  expected: ArtifactIdentity,
  parent: ArtifactParentIdentity,
): Promise<void> {
  const directory = updateDirectory(path);
  const current = await lstat(directory, { bigint: true });
  const currentParent = await safeArtifactParent(path);
  if (
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    !sameArtifactIdentity(expected, artifactIdentity(current)) ||
    currentParent.path !== parent.path ||
    !sameArtifactIdentity(parent, currentParent)
  )
    throw indexUpdateConflict(path);
  const destination = `${path}.previous-${randomUUID()}`;
  if (
    await lstat(destination).then(
      () => true,
      (error) => {
        if (nativeCode(error) === "ENOENT") return false;
        throw error;
      },
    )
  )
    throw indexUpdateConflict(path);
  // The exclusive updater owns this private directory. Keep its immutable
  // previous document rather than unlinking a possibly replaced pathname.
  await rename(directory, destination);
  const archived = await lstat(destination, { bigint: true });
  const afterParent = await safeArtifactParent(path);
  if (
    archived.isSymbolicLink() ||
    !sameArtifactIdentity(expected, artifactIdentity(archived)) ||
    !sameArtifactIdentity(parent, afterParent)
  )
    throw indexUpdateConflict(path);
}
async function writePinnedIndex(
  path: string,
  parent: ArtifactParentIdentity,
  identity: ArtifactIdentity,
  document: IndexDocument,
  expectedDigest?: string,
): Promise<void> {
  const opened = await open(
    path,
    constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const metadata = await opened.stat({ bigint: true });
    const named = await lstat(path, { bigint: true });
    const currentParent = await safeArtifactParent(path);
    if (
      !metadata.isFile() ||
      named.isSymbolicLink() ||
      metadata.nlink < 1n ||
      !sameArtifactIdentity(identity, artifactIdentity(metadata)) ||
      !sameArtifactIdentity(identity, artifactIdentity(named)) ||
      !sameArtifactIdentity(parent, currentParent) ||
      parent.path !== currentParent.path
    )
      throw indexUpdateConflict(path);
    if (
      expectedDigest !== undefined &&
      (await verifyArtifactFile(path, identity, parent)).sha256 !==
        expectedDigest
    )
      throw indexUpdateConflict(path);
    const bytes = Buffer.from(
      JSON.stringify(indexSchema.parse(document)) + "\n",
    );
    let offset = 0;
    while (offset < bytes.length) {
      const written = await opened.write(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (written.bytesWritten === 0) throw indexUpdateConflict(path);
      offset += written.bytesWritten;
    }
    await opened.truncate(bytes.length);
    await opened.sync();
    const final = await verifyArtifactFile(path, identity, parent);
    if (final.sha256 !== indexHash(document)) throw indexUpdateConflict(path);
  } finally {
    await opened.close();
  }
}

async function updateIndex(
  path: string,
  prior: IndexSnapshot,
  next: IndexDocument,
): Promise<void> {
  const parent = await safeArtifactParent(path);
  const directory = updateDirectory(path);
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch {
    throw indexUpdateConflict(path);
  }
  const directoryIdentity = artifactIdentity(
    await lstat(directory, { bigint: true }),
  );
  const journalPath = join(directory, "previous.json");
  let writingStarted = false;
  let finished = false;
  try {
    const journal = updateJournalSchema.parse({
      schema_version: "1",
      pid: process.pid,
      nonce: randomUUID(),
      index_identity: prior.identity,
      previous_sha256: indexHash(prior.document),
      previous_document: prior.document,
    });
    const handle = await open(
      journalPath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      await handle.writeFile(JSON.stringify(journal) + "\n");
      await handle.sync();
    } finally {
      await handle.close();
    }
    const current = await snapshotIndex(path, prior.document.run_id);
    if (
      current === undefined ||
      current.sha256 !== prior.sha256 ||
      !sameArtifactIdentity(current.identity, prior.identity)
    )
      throw indexUpdateConflict(path);
    writingStarted = true;
    await writePinnedIndex(path, parent, prior.identity, next, prior.sha256);
    finished = true;
  } finally {
    if (finished || !writingStarted) {
      await archiveUpdate(path, directoryIdentity, parent);
    }
  }
}

/** Restores the durable previous document only for a verified dead update owner. */
async function restoreInterruptedIndex(
  path: string,
  id: string,
): Promise<void> {
  const directory = updateDirectory(path);
  const exists = await lstat(directory, { bigint: true }).catch((error) => {
    if (nativeCode(error) === "ENOENT") return undefined;
    throw error;
  });
  if (exists === undefined) return;
  if (!exists.isDirectory() || exists.isSymbolicLink())
    throw indexUpdateConflict(path);
  const parent = await safeArtifactParent(path);
  const journalPath = join(directory, "previous.json");
  const verified = await verifyArtifactFile(
    journalPath,
    undefined,
    undefined,
    undefined,
    65536,
  );
  let journal: z.infer<typeof updateJournalSchema>;
  try {
    journal = updateJournalSchema.parse(
      JSON.parse(await readFile(journalPath, "utf8")),
    );
  } catch {
    throw indexUpdateConflict(path);
  }
  const rechecked = await verifyArtifactFile(
    journalPath,
    verified.identity,
    undefined,
    undefined,
    65536,
  );
  if (
    rechecked.sha256 !== verified.sha256 ||
    journal.previous_document.run_id !== id ||
    indexHash(journal.previous_document) !== journal.previous_sha256
  )
    throw indexUpdateConflict(path);
  let alive = true;
  try {
    process.kill(journal.pid, 0);
  } catch (error) {
    if (nativeCode(error) === "ESRCH") alive = false;
  }
  if (alive) throw indexUpdateConflict(path);
  // Reclaim via a second exclusive directory so two recovery processes cannot
  // restore or clean up the same interrupted transaction concurrently.
  const claim = join(directory, "recovery");
  try {
    await mkdir(claim, { mode: 0o700 });
  } catch {
    throw indexUpdateConflict(path);
  }
  try {
    await writePinnedIndex(
      path,
      parent,
      journal.index_identity,
      journal.previous_document,
    );
    await archiveUpdate(path, artifactIdentity(exists), parent);
  } catch (error) {
    await rmdir(claim).catch(() => undefined);
    throw error;
  }
}

export async function indexRunArtifact(input: {
  runsDirectory: string;
  runId: string;
  artifact: ArtifactReference;
  alternatives?: ArtifactReference[];
  ownership?: "managed" | "caller";
  /** Test seam for a failed or incomplete write before final index publication. */
  afterStagingWrite?: (path: string) => void | Promise<void>;
}): Promise<void> {
  const path = indexPath(input.runsDirectory, input.runId);
  await ensureNoUpdate(path);
  if ((input.alternatives?.length ?? 0) > 4)
    throw new RunArtifactError(
      "invalid_run_index",
      "At most four artifact alternatives can be registered.",
    );
  const reference = artifactReferenceSchema.parse({
    ...input.artifact,
    path: resolve(input.artifact.path),
  });
  const verified = await verifyArtifactFile(reference.path);
  if (
    reference.sha256 !== verified.sha256 ||
    reference.byte_count !== verified.byte_count
  )
    throw new RunArtifactError(
      "artifact_digest_mismatch",
      "The finalized artifact does not match its published digest.",
    );
  const alternatives: Array<z.infer<typeof alternateSchema>> = [];
  for (const copy of input.alternatives ?? []) {
    const artifact = artifactReferenceSchema.parse({
      ...copy,
      path: resolve(copy.path),
    });
    const verifiedCopy = await verifyArtifactFile(artifact.path);
    if (
      artifact.sha256 !== reference.sha256 ||
      artifact.byte_count !== reference.byte_count ||
      artifact.completed_results !== reference.completed_results ||
      verifiedCopy.sha256 !== reference.sha256 ||
      verifiedCopy.byte_count !== reference.byte_count
    )
      throw new RunArtifactError(
        "artifact_digest_mismatch",
        "The alternate artifact does not match the finalized bytes.",
      );
    alternatives.push({ artifact, identity: verifiedCopy.identity });
  }
  await writeIndex(
    path,
    {
      schema_version: "2",
      kind: "review-mesh.run-index",
      run_id: input.runId,
      artifact: reference,
      identity: verified.identity,
      artifact_ownership:
        input.ownership ??
        (reference.path ===
        join(resolve(input.runsDirectory), `${input.runId}.jsonl`)
          ? "managed"
          : "caller"),
      alternatives,
    },
    input.afterStagingWrite,
  );
}

export async function resolveRunArtifact(
  id: string,
  options: { runsDirectory: string; maximumBytes?: number },
): Promise<{
  artifact: ArtifactReference;
  observed_public_stream?: PublicStreamOutcome;
  expected_identity: ArtifactIdentity;
  digest_status: "verified" | "final_digest_unavailable";
  resolution: {
    source: "primary" | "alternate";
    primary_path: string;
    resolved_path: string;
    warnings: Array<{ code: "primary_artifact_missing"; message: string }>;
    recovered_from_unindexed?: true;
  };
}> {
  const path = indexPath(options.runsDirectory, id);
  await ensureNoUpdate(path);
  const index = await readIndex(path, id);
  if (index === undefined) {
    const path = join(resolve(options.runsDirectory), `${id}.jsonl`);
    const verified = await verifyArtifactFile(
      path,
      undefined,
      undefined,
      undefined,
      options.maximumBytes,
    );
    return {
      artifact: {
        path,
        sha256: verified.sha256,
        byte_count: verified.byte_count,
        completed_results: 0,
      },
      expected_identity: verified.identity,
      digest_status: "final_digest_unavailable",
      resolution: {
        source: "primary",
        primary_path: path,
        resolved_path: path,
        warnings: [],
      },
    };
  }
  if (
    options.maximumBytes !== undefined &&
    index.artifact.byte_count > options.maximumBytes
  )
    throw new RunArtifactError(
      "artifact_unavailable",
      "Artifact exceeds the dashboard byte budget.",
    );
  let reference = index.artifact;
  let identity = index.identity;
  let source: "primary" | "alternate" = "primary";
  let verified;
  try {
    verified = await verifyArtifactFile(
      reference.path,
      identity,
      undefined,
      undefined,
      options.maximumBytes,
    );
  } catch (error) {
    if (nativeCode(error) !== "ENOENT")
      throw detailedError(error, {
        stage: "resolve_primary",
        path: reference.path,
        run_id: id,
      });
    if (index.schema_version === "2") {
      for (const alternate of index.alternatives) {
        try {
          verified = await verifyArtifactFile(
            alternate.artifact.path,
            alternate.identity,
            undefined,
            undefined,
            options.maximumBytes,
          );
          reference = alternate.artifact;
          identity = alternate.identity;
          source = "alternate";
          break;
        } catch (alternateError) {
          if (nativeCode(alternateError) !== "ENOENT")
            throw detailedError(alternateError, {
              stage: "resolve_alternate",
              path: alternate.artifact.path,
              run_id: id,
            });
        }
      }
    }
    if (verified === undefined)
      throw detailedError(error, {
        stage: "resolve_primary",
        path: index.artifact.path,
        run_id: id,
        recovery_command: `review-mesh recover ${id} --artifact <COPY_PATH>`,
      });
  }
  if (
    verified.sha256 !== index.artifact.sha256 ||
    verified.byte_count !== index.artifact.byte_count
  )
    throw new RunArtifactError(
      "artifact_digest_mismatch",
      "The artifact bytes no longer match the indexed digest.",
    );
  return {
    artifact: reference,
    expected_identity: identity,
    ...(index.observed_public_stream === undefined
      ? {}
      : { observed_public_stream: index.observed_public_stream }),
    digest_status: "verified",
    resolution: {
      source,
      primary_path: index.artifact.path,
      resolved_path: reference.path,
      warnings:
        source === "alternate"
          ? [
              {
                code: "primary_artifact_missing",
                message:
                  "The primary artifact is missing; a registered identical copy was verified.",
              },
            ]
          : [],
      ...(index.schema_version === "2" && index.recovered_from_unindexed
        ? { recovered_from_unindexed: true as const }
        : {}),
    },
  };
}

export async function observePublicStream(input: {
  runsDirectory: string;
  runId: string;
  outcome: PublicStreamOutcome;
}): Promise<void> {
  const path = indexPath(input.runsDirectory, input.runId);
  await ensureNoUpdate(path);
  const current = await snapshotIndex(path, input.runId);
  if (current === undefined)
    throw new RunArtifactError(
      "invalid_run_index",
      "The finalized artifact has no run index.",
    );
  await updateIndex(path, current, {
    ...current.document,
    observed_public_stream: input.outcome,
  });
}

/** Attaches an exact complete caller copy to an existing orphaned run index. */
export async function recoverRunArtifact(input: {
  runsDirectory: string;
  runId: string;
  artifactPath: string;
}): Promise<{
  schema_version: "1";
  kind: "review-mesh.artifact-recovery";
  run_id: string;
  status: "recovered";
  previous_path?: string;
  artifact: ArtifactReference;
  index_path: string;
  caller_owned: true;
  recovered_from_unindexed?: true;
}> {
  const path = indexPath(input.runsDirectory, input.runId);
  await restoreInterruptedIndex(path, input.runId);
  await ensureNoUpdate(path);
  const prior = await snapshotIndex(path, input.runId);
  const lease = await lstat(
    join(resolve(input.runsDirectory), `${input.runId}.control.json`),
    { bigint: true },
  ).catch((error) => {
    if (nativeCode(error) === "ENOENT") return undefined;
    throw error;
  });
  if (
    lease &&
    (lease.isSymbolicLink() ||
      !lease.isFile() ||
      (lease.size > 0n && Date.now() - Number(lease.mtimeMs) < 5000))
  )
    throw new RunArtifactError(
      "index_conflict",
      "An active or unsafe run control lease prevents recovery.",
    );
  if (prior === undefined) {
    const managed = join(resolve(input.runsDirectory), `${input.runId}.jsonl`);
    const existing = await lstat(managed).catch((error) => {
      if (nativeCode(error) === "ENOENT") return undefined;
      throw error;
    });
    const artifactPath = resolve(input.artifactPath);
    const verified = await verifyArtifactFile(artifactPath).catch((error) => {
      throw detailedError(error, {
        stage: "recover_copy",
        path: artifactPath,
        run_id: input.runId,
      });
    });
    const { readRunArtifact } = await import("./run-artifact.js");
    const complete = await readRunArtifact(artifactPath, {
      expectedIdentity: verified.identity,
      expectedSha256: verified.sha256,
    }).catch((error) => {
      throw detailedError(error, {
        stage: "recover_validation",
        path: artifactPath,
        run_id: input.runId,
      });
    });
    if (
      complete.active ||
      complete.run_id !== input.runId ||
      complete.sha256 !== verified.sha256 ||
      complete.byte_count !== verified.byte_count
    )
      throw new RunArtifactError(
        "invalid_artifact_record",
        "The recovery copy is not the requested complete run.",
      );
    if (existing !== undefined) {
      let current;
      try {
        current = await verifyArtifactFile(managed);
      } catch (error) {
        throw detailedError(error, {
          stage: "recover_managed",
          path: managed,
          run_id: input.runId,
        });
      }
      if (
        current.sha256 !== verified.sha256 ||
        current.byte_count !== verified.byte_count
      )
        throw new RunArtifactError(
          "index_conflict",
          "The existing managed artifact conflicts with the recovery copy.",
          {
            diagnosticDetails: {
              stage: "recover_managed",
              path: managed,
              run_id: input.runId,
            },
          },
        );
    }
    const artifact = {
      path: artifactPath,
      sha256: verified.sha256,
      byte_count: verified.byte_count,
      completed_results: complete.results.length,
    };
    await writeIndex(path, {
      schema_version: "2",
      kind: "review-mesh.run-index",
      run_id: input.runId,
      artifact,
      identity: verified.identity,
      artifact_ownership: "caller",
      alternatives: [],
      observed_public_stream: "failed",
      recovered_from_unindexed: true,
    });
    return {
      schema_version: "1",
      kind: "review-mesh.artifact-recovery",
      run_id: input.runId,
      status: "recovered",
      artifact,
      index_path: path,
      caller_owned: true,
      recovered_from_unindexed: true,
    };
  }
  try {
    await verifyArtifactFile(
      prior.document.artifact.path,
      prior.document.identity,
    );
    throw new RunArtifactError(
      "index_conflict",
      "The current primary artifact is available; recovery would replace a valid run reference.",
    );
  } catch (error) {
    if (nativeCode(error) !== "ENOENT")
      throw detailedError(error, {
        stage: "recover_primary",
        path: prior.document.artifact.path,
        run_id: input.runId,
      });
  }
  const artifactPath = resolve(input.artifactPath);
  const verified = await verifyArtifactFile(artifactPath);
  if (
    verified.sha256 !== prior.document.artifact.sha256 ||
    verified.byte_count !== prior.document.artifact.byte_count
  )
    throw new RunArtifactError(
      "artifact_digest_mismatch",
      "The recovery copy does not match the indexed digest and byte count.",
      {
        diagnosticDetails: {
          stage: "recover_copy",
          path: artifactPath,
          run_id: input.runId,
        },
      },
    );
  let complete;
  try {
    const { readRunArtifact } = await import("./run-artifact.js");
    complete = await readRunArtifact(artifactPath, {
      expectedIdentity: verified.identity,
      expectedSha256: verified.sha256,
    });
  } catch (error) {
    throw detailedError(error, {
      stage: "recover_validation",
      path: artifactPath,
      run_id: input.runId,
    });
  }
  if (
    complete.active ||
    complete.run_id !== input.runId ||
    complete.results.length !== prior.document.artifact.completed_results ||
    complete.sha256 !== verified.sha256 ||
    complete.byte_count !== verified.byte_count
  )
    throw new RunArtifactError(
      "invalid_artifact_record",
      "The recovery copy does not contain the indexed complete run and result count.",
    );
  const artifact = { ...prior.document.artifact, path: artifactPath };
  const next: IndexDocument = {
    ...prior.document,
    schema_version: "2",
    artifact,
    identity: verified.identity,
    artifact_ownership: "caller",
    alternatives:
      prior.document.schema_version === "2"
        ? prior.document.alternatives.filter(
            (entry) => entry.artifact.path !== artifactPath,
          )
        : [],
  };
  await updateIndex(path, prior, next);
  return {
    schema_version: "1",
    kind: "review-mesh.artifact-recovery",
    run_id: input.runId,
    status: "recovered",
    previous_path: prior.document.artifact.path,
    artifact,
    index_path: path,
    caller_owned: true,
  };
}
