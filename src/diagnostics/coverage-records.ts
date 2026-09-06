import { createHash } from "node:crypto";
import type {
  ChangeCoverageEntry,
  RunSnapshotIdentity,
} from "../context/change-coverage.js";
import { canonicalJson } from "../results/digest.js";
import { snapshotManifestChunkSchema } from "./artifact-payloads.js";
import { RunArtifactError } from "./run-index.js";

export interface RunSnapshotManifest {
  identity: RunSnapshotIdentity;
  files: Array<{ path: string; byte_count: number; sha256: string }>;
}

function invalid(message: string): never {
  throw new RunArtifactError("invalid_artifact_record", message);
}
function manifestDigest(files: RunSnapshotManifest["files"]): string {
  return createHash("sha256").update(canonicalJson(files)).digest("hex");
}
function comparePaths(a: string, b: string): number {
  const left = Array.from(a, (c) => c.codePointAt(0)!);
  const right = Array.from(b, (c) => c.codePointAt(0)!);
  for (let index = 0; index < Math.min(left.length, right.length); index++)
    if (left[index] !== right[index]) return left[index]! - right[index]!;
  return left.length - right.length;
}
function validateManifest(manifest: RunSnapshotManifest): void {
  if (
    manifest.files.length !== manifest.identity.file_count ||
    manifestDigest(manifest.files) !== manifest.identity.sha256
  )
    invalid(
      "Snapshot manifest digest or file count does not match its identity.",
    );
  let previous: string | undefined;
  for (const file of manifest.files) {
    if (previous !== undefined && comparePaths(previous, file.path) >= 0)
      invalid("Snapshot manifest paths must be unique and sorted.");
    previous = file.path;
  }
}

/** One serialized recorder per run prevents concurrent reviewers duplicating a manifest. */
export function createCoverageRecorder(
  record: (value: Record<string, unknown>) => Promise<void>,
) {
  const written = new Map<string, RunSnapshotManifest>();
  let tail = Promise.resolve();
  return (input: {
    reviewerId: string;
    entries:
      readonly ChangeCoverageEntry[] | readonly Record<string, unknown>[];
    snapshotIdentity?: RunSnapshotIdentity;
    snapshotManifest?: RunSnapshotManifest;
  }): Promise<void> => {
    const task = tail.then(async () => {
      const entries = input.entries as readonly ChangeCoverageEntry[];
      let manifest = input.snapshotManifest;
      if (!manifest && input.snapshotIdentity) {
        const files = entries
          .flatMap((entry) =>
            entry.snapshot_digest !== undefined &&
            entry.snapshot_byte_count !== undefined
              ? [
                  {
                    path: entry.path,
                    byte_count: entry.snapshot_byte_count,
                    sha256: entry.snapshot_digest,
                  },
                ]
              : [],
          )
          .sort((a, b) => comparePaths(a.path, b.path));
        // Older artifacts can carry identities without their complete support list.
        // Retain that legacy proof instead of inventing a complete manifest.
        if (
          files.length === input.snapshotIdentity.file_count &&
          manifestDigest(files) === input.snapshotIdentity.sha256
        )
          manifest = { identity: input.snapshotIdentity, files };
      }
      if (manifest) {
        validateManifest(manifest);
        const existing = written.get(manifest.identity.sha256);
        if (existing && canonicalJson(existing) !== canonicalJson(manifest))
          invalid("Conflicting snapshot identity for an existing manifest.");
        if (!existing) {
          const chunkCount = Math.max(
            1,
            Math.ceil(manifest.files.length / 256),
          );
          for (let index = 0; index < chunkCount; index++)
            await record({
              record: "run.snapshot_manifest",
              data: {
                index,
                chunk_count: chunkCount,
                identity: manifest.identity,
                files: manifest.files.slice(index * 256, (index + 1) * 256),
              },
            });
          written.set(manifest.identity.sha256, manifest);
        }
      }
      // Scope and all captured file identities are retained by context/manifest.
      // Per-reviewer records contain only policy-relevant coverage obligations;
      // this also compacts legacy support entries mislabeled as untracked.
      const compact = manifest
        ? entries.filter((entry) => entry.relevant)
        : entries;
      for (let index = 0; index < Math.max(1, compact.length); index += 256)
        await record({
          record: "reviewer.coverage",
          reviewer_id: input.reviewerId,
          data: {
            index: index / 256,
            entries: compact.slice(index, index + 256),
            ...(manifest
              ? { snapshot_ref: manifest.identity.sha256 }
              : index === 0 && input.snapshotIdentity
                ? { snapshot_identity: input.snapshotIdentity }
                : {}),
          },
        });
    });
    tail = task;
    return task;
  };
}

