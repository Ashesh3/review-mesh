import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createChangeCoverageLedger,
  type ChangeCoveragePolicy,
} from "../../src/context/change-coverage.js";
import type { ResolvedContext } from "../../src/context/resolve.js";
import type { CoverageAttestation } from "../../src/protocol/v9.js";

const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

function context(
  workspace: string,
  changedPaths: Array<{
    path: string;
    kind: "tracked" | "deleted" | "untracked";
  }>,
  options: { diffTruncated?: boolean; mode?: "changes" | "full" } = {},
): ResolvedContext {
  const diff = changedPaths
    .filter((entry) => entry.kind !== "untracked")
    .map((entry) => `diff --git a/${entry.path} b/${entry.path}\n`)
    .join("");
  return {
    consistency_mode: "live_worktree",
    workspace,
    project_name: "coverage-test",
    instructions: "Review the changes.",
    review_scope: { mode: options.mode ?? "changes", source: "request" },
    git: {
      is_repository: true,
      root: workspace,
      branch: "main",
      head: "a".repeat(40),
      merge_base: "b".repeat(40),
      status_entries: [],
      changed_files: changedPaths.map((entry) => entry.path),
      changed_paths: changedPaths,
      diff_stat: "",
      diff,
      raw_diff: { byte_count: Buffer.byteLength(diff), sha256: sha256(diff) },
      truncated: {
        status_entries: false,
        changed_files: false,
        diff_stat: false,
        diff: options.diffTruncated ?? false,
      },
    },
  };
}

const observedFullFile: ChangeCoveragePolicy = {
  relevantPaths: ["**"],
  minimumInspection: "full_file",
  proof: "observed",
};

function diffProof(value: ResolvedContext): {
  byteCount: number;
  sha256: string;
} {
  if (!value.git.is_repository || value.git.raw_diff === undefined)
    throw new Error("expected raw diff");
  return {
    byteCount: value.git.raw_diff.byte_count,
    sha256: value.git.raw_diff.sha256,
  };
}

