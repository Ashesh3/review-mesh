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
  releaseRunSnapshot,
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
  options: {
    diffTruncated?: boolean;
    changedFilesTruncated?: boolean;
    mode?: "changes" | "full";
    scopePaths?: string[];
  } = {},
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
    review_scope: {
      mode: options.mode ?? "changes",
      source: "request",
      ...(options.scopePaths === undefined
        ? {}
        : { paths: options.scopePaths }),
    },
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
        changed_files: options.changedFilesTruncated ?? false,
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

  it("captures a newly written file when Windows settles its metadata during the first open", async () => {
    const root = await workspace();
    await writeFile(join(root, "changed.txt"), "x".repeat(131072));
    const ledger = await createChangeCoverageLedger({
      context: context(root, [{ path: "changed.txt", kind: "tracked" }]),
      policy: observedFullFile,
    });
    expect(await ledger.readFile({ path: "changed.txt" })).toMatchObject({
      ok: true,
      byteCount: 131072,
    });
  });

  it("fingerprints untracked and supporting snapshot bytes across fresh captures", async () => {
    const root = await workspace();
    await writeFile(join(root, "worker.ts"), "first");
    await writeFile(join(root, "neighbor.ts"), "support");
    const resolved = context(root, [{ path: "worker.ts", kind: "untracked" }]);
    const first = await createChangeCoverageLedger({
      context: resolved,
      policy: observedFullFile,
    });
    expect(first.snapshotIdentity()).toMatchObject({
      schema_version: "1",
      complete: true,
      file_count: 2,
    });
    await writeFile(join(root, "neighbor.ts"), "changed support");
    const fresh = await createChangeCoverageLedger({
      context: structuredClone(resolved),
      policy: observedFullFile,
    });
    expect(fresh.snapshotIdentity().sha256).not.toBe(
      first.snapshotIdentity().sha256,
    );
    await writeFile(join(root, "worker.ts"), "new untracked bytes");
    const changed = await createChangeCoverageLedger({
      context: structuredClone(resolved),
      policy: observedFullFile,
    });
    expect(changed.snapshotIdentity().sha256).not.toBe(
      fresh.snapshotIdentity().sha256,
    );
  });

  it("marks snapshot identity incomplete when capture skipped unreadable evidence", async () => {
    const root = await workspace();
    await writeFile(join(root, "worker.ts"), Buffer.from([0]));
    const ledger = await createChangeCoverageLedger({
      context: context(root, []),
      policy: observedFullFile,
    });
    expect(ledger.snapshotIdentity().complete).toBe(false);
  });

  it.each(["diff", "full_file"] as const)(
    "reads changed relevant, changed supporting, and unchanged files with %s coverage",
    async (minimumInspection) => {
      const root = await workspace();
      await writeFile(join(root, "worker.ts"), "rélevant", "utf8");
      await writeFile(join(root, "support.ts"), "supporting change", "utf8");
      await writeFile(join(root, "neighbor.ts"), "unchanged neighbor", "utf8");
      const resolved = context(root, [
        { path: "worker.ts", kind: "tracked" },
        { path: "support.ts", kind: "tracked" },
      ]);
      const ledger = await createChangeCoverageLedger({
        context: resolved,
        policy: {
          ...observedFullFile,
          minimumInspection,
          relevantPaths: ["worker.ts"],
        },
      });
      await writeFile(join(root, "support.ts"), "later live content", "utf8");
      ledger.recordDiffDelivery(["worker.ts"], diffProof(resolved));

      for (const [path, content] of [
        ["worker.ts", "rélevant"],
        ["support.ts", "supporting change"],
        ["neighbor.ts", "unchanged neighbor"],
      ] as const) {
        const read = await ledger.readFile({ path });
        expect(read, path).toMatchObject({ ok: true });
        if (!read.ok) throw new Error(read.reason);
        expect(Buffer.from(read.bytes).toString("utf8")).toBe(content);
        read.acknowledgeDelivered();
        expect(ledger.observedFile(path)).toBe(true);
      }
      expect(ledger.summary()).toMatchObject({
        status: "complete",
        inspected_count: 1,
        deficit_count: 0,
      });
    },
  );

  it("keeps an unavailable initial changed snapshot unavailable for later reviewers", async () => {
    const root = await workspace();
    const resolved = context(root, [{ path: "worker.ts", kind: "untracked" }]);
    const first = await createChangeCoverageLedger({
      context: resolved,
      policy: observedFullFile,
    });
    expect((await first.readFile({ path: "worker.ts" })).ok).toBe(false);
    await writeFile(join(root, "worker.ts"), "created after capture", "utf8");
    const second = await createChangeCoverageLedger({
      context: resolved,
      policy: observedFullFile,
    });
    expect(await second.readFile({ path: "worker.ts" })).toEqual({
      ok: false,
      path: "worker.ts",
      reason: "unavailable",
    });
  });

  it("keeps optional unreadable supporting snapshots separate from required diff coverage", async () => {
    const root = await workspace();
    await writeFile(join(root, "worker.ts"), Buffer.from([0, 1]));
    const resolved = context(root, [{ path: "worker.ts", kind: "tracked" }]);
    const ledger = await createChangeCoverageLedger({
      context: resolved,
      policy: { ...observedFullFile, minimumInspection: "diff" },
    });
    ledger.recordDiffDelivery(["worker.ts"], diffProof(resolved));
    expect(await ledger.readFile({ path: "worker.ts" })).toEqual({
      ok: false,
      path: "worker.ts",
      reason: "binary",
    });
    expect(ledger.summary()).toMatchObject({
      status: "complete",
      deficit_count: 0,
    });
  });

  it("keeps changed files outside a full-review path filter unavailable", async () => {
    const root = await workspace();
    await mkdir(join(root, "allowed"));
    await mkdir(join(root, "outside"));
    await writeFile(join(root, "allowed/worker.ts"), "allowed", "utf8");
    await writeFile(join(root, "outside/worker.ts"), "outside", "utf8");
    const ledger = await createChangeCoverageLedger({
      context: context(
        root,
        [
          { path: "allowed/worker.ts", kind: "tracked" },
          { path: "outside/worker.ts", kind: "tracked" },
        ],
        { mode: "full", scopePaths: ["allowed"] },
      ),
      policy: observedFullFile,
    });
    expect(await ledger.readFile({ path: "allowed/worker.ts" })).toMatchObject({
      ok: true,
    });
    expect(await ledger.readFile({ path: "outside/worker.ts" })).toEqual({
      ok: false,
      path: "outside/worker.ts",
      reason: "unavailable",
    });
  });

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

  it("keeps the run snapshot after a reviewer closes until explicit teardown", async () => {
    const root = await workspace();
    await writeFile(join(root, "worker.ts"), "first", "utf8");
    const resolved = context(root, [{ path: "worker.ts", kind: "untracked" }]);
    const first = await createChangeCoverageLedger({
      context: resolved,
      policy: observedFullFile,
    });
    await first.close();
    await writeFile(join(root, "worker.ts"), "second", "utf8");

    const fallback = await createChangeCoverageLedger({
      context: resolved,
      policy: observedFullFile,
    });
    const pinned = await fallback.readFile({ path: "worker.ts" });
    if (!pinned.ok) throw new Error(pinned.reason);
    expect(Buffer.from(pinned.bytes).toString("utf8")).toBe("first");

    await fallback.close();
    releaseRunSnapshot(resolved);
    const nextRun = await createChangeCoverageLedger({
      context: resolved,
      policy: observedFullFile,
    });
    const recaptured = await nextRun.readFile({ path: "worker.ts" });
    if (!recaptured.ok) throw new Error(recaptured.reason);
    expect(Buffer.from(recaptured.bytes).toString("utf8")).toBe("second");
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

  it("keeps a truncated changed-file manifest as a scope deficit", async () => {
    const root = await workspace();
    await writeFile(join(root, "worker.ts"), "abcdef", "utf8");
    const truncated = context(root, [{ path: "worker.ts", kind: "tracked" }], {
      changedFilesTruncated: true,
    });
    const ledger = await createChangeCoverageLedger({
      context: truncated,
      policy: observedFullFile,
    });
    ledger.recordDiffDelivery(["worker.ts"], diffProof(truncated));
    const read = await ledger.readFile({ path: "worker.ts" });
    if (!read.ok) throw new Error(read.reason);
    read.acknowledgeDelivered();

    expect(ledger.summary()).toMatchObject({
      status: "incomplete",
      inspected_count: 1,
      deficit_count: 1,
      deficit_sample: [
        { path: "<change_scope>", reason: "changed_files_truncated" },
      ],
    });

    const completeManifest = context(root, [
      { path: "worker.ts", kind: "tracked" },
    ]);
    const completeLedger = await createChangeCoverageLedger({
      context: completeManifest,
      policy: observedFullFile,
    });
    expect(ledger.scopeDigest).not.toBe(completeLedger.scopeDigest);
  });

  it("distinguishes policy exclusion from full-review non-applicability", async () => {
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
    expect(excluded.notApplicable).toEqual({
      reason: "policy_excluded",
      policy_reference: { relevant_paths: ["src/**"] },
    });

    const full = await createChangeCoverageLedger({
      context: context(root, [], { mode: "full" }),
      policy: observedFullFile,
    });
    expect(full.summary().status).toBe("not_applicable");
    expect(full.notApplicable).toEqual({ reason: "full_review" });
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

  it("recovers a corrected read range while still rejecting provider attestation", async () => {
    const root = await workspace();
    await writeFile(join(root, "worker.ts"), "abcdef", "utf8");
    const ledger = await createChangeCoverageLedger({
      context: context(root, [{ path: "worker.ts", kind: "untracked" }]),
      policy: observedFullFile,
    });
    await unlink(join(root, "worker.ts"));
    expect(
      await ledger.readFile({ path: "worker.ts", byteCount: 128 * 1024 + 1 }),
    ).toEqual({
      ok: false,
      path: "worker.ts",
      reason: "invalid_range",
      maximumByteCount: 128 * 1024,
      totalByteCount: 6,
    });
    const read = await ledger.readFile({ path: "worker.ts" });
    if (!read.ok) throw new Error(read.reason);
    read.acknowledgeDelivered();
    expect(ledger.summary()).toMatchObject({
      status: "complete",
      deficit_count: 0,
    });
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

  it.each([131071, 131072, 131073])(
    "applies the shared read limit to %i-byte requests without poisoning coverage",
    async (byteCount) => {
      const root = await workspace();
      await writeFile(join(root, "worker.ts"), Buffer.alloc(131073, 65));
      const ledger = await createChangeCoverageLedger({
        context: context(root, [{ path: "worker.ts", kind: "untracked" }]),
        policy: observedFullFile,
      });
      const read = await ledger.readFile({ path: "worker.ts", byteCount });
      if (byteCount <= 131072) {
        expect(read).toMatchObject({ ok: true, byteCount });
        if (!read.ok) throw new Error(read.reason);
        read.acknowledgeDelivered();
      } else {
        expect(read).toEqual({
          ok: false,
          path: "worker.ts",
          reason: "invalid_range",
          maximumByteCount: 131072,
          totalByteCount: 131073,
        });
        const corrected = await ledger.readFile({
          path: "worker.ts",
          byteCount: 131072,
        });
        if (!corrected.ok) throw new Error(corrected.reason);
        corrected.acknowledgeDelivered();
      }
      const tail = await ledger.readFile({
        path: "worker.ts",
        offset: Math.min(byteCount, 131072),
      });
      if (!tail.ok) throw new Error(tail.reason);
      tail.acknowledgeDelivered();
      expect(ledger.summary()).toMatchObject({
        status: "complete",
        deficit_count: 0,
      });
    },
  );

  it("reports exact acknowledged UTF-8 byte gaps and independent diff obligations", async () => {
    const root = await workspace();
    await writeFile(join(root, "worker.ts"), "aé😀z", "utf8");
    const resolved = context(root, [{ path: "worker.ts", kind: "tracked" }]);
    const ledger = await createChangeCoverageLedger({
      context: resolved,
      policy: observedFullFile,
    });
    const read = await ledger.readFile({
      path: "worker.ts",
      offset: 1,
      byteCount: 3,
    });
    if (!read.ok) throw new Error(read.reason);
    expect(ledger.status().deficits[0]).toMatchObject({
      path: "worker.ts",
      delivered_byte_ranges: [],
      missing_byte_ranges: [{ offset: 0, byte_count: 8 }],
      snapshot_content_delivered: false,
      diff_required: true,
      diff_delivery: "not_inspected",
    });
    read.acknowledgeDelivered();
    expect(ledger.status().deficits[0]).toMatchObject({
      delivered_byte_ranges: [{ offset: 1, byte_count: 3 }],
      missing_byte_ranges: [
        { offset: 0, byte_count: 1 },
        { offset: 4, byte_count: 4 },
      ],
    });
    for (const range of ledger.status().deficits[0]!.missing_byte_ranges) {
      const gap = await ledger.readFile({
        path: "worker.ts",
        offset: range.offset,
        byteCount: range.byte_count,
      });
      if (!gap.ok) throw new Error(gap.reason);
      gap.acknowledgeDelivered();
    }
    expect(ledger.status()).toMatchObject({
      complete: false,
      maximum_read_bytes: 131072,
      deficits: [
        {
          path: "worker.ts",
          snapshot_content_delivered: true,
          missing_byte_ranges: [],
          diff_delivery: "not_inspected",
        },
      ],
    });
    ledger.recordDiffDelivery(["worker.ts"], diffProof(resolved));
    expect(ledger.status()).toMatchObject({ complete: true, deficits: [] });
  });

  it("splits outstanding bytes into valid reads including an unread empty file", async () => {
    const root = await workspace();
    await writeFile(join(root, "worker.ts"), Buffer.alloc(262145, 65));
    await writeFile(join(root, "empty.ts"), "", "utf8");
    const ledger = await createChangeCoverageLedger({
      context: context(root, [
        { path: "worker.ts", kind: "untracked" },
        { path: "empty.ts", kind: "untracked" },
      ]),
      policy: observedFullFile,
    });
    expect(ledger.status().deficits).toMatchObject([
      { path: "empty.ts", missing_byte_ranges: [{ offset: 0, byte_count: 0 }] },
      {
        path: "worker.ts",
        missing_byte_ranges: [
          { offset: 0, byte_count: 131072 },
          { offset: 131072, byte_count: 131072 },
          { offset: 262144, byte_count: 1 },
        ],
      },
    ]);
    for (const entry of ledger.status().deficits) {
      for (const range of entry.missing_byte_ranges) {
        const read = await ledger.readFile({
          path: entry.path,
          offset: range.offset,
          byteCount: range.byte_count,
        });
        if (!read.ok) throw new Error(read.reason);
        read.acknowledgeDelivered();
      }
    }
    expect(ledger.status()).toMatchObject({ complete: true, deficits: [] });
  });

  it("shows delivered content separately from a sticky integrity failure", async () => {
    const root = await workspace();
    await writeFile(join(root, "worker.ts"), "abc", "utf8");
    const ledger = await createChangeCoverageLedger({
      context: context(root, [{ path: "worker.ts", kind: "untracked" }]),
      policy: observedFullFile,
    });
    const altered = await ledger.readFile({ path: "worker.ts" });
    if (!altered.ok) throw new Error(altered.reason);
    altered.bytes[0] = 0;
    altered.acknowledgeDelivered();
    const retry = await ledger.readFile({ path: "worker.ts" });
    if (!retry.ok) throw new Error(retry.reason);
    retry.acknowledgeDelivered();
    expect(ledger.status()).toMatchObject({
      complete: false,
      deficits: [
        {
          path: "worker.ts",
          reason: "response_bytes_changed",
          snapshot_content_delivered: true,
          missing_byte_ranges: [],
        },
      ],
    });
  });

  it("reports attested-policy delivery without replacing the required attestation", async () => {
    const root = await workspace();
    await writeFile(join(root, "worker.ts"), "abc", "utf8");
    const ledger = await createChangeCoverageLedger({
      context: context(root, [{ path: "worker.ts", kind: "untracked" }]),
      policy: { ...observedFullFile, proof: "attested" },
    });
    const read = await ledger.readFile({ path: "worker.ts" });
    if (!read.ok) throw new Error(read.reason);
    read.acknowledgeDelivered();
    expect(ledger.status()).toMatchObject({
      complete: false,
      deficits: [
        {
          snapshot_content_delivered: true,
          missing_byte_ranges: [],
          attestation_required: true,
          attestation_received: false,
        },
      ],
    });
    ledger.reconcileAttestation({
      scope_digest: ledger.scopeDigest,
      entries: [
        {
          path: "worker.ts",
          method: "full_file",
          snapshot_digest: read.snapshotDigest,
        },
      ],
    });
    expect(ledger.status()).toMatchObject({
      complete: true,
      entries: [{ attestation_received: true }],
    });
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
