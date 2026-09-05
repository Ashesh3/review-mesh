import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

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
const indexSchema = z.strictObject({
  schema_version: z.literal("1"),
  kind: z.literal("review-mesh.run-index"),
  run_id: z.string().regex(SAFE_RUN_ID),
  artifact: artifactReferenceSchema,
  identity: identitySchema,
  observed_public_stream: z
    .enum(["complete", "references_only", "failed"])
    .optional(),
});
type IndexDocument = z.infer<typeof indexSchema>;

export class RunArtifactError extends Error {
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
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RunArtifactError";
  }
}

function runId(value: string): void {
  if (!SAFE_RUN_ID.test(value))
    throw new RunArtifactError("invalid_run_id", "The run ID is invalid.");
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
    if (error instanceof RunArtifactError) throw error;
    throw new RunArtifactError(
      "artifact_unavailable",
      "The indexed artifact is unavailable.",
      { cause: error },
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
      raw.schema_version !== "1"
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
  exclusive: boolean,
): Promise<void> {
  const parent = await createSafeArtifactParent(path);
  const target = exclusive ? path : `${path}.${randomUUID()}.tmp`;
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
  try {
    await handle.writeFile(
      JSON.stringify(indexSchema.parse(document)) + "\n",
      "utf8",
    );
    await handle.sync();
    const afterParent = await safeArtifactParent(path);
    if (
      afterParent.path !== parent.path ||
      !sameArtifactIdentity(afterParent, parent)
    )
      throw new RunArtifactError(
        "invalid_run_index",
        "The run index directory changed.",
      );
  } finally {
    await handle.close();
  }
  if (!exclusive) {
    try {
      await rename(target, path);
    } catch (error) {
      await unlink(target).catch(() => undefined);
      throw error;
    }
  }
}

export async function indexRunArtifact(input: {
  runsDirectory: string;
  runId: string;
  artifact: ArtifactReference;
}): Promise<void> {
  const path = indexPath(input.runsDirectory, input.runId);
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
  await writeIndex(
    path,
    {
      schema_version: "1",
      kind: "review-mesh.run-index",
      run_id: input.runId,
      artifact: reference,
      identity: verified.identity,
    },
    true,
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
}> {
  const index = await readIndex(indexPath(options.runsDirectory, id), id);
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
  const verified = await verifyArtifactFile(
    index.artifact.path,
    index.identity,
    undefined,
    undefined,
    options.maximumBytes,
  );
  if (
    verified.sha256 !== index.artifact.sha256 ||
    verified.byte_count !== index.artifact.byte_count
  )
    throw new RunArtifactError(
      "artifact_digest_mismatch",
      "The artifact bytes no longer match the indexed digest.",
    );
  return {
    artifact: index.artifact,
    expected_identity: index.identity,
    ...(index.observed_public_stream === undefined
      ? {}
      : { observed_public_stream: index.observed_public_stream }),
    digest_status: "verified",
  };
}

export async function observePublicStream(input: {
  runsDirectory: string;
  runId: string;
  outcome: PublicStreamOutcome;
}): Promise<void> {
  const path = indexPath(input.runsDirectory, input.runId);
  const current = await readIndex(path, input.runId);
  if (current === undefined)
    throw new RunArtifactError(
      "invalid_run_index",
      "The finalized artifact has no run index.",
    );
  await writeIndex(
    path,
    { ...current, observed_public_stream: input.outcome },
    false,
  );
}