/** Validate references even on raw artifact reads, before any normalized interpretation. */
export function readCoverageManifests(
  records: readonly Record<string, unknown>[],
  allowIncomplete = false,
): Map<string, RunSnapshotManifest> {
  const pending = new Map<
    string,
    { manifest: RunSnapshotManifest; chunks: number; expected: number }
  >();
  const manifests = new Map<string, RunSnapshotManifest>();
  const coverage = new Map<
    string,
    { next: number; ref: string | undefined; paths: Set<string> }
  >();
  for (const record of records) {
    if (record.record === "run.snapshot_manifest") {
      const parsed = snapshotManifestChunkSchema.safeParse(record.data);
      if (!parsed.success) invalid("Snapshot manifest chunk is invalid.");
      const data = parsed.data;
      const ref = data.identity.sha256;
      if (manifests.has(ref)) invalid("Snapshot manifest is repeated.");
      const state = pending.get(ref) ?? {
        manifest: { identity: data.identity, files: [] },
        chunks: 0,
        expected: data.chunk_count,
      };
      if (
        data.index !== state.chunks ||
        data.chunk_count !== state.expected ||
        canonicalJson(data.identity) !== canonicalJson(state.manifest.identity)
      )
        invalid(
          "Snapshot manifest chunks contain a gap, duplicate or conflicting identity.",
        );
      state.manifest.files.push(...data.files);
      state.chunks++;
      if (state.chunks === state.expected) {
        validateManifest(state.manifest);
        manifests.set(ref, state.manifest);
        pending.delete(ref);
      } else pending.set(ref, state);
    } else if (
      record.record === "reviewer.coverage" &&
      record.schema_version === "3"
    ) {
      const data = record.data as {
        index: number;
        snapshot_ref?: string;
        entries: ChangeCoverageEntry[];
      };
      const reviewerId = String(record.reviewer_id);
      const state = coverage.get(reviewerId) ?? {
        next: 0,
        ref: data.snapshot_ref,
        paths: new Set<string>(),
      };
      if (data.index !== state.next || data.snapshot_ref !== state.ref)
        invalid(
          "Reviewer coverage chunks contain a gap, duplicate or conflicting snapshot reference.",
        );
      const manifest =
        data.snapshot_ref === undefined
          ? undefined
          : manifests.get(data.snapshot_ref);
      if (data.snapshot_ref !== undefined && manifest === undefined)
        invalid(
          "Reviewer coverage references an absent or incomplete snapshot manifest.",
        );
      const files = manifest
        ? new Map(manifest.files.map((file) => [file.path, file]))
        : undefined;
      for (const entry of data.entries) {
        if (state.paths.has(entry.path))
          invalid("Reviewer coverage repeats a path.");
        state.paths.add(entry.path);
        if (files && entry.snapshot_digest !== undefined) {
          const file = files.get(entry.path);
          if (
            !file ||
            file.sha256 !== entry.snapshot_digest ||
            file.byte_count !== entry.snapshot_byte_count
          )
            invalid(
              "Reviewer coverage file identity differs from its snapshot manifest.",
            );
        }
      }
      state.next++;
      coverage.set(reviewerId, state);
    }
  }
  if (!allowIncomplete && pending.size)
    invalid("Snapshot manifest is incomplete.");
  return manifests;
}