describe("createChangeCoverageLedger", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories
        .splice(0)
        .map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  async function workspace(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), "review-mesh-coverage-"));
    directories.push(path);
    return path;
  }

  it("requires acknowledged gap-free chunks and the tracked diff", async () => {
    const root = await workspace();
    await writeFile(join(root, "worker.ts"), "abcdef", "utf8");
    const resolved = context(root, [{ path: "worker.ts", kind: "tracked" }]);
    const ledger = await createChangeCoverageLedger({
      context: resolved,
      policy: observedFullFile,
    });

    ledger.recordDiffDelivery(["worker.ts"], diffProof(resolved));
    const first = await ledger.readFile({
      path: "worker.ts",
      offset: 0,
      byteCount: 3,
    });
    expect(first).toMatchObject({
      ok: true,
      path: "worker.ts",
      offset: 0,
      byteCount: 3,
      totalByteCount: 6,
      sha256: sha256("abc"),
    });
    expect(first.ok && Buffer.from(first.bytes).toString("utf8")).toBe("abc");
    expect(ledger.summary()).toMatchObject({
      status: "incomplete",
      deficit_count: 1,
    });
    if (first.ok) first.acknowledgeDelivered();
    expect(ledger.summary()).toMatchObject({
      status: "incomplete",
      deficit_count: 1,
    });

    const second = await ledger.readFile({ path: "worker.ts", offset: 3 });
    if (!second.ok) throw new Error(second.reason);
    second.acknowledgeDelivered();
    expect(ledger.summary()).toMatchObject({
      status: "complete",
      proof_kind: "observed",
      inspected_count: 1,
      deficit_count: 0,
    });
  });

  it("keeps the initialization snapshot after the live file changes", async () => {
    const root = await workspace();
    await writeFile(join(root, "worker.ts"), "pinned", "utf8");
    const ledger = await createChangeCoverageLedger({
      context: context(root, [{ path: "worker.ts", kind: "untracked" }]),
      policy: observedFullFile,
    });
    await writeFile(
      join(root, "worker.ts"),
      "changed after initialization",
      "utf8",
    );

    const read = await ledger.readFile({ path: "worker.ts" });
    if (!read.ok) throw new Error(read.reason);
    expect(Buffer.from(read.bytes).toString("utf8")).toBe("pinned");
    expect(read.snapshotDigest).toBe(sha256("pinned"));
  });

  it("shares one pinned run snapshot across reviewer ledgers", async () => {
    const root = await workspace();
    await writeFile(join(root, "worker.ts"), "pinned", "utf8");
    const resolved = context(root, [{ path: "worker.ts", kind: "untracked" }]);
    const first = await createChangeCoverageLedger({
      context: resolved,
      policy: observedFullFile,
    });
    await writeFile(
      join(root, "worker.ts"),
      "changed after first reviewer",
      "utf8",
    );
    const second = await createChangeCoverageLedger({
      context: resolved,
      policy: observedFullFile,
    });
    const firstRead = await first.readFile({ path: "worker.ts" });
    const secondRead = await second.readFile({ path: "worker.ts" });
    if (!firstRead.ok || !secondRead.ok)
      throw new Error("expected pinned reads");
    expect(Buffer.from(secondRead.bytes).toString("utf8")).toBe("pinned");
    expect(secondRead.snapshotDigest).toBe(firstRead.snapshotDigest);
  });

  it("fails closed for symlink escapes without leaking filesystem errors", async () => {
    const root = await workspace();
    const outside = await workspace();
    await writeFile(join(outside, "secret.ts"), "secret", "utf8");
    await symlink(join(outside, "secret.ts"), join(root, "escape.ts"), "file");
    const ledger = await createChangeCoverageLedger({
      context: context(root, [{ path: "escape.ts", kind: "untracked" }]),
      policy: observedFullFile,
    });

    await expect(ledger.readFile({ path: "../secret.ts" })).resolves.toEqual({
      ok: false,
      path: "../secret.ts",
      reason: "invalid_path",
    });
    await expect(ledger.readFile({ path: "escape.ts" })).resolves.toEqual({
      ok: false,
      path: "escape.ts",
      reason: "unavailable",
    });
    expect(ledger.summary().deficit_sample[0]).toMatchObject({
      path: "escape.ts",
      reason: "unavailable",
    });
  });

  it("reports binary, oversize, deleted, untracked, and truncated-diff obligations", async () => {
    const root = await workspace();
    await writeFile(join(root, "binary.dat"), Buffer.from([0, 1, 2]));
    await writeFile(join(root, "large.txt"), Buffer.alloc(512 * 1024 + 1, 65));
    await writeFile(join(root, "new file.ts"), "new", "utf8");
    const resolved = context(
      root,
      [
        { path: "binary.dat", kind: "tracked" },
        { path: "large.txt", kind: "tracked" },
        { path: "removed file.ts", kind: "deleted" },
        { path: "new file.ts", kind: "untracked" },
      ],
      { diffTruncated: true },
    );
    const ledger = await createChangeCoverageLedger({
      context: resolved,
      policy: observedFullFile,
    });
    ledger.recordDiffDelivery(
      ["binary.dat", "large.txt", "removed file.ts"],
      diffProof(resolved),
    );
    const fresh = await ledger.readFile({ path: "new file.ts" });
    if (!fresh.ok) throw new Error(fresh.reason);
    fresh.acknowledgeDelivered();

    expect(ledger.entries()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "binary.dat",
          snapshot_read: "binary",
        }),
        expect.objectContaining({
          path: "large.txt",
          snapshot_read: "oversize",
        }),
        expect.objectContaining({
          path: "removed file.ts",
          snapshot_read: "not_required",
          diff_delivery: "context_truncated",
        }),
        expect.objectContaining({
          path: "new file.ts",
          snapshot_read: "satisfied",
          diff_delivery: "not_required",
        }),
      ]),
    );
    expect(ledger.summary()).toMatchObject({
      status: "incomplete",
      deficit_count: 3,
    });
  });

  it("marks a lens with no relevant changed paths and a full review not applicable", async () => {
    const root = await workspace();
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "docs/readme.md"), "docs", "utf8");
    const excluded = await createChangeCoverageLedger({
      context: context(root, [{ path: "docs/readme.md", kind: "tracked" }]),
      policy: { ...observedFullFile, relevantPaths: ["src/**"] },
    });
    expect(excluded.summary()).toEqual({
      status: "not_applicable",
      inspected_count: 0,
      deficit_count: 0,
      deficit_sample: [],
    });

    const full = await createChangeCoverageLedger({
      context: context(root, [], { mode: "full" }),
      policy: observedFullFile,
    });
    expect(full.summary().status).toBe("not_applicable");
  });

  it("requires the exact attested scope, methods, and snapshot digests", async () => {
    const root = await workspace();
    await writeFile(join(root, "worker.ts"), "abcdef", "utf8");
    const policy: ChangeCoveragePolicy = {
      ...observedFullFile,
      proof: "attested",
    };
    const resolved = context(root, [{ path: "worker.ts", kind: "tracked" }]);
    const ledger = await createChangeCoverageLedger({
      context: resolved,
      policy,
    });
    ledger.recordDiffDelivery(["worker.ts"], diffProof(resolved));
    const wrong: CoverageAttestation = {
      scope_digest: ledger.scopeDigest,
      entries: [
        {
          path: "worker.ts",
          method: "full_file",
          snapshot_digest: "0".repeat(64),
        },
      ],
    };
    expect(() => ledger.reconcileAttestation(wrong)).toThrow(
      /coverage attestation/i,
    );
    const correct: CoverageAttestation = {
      scope_digest: ledger.scopeDigest,
      entries: [
        {
          path: "worker.ts",
          method: "full_file",
          snapshot_digest: sha256("abcdef"),
        },
      ],
    };
    const cleanContext = context(root, [
      { path: "worker.ts", kind: "tracked" },
    ]);
    const clean = await createChangeCoverageLedger({
      context: cleanContext,
      policy,
    });
    clean.recordDiffDelivery(["worker.ts"], diffProof(cleanContext));
    expect(
      clean.reconcileAttestation({
        ...correct,
        scope_digest: clean.scopeDigest,
      }),
    ).toMatchObject({ status: "complete", deficit_count: 0 });
  });

  it("does not credit arbitrary paths when the captured diff lacks their evidence", async () => {
    const root = await workspace();
    await writeFile(join(root, "worker.ts"), "abcdef", "utf8");
    const noDiff = context(root, [{ path: "worker.ts", kind: "tracked" }]);
    if (!noDiff.git.is_repository) throw new Error("expected Git");
    noDiff.git.diff = "";
    noDiff.git.raw_diff = { byte_count: 0, sha256: sha256("") };
    const ledger = await createChangeCoverageLedger({
      context: noDiff,
      policy: observedFullFile,
    });
    ledger.recordDiffDelivery(["worker.ts"], diffProof(noDiff));
    const read = await ledger.readFile({ path: "worker.ts" });
    if (!read.ok) throw new Error(read.reason);
    read.acknowledgeDelivered();
    expect(ledger.summary()).toMatchObject({
      status: "incomplete",
      deficit_sample: [
        expect.objectContaining({ path: "worker.ts", reason: "not_inspected" }),
      ],
    });
  });

  it("keeps a failed observed read sticky and rejects provider attestation", async () => {
    const root = await workspace();
    await writeFile(join(root, "worker.ts"), "abcdef", "utf8");
    const ledger = await createChangeCoverageLedger({
      context: context(root, [{ path: "worker.ts", kind: "untracked" }]),
      policy: observedFullFile,
    });
    await unlink(join(root, "worker.ts"));
    await ledger.readFile({ path: "worker.ts", byteCount: 128 * 1024 + 1 });
    const read = await ledger.readFile({ path: "worker.ts" });
    if (!read.ok) throw new Error(read.reason);
    read.acknowledgeDelivered();
    const attestation: CoverageAttestation = {
      scope_digest: ledger.scopeDigest,
      entries: [
        {
          path: "worker.ts",
          method: "full_file",
          snapshot_digest: read.snapshotDigest,
        },
      ],
    };
    expect(() => ledger.reconcileAttestation(attestation)).toThrow(
      /observed coverage cannot accept provider attestation/i,
    );
  });

  it("does not credit acknowledgement after returned bytes are mutated or the ledger closes", async () => {
    const root = await workspace();
    await writeFile(join(root, "worker.ts"), "abcdef", "utf8");
    const mutated = await createChangeCoverageLedger({
      context: context(root, [{ path: "worker.ts", kind: "untracked" }]),
      policy: observedFullFile,
    });
    const changed = await mutated.readFile({ path: "worker.ts" });
    if (!changed.ok) throw new Error(changed.reason);
    changed.bytes[0] = 0;
    changed.acknowledgeDelivered();
    expect(mutated.summary()).toMatchObject({
      status: "incomplete",
      deficit_count: 1,
    });

    const closed = await createChangeCoverageLedger({
      context: context(root, [{ path: "worker.ts", kind: "untracked" }]),
      policy: observedFullFile,
    });
    const pending = await closed.readFile({ path: "worker.ts" });
    if (!pending.ok) throw new Error(pending.reason);
    await closed.close();
    pending.acknowledgeDelivered();
    expect(closed.summary()).toMatchObject({
      status: "incomplete",
      deficit_count: 1,
    });
  });

  it("reports more than 256 attested relevant paths as incomplete without throwing", async () => {
    const root = await workspace();
    const changed = Array.from({ length: 257 }, (_, index) => ({
      path: `files/${index}.ts`,
      kind: "untracked" as const,
    }));
    await mkdir(join(root, "files"));
    await Promise.all(
      changed.map((entry) => writeFile(join(root, entry.path), "x", "utf8")),
    );
    const ledger = await createChangeCoverageLedger({
      context: context(root, changed),
      policy: { ...observedFullFile, proof: "attested" },
    });
    expect(
      ledger.reconcileAttestation({
        scope_digest: ledger.scopeDigest,
        entries: [],
      }),
    ).toMatchObject({
      status: "incomplete",
      deficit_count: 257,
      deficit_sample: expect.arrayContaining([
        expect.objectContaining({ reason: "attestation_path_limit" }),
      ]),
    });
  });
});
