import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  createRunArtifact,
  readRunArtifact,
} from "../../src/diagnostics/run-artifact.js";
import { canonicalJson } from "../../src/results/digest.js";
import { createCoverageRecorder } from "../../src/diagnostics/coverage-records.js";
import { readNormalizedRun } from "../../src/diagnostics/normalize-run.js";
import type { ChangeCoverageEntry } from "../../src/context/change-coverage.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const files = [{ path: "a.ts", byte_count: 5, sha256: "a".repeat(64) }];
const identity = {
  schema_version: "1" as const,
  sha256: createHash("sha256").update(canonicalJson(files)).digest("hex"),
  file_count: 1,
  complete: true,
};

it("accepts a validated shared snapshot and compact reviewer coverage reference", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-mesh-manifest-"));
  roots.push(root);
  const path = join(root, "run.jsonl.active");
  const writer = await createRunArtifact({
    path,
    runId: "run",
    toolVersion: "9.4.0",
  });
  try {
    await writer.record({
      record: "run.snapshot_manifest",
      data: { index: 0, chunk_count: 1, identity, files },
    });
    await writer.record({
      record: "reviewer.coverage",
      reviewer_id: "lens::model",
      data: { index: 0, snapshot_ref: identity.sha256, entries: [] },
    });
    const artifact = await readRunArtifact(path, { allowActive: true });
    expect(
      artifact.records.filter((r) => r.record === "run.snapshot_manifest"),
    ).toHaveLength(1);
  } finally {
    await writer.close();
  }
});

it.each(["absent", "tampered", "duplicate", "mismatch"])(
  "rejects %s manifest references on raw artifact reads",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "review-mesh-manifest-invalid-"));
    roots.push(root);
    const path = join(root, "run.jsonl.active");
    const writer = await createRunArtifact({
      path,
      runId: "run",
      toolVersion: "9.4.0",
    });
    try {
      if (mode !== "absent") {
        const manifest = {
          record: "run.snapshot_manifest",
          data: {
            index: 0,
            chunk_count: 1,
            identity,
            files:
              mode === "tampered" ? [{ ...files[0]!, byte_count: 7 }] : files,
          },
        };
        await writer.record(manifest);
        if (mode === "duplicate") await writer.record(manifest);
      }
      await writer.record({
        record: "reviewer.coverage",
        reviewer_id: "lens::model",
        data: {
          index: 0,
          snapshot_ref: identity.sha256,
          entries:
            mode === "mismatch"
              ? [
                  {
                    path: "a.ts",
                    kind: "tracked",
                    relevant: true,
                    required_method: "full_file",
                    proof_kind: "observed",
                    snapshot_read: "satisfied",
                    diff_delivery: "satisfied",
                    disposition: "satisfied",
                    snapshot_digest: "b".repeat(64),
                    snapshot_byte_count: 5,
                  },
                ]
              : [],
        },
      });
      await expect(
        readRunArtifact(path, { allowActive: true }),
      ).rejects.toMatchObject({ code: "invalid_artifact_record" });
    } finally {
      await writer.close();
    }
  },
);

it("stores 4800 snapshot files once for 22 reviewers and normalizes failed reviewers' 35 changed paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-mesh-manifest-scale-"));
  roots.push(root);
  const path = join(root, "run.jsonl.active");
  const writer = await createRunArtifact({
    path,
    runId: "run",
    toolVersion: "9.4.0",
  });
  const entries: ChangeCoverageEntry[] = Array.from(
    { length: 4800 },
    (_, i) => ({
      path: `src/${String(i).padStart(4, "0")}.ts`,
      kind: i < 35 ? "tracked" : "supporting",
      relevant: i < 35,
      snapshot_digest: "a".repeat(64),
      snapshot_byte_count: 10,
      required_method: "full_file",
      proof_kind: "observed",
      snapshot_read: i < 35 ? "not_inspected" : "not_required",
      diff_delivery: i < 35 ? "satisfied" : "not_required",
      disposition: i < 35 ? "deficit" : "satisfied",
    }),
  );
  const snapshotFiles = entries.map((e) => ({
    path: e.path,
    byte_count: e.snapshot_byte_count!,
    sha256: e.snapshot_digest!,
  }));
  const snapshotIdentity = {
    ...identity,
    file_count: 4800,
    sha256: createHash("sha256")
      .update(canonicalJson(snapshotFiles))
      .digest("hex"),
  };
  try {
    const recordCoverage = createCoverageRecorder((value) =>
      writer.record(value),
    );
    await Promise.all(
      Array.from({ length: 22 }, (_, i) =>
        recordCoverage({ reviewerId: `lens::${i}`, entries, snapshotIdentity }),
      ),
    );
    for (let i = 0; i < 22; i++)
      await writer.record({
        record: "reviewer.terminal",
        reviewer_id: `lens::${i}`,
        data: {
          status: "incomplete",
          lens_id: "lens",
          reason: "change_coverage_incomplete",
        },
      });
    const artifact = await readRunArtifact(path, { allowActive: true });
    expect(
      artifact.records.filter((r) => r.record === "run.snapshot_manifest"),
    ).toHaveLength(19);
    expect(
      artifact.records.filter((r) => r.record === "reviewer.coverage"),
    ).toHaveLength(22);
    expect(artifact.byte_count).toBeLessThan(1_200_000);
    const normalized = await readNormalizedRun(path, { allowActive: true });
    expect(Object.keys(normalized.snapshot_manifests ?? {})).toHaveLength(1);
    expect(normalized.reviewers).toHaveLength(22);
    expect(
      normalized.reviewers.every(
        (r) =>
          r.coverage?.length === 35 &&
          r.snapshot_ref === snapshotIdentity.sha256,
      ),
    ).toBe(true);
  } finally {
    await writer.close();
  }
});

it("preserves code-point ordering in shared snapshot identities", async () => {
  const paths = ["\uE000.ts", "\u{10000}.ts"];
  const snapshotFiles = paths.map((path) => ({
    path,
    byte_count: 1,
    sha256: "a".repeat(64),
  }));
  const snapshotIdentity = {
    ...identity,
    file_count: 2,
    sha256: createHash("sha256")
      .update(canonicalJson(snapshotFiles))
      .digest("hex"),
  };
  const records: Record<string, unknown>[] = [];
  const recorder = createCoverageRecorder(async (value) => {
    records.push(value);
  });
  await recorder({
    reviewerId: "unicode",
    snapshotIdentity,
    entries: paths.map((path) => ({
      path,
      kind: "supporting",
      relevant: false,
      required_method: "full_file",
      proof_kind: "observed",
      snapshot_read: "not_required",
      diff_delivery: "not_required",
      disposition: "satisfied",
      snapshot_digest: "a".repeat(64),
      snapshot_byte_count: 1,
    })),
  });
  expect(records[0]?.record).toBe("run.snapshot_manifest");
});
