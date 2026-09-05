import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  indexRunArtifact,
  observePublicStream,
  resolveRunArtifact,
  recoverRunArtifact,
} from "../../src/diagnostics/run-index.js";
import {
  createRunArtifact,
  readRunArtifact,
} from "../../src/diagnostics/run-artifact.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "review-mesh-index-"));
  directories.push(root);
  const path = join(root, "external.jsonl");
  const bytes = '{"record":"fixture"}\n';
  await writeFile(path, bytes);
  return {
    root,
    path,
    reference: {
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byte_count: Buffer.byteLength(bytes),
      completed_results: 1,
    },
  };
}

async function completeFixture() {
  const base = await fixture();
  const path = join(base.root, "complete.jsonl");
  const writer = await createRunArtifact({
    path,
    runId: "run-1",
    toolVersion: "9.3.0",
  });
  const reference = await writer.finalize({
    run_outcome: "clear",
    gate_outcome: "no_gate_findings",
    coverage_outcome: "complete",
    exit_code: 0,
    raw_source_findings: 0,
    atomic_subfindings: 0,
    canonical_roots: 0,
    gate_eligible_subfindings: 0,
    advisory_subfindings: 0,
    rejected_subfindings: 0,
    needs_verification_subfindings: 0,
    non_gating_subfindings: 0,
    incomplete_lenses: 0,
    result_delivery: {
      completed_results: 0,
      artifact: "complete",
      planned_public_stream: "references_only",
    },
    lens_summaries: [],
    exclusions: [],
    warnings: [],
    deficit_samples: [],
  });
  const copyPath = join(base.root, "surviving-copy.jsonl");
  await writeFile(copyPath, await readFile(path));
  const runsDirectory = join(base.root, "runs");
  await indexRunArtifact({
    runsDirectory,
    runId: "run-1",
    artifact: reference,
  });
  return { ...base, path, reference, copyPath, runsDirectory };
}

describe("authoritative run artifact index", () => {
  it("keeps the final index absent if staged publication bytes are incomplete", async () => {
    const { root, reference } = await fixture();
    const runsDirectory = join(root, "runs");
    await expect(
      indexRunArtifact({
        runsDirectory,
        runId: "run-1",
        artifact: reference,
        afterStagingWrite: async (path) => {
          await writeFile(path, "{partial");
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_run_index" });
    await expect(
      lstat(join(runsDirectory, "run-1.index.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.each(["managed", "copy"])(
    "imports unindexed complete managed bytes using the %s reference",
    async (source) => {
      const { path, copyPath, reference, runsDirectory } =
        await completeFixture();
      const managedPath = join(runsDirectory, "run-1.jsonl");
      await writeFile(managedPath, await readFile(path));
      await rm(join(runsDirectory, "run-1.index.json"));
      const artifactPath = source === "managed" ? managedPath : copyPath;
      expect(
        await recoverRunArtifact({
          runsDirectory,
          runId: "run-1",
          artifactPath,
        }),
      ).toMatchObject({
        recovered_from_unindexed: true,
        artifact: { path: artifactPath, sha256: reference.sha256 },
      });
      expect(
        (await resolveRunArtifact("run-1", { runsDirectory })).resolution,
      ).toMatchObject({ recovered_from_unindexed: true });
    },
  );

  it("does not import over a conflicting unindexed managed artifact", async () => {
    const { copyPath, runsDirectory } = await completeFixture();
    await rm(join(runsDirectory, "run-1.index.json"));
    const managedPath = join(runsDirectory, "run-1.jsonl");
    await writeFile(managedPath, "foreign managed content");
    await expect(
      recoverRunArtifact({
        runsDirectory,
        runId: "run-1",
        artifactPath: copyPath,
      }),
    ).rejects.toMatchObject({ code: "index_conflict" });
    expect(await readFile(managedPath, "utf8")).toBe("foreign managed content");
  });
  it("imports a complete unindexed recovery copy without claiming the original stream succeeded", async () => {
    const { path, copyPath, runsDirectory } = await completeFixture();
    await rm(path);
    await rm(join(runsDirectory, "run-1.index.json"));
    const recovered = await recoverRunArtifact({
      runsDirectory,
      runId: "run-1",
      artifactPath: copyPath,
    });
    expect(recovered).toMatchObject({
      recovered_from_unindexed: true,
      artifact: { path: copyPath },
      caller_owned: true,
    });
    expect(await resolveRunArtifact("run-1", { runsDirectory })).toMatchObject({
      observed_public_stream: "failed",
      digest_status: "verified",
    });
  });

  it("restores a dead interrupted index transaction before explicit artifact recovery", async () => {
    const { path, copyPath, runsDirectory } = await completeFixture();
    const indexPath = join(runsDirectory, "run-1.index.json");
    const previous = JSON.parse(await readFile(indexPath, "utf8"));
    const identity = await lstat(indexPath, { bigint: true });
    await mkdir(`${indexPath}.update`);
    await writeFile(
      join(`${indexPath}.update`, "previous.json"),
      JSON.stringify({
        schema_version: "1",
        pid: 2147483647,
        nonce: "00000000-0000-4000-8000-000000000001",
        index_identity: {
          dev: String(identity.dev),
          ino: String(identity.ino),
        },
        previous_sha256: createHash("sha256")
          .update(JSON.stringify(previous) + "\n")
          .digest("hex"),
        previous_document: previous,
      }),
    );
    await writeFile(indexPath, "{interrupted");
    await rm(path);
    await expect(
      resolveRunArtifact("run-1", { runsDirectory }),
    ).rejects.toMatchObject({ code: "index_conflict" });
    expect(
      await recoverRunArtifact({
        runsDirectory,
        runId: "run-1",
        artifactPath: copyPath,
      }),
    ).toMatchObject({ status: "recovered" });
    expect(await resolveRunArtifact("run-1", { runsDirectory })).toMatchObject({
      artifact: { path: copyPath },
    });
    await expect(lstat(`${indexPath}.update`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses a live index updater and preserves its previous document", async () => {
    const { path, copyPath, runsDirectory } = await completeFixture();
    const indexPath = join(runsDirectory, "run-1.index.json");
    const previous = JSON.parse(await readFile(indexPath, "utf8"));
    const identity = await lstat(indexPath, { bigint: true });
    await mkdir(`${indexPath}.update`);
    const journalPath = join(`${indexPath}.update`, "previous.json");
    const journal = JSON.stringify({
      schema_version: "1",
      pid: process.pid,
      nonce: "00000000-0000-4000-8000-000000000001",
      index_identity: { dev: String(identity.dev), ino: String(identity.ino) },
      previous_sha256: createHash("sha256")
        .update(JSON.stringify(previous) + "\n")
        .digest("hex"),
      previous_document: previous,
    });
    await writeFile(journalPath, journal);
    await rm(path);
    await expect(
      recoverRunArtifact({
        runsDirectory,
        runId: "run-1",
        artifactPath: copyPath,
      }),
    ).rejects.toMatchObject({ code: "index_conflict" });
    expect(await readFile(journalPath, "utf8")).toBe(journal);
  });
  it("explicitly recovers an orphaned index from a complete exact caller copy", async () => {
    const { root, path, copyPath, reference, runsDirectory } =
      await completeFixture();
    await observePublicStream({
      runsDirectory,
      runId: "run-1",
      outcome: "references_only",
    });
    await rm(path);
    expect(
      await recoverRunArtifact({
        runsDirectory,
        runId: "run-1",
        artifactPath: copyPath,
      }),
    ).toMatchObject({
      status: "recovered",
      run_id: "run-1",
      previous_path: path,
      artifact: { ...reference, path: copyPath },
      caller_owned: true,
    });
    expect(await resolveRunArtifact("run-1", { runsDirectory })).toMatchObject({
      artifact: { path: copyPath },
      observed_public_stream: "references_only",
      digest_status: "verified",
    });
    expect(
      JSON.parse(
        await readFile(join(runsDirectory, "run-1.index.json"), "utf8"),
      ),
    ).toMatchObject({ schema_version: "2", artifact_ownership: "caller" });
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses recovery while the current primary exists or caller bytes differ", async () => {
    const { path, copyPath, runsDirectory } = await completeFixture();
    await expect(
      recoverRunArtifact({
        runsDirectory,
        runId: "run-1",
        artifactPath: copyPath,
      }),
    ).rejects.toMatchObject({ code: "index_conflict" });
    await rm(path);
    await writeFile(copyPath, "not an artifact");
    await expect(
      recoverRunArtifact({
        runsDirectory,
        runId: "run-1",
        artifactPath: copyPath,
      }),
    ).rejects.toMatchObject({ code: "artifact_digest_mismatch" });
  });

  it("refuses recovery for an active control lease or symlinked copy", async () => {
    const { root, path, copyPath, runsDirectory } = await completeFixture();
    await rm(path);
    const lease = join(runsDirectory, "run-1.control.json");
    await writeFile(
      lease,
      JSON.stringify({ run_id: "run-1", nonce: "active" }),
    );
    await expect(
      recoverRunArtifact({
        runsDirectory,
        runId: "run-1",
        artifactPath: copyPath,
      }),
    ).rejects.toMatchObject({ code: "index_conflict" });
    await rm(lease);
    const linkPath = join(root, "linked-copy.jsonl");
    await symlink(copyPath, linkPath, "file");
    await expect(
      recoverRunArtifact({
        runsDirectory,
        runId: "run-1",
        artifactPath: linkPath,
      }),
    ).rejects.toMatchObject({ code: "artifact_identity_changed" });
  });

  it("never recovers fixture bytes that do not contain a complete artifact", async () => {
    const { path, root, reference } = await fixture();
    const runsDirectory = join(root, "runs");
    const copyPath = join(root, "fixture-copy.jsonl");
    await writeFile(copyPath, await readFile(path));
    await indexRunArtifact({
      runsDirectory,
      runId: "run-1",
      artifact: reference,
    });
    await rm(path);
    await expect(
      recoverRunArtifact({
        runsDirectory,
        runId: "run-1",
        artifactPath: copyPath,
      }),
    ).rejects.toMatchObject({ code: "unsupported_schema_version" });
  });
  it("uses a registered identical alternate only when the primary is missing", async () => {
    const { root, path, reference } = await fixture();
    const runsDirectory = join(root, "runs");
    const alternatePath = join(root, "details.jsonl");
    await writeFile(alternatePath, await readFile(path));
    const alternate = { ...reference, path: alternatePath };
    await indexRunArtifact({
      runsDirectory,
      runId: "run-1",
      artifact: reference,
      alternatives: [alternate],
    });
    await rm(path);
    expect(await resolveRunArtifact("run-1", { runsDirectory })).toMatchObject({
      artifact: alternate,
      digest_status: "verified",
      resolution: {
        source: "alternate",
        primary_path: path,
        resolved_path: alternatePath,
        warnings: [{ code: "primary_artifact_missing" }],
      },
    });
  });

  it("never hides primary tampering behind a valid alternate", async () => {
    const { root, path, reference } = await fixture();
    const runsDirectory = join(root, "runs");
    const alternatePath = join(root, "details.jsonl");
    await writeFile(alternatePath, await readFile(path));
    await indexRunArtifact({
      runsDirectory,
      runId: "run-1",
      artifact: reference,
      alternatives: [{ ...reference, path: alternatePath }],
    });
    await writeFile(path, "tampered");
    await expect(
      resolveRunArtifact("run-1", { runsDirectory }),
    ).rejects.toMatchObject({ code: "artifact_digest_mismatch" });
  });

  it("rejects nonidentical registered copies and caps alternate registration", async () => {
    const { root, reference } = await fixture();
    const alternatePath = join(root, "different.jsonl");
    await writeFile(alternatePath, "different");
    await expect(
      indexRunArtifact({
        runsDirectory: join(root, "runs"),
        runId: "run-1",
        artifact: reference,
        alternatives: [{ ...reference, path: alternatePath }],
      }),
    ).rejects.toMatchObject({ code: "artifact_digest_mismatch" });
    await expect(
      indexRunArtifact({
        runsDirectory: join(root, "runs"),
        runId: "run-2",
        artifact: reference,
        alternatives: Array.from({ length: 5 }, () => reference),
      }),
    ).rejects.toMatchObject({ code: "invalid_run_index" });
  });

  it("provides missing-primary diagnostics with a concrete recovery command", async () => {
    const { root, path, reference } = await fixture();
    const runsDirectory = join(root, "runs");
    await indexRunArtifact({
      runsDirectory,
      runId: "run-1",
      artifact: reference,
    });
    await rm(path);
    await expect(
      resolveRunArtifact("run-1", { runsDirectory }),
    ).rejects.toMatchObject({
      code: "artifact_unavailable",
      diagnosticDetails: {
        stage: "resolve_primary",
        native_error_code: "ENOENT",
        path,
        run_id: "run-1",
        recovery_command: "review-mesh recover run-1 --artifact <COPY_PATH>",
      },
    });
  });
  it("does not create a missing runs directory through a redirected ancestor", async () => {
    const { root, reference } = await fixture();
    const outside = join(root, "outside");
    const redirected = join(root, "redirected");
    await mkdir(outside);
    await symlink(
      outside,
      redirected,
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(
      indexRunArtifact({
        runsDirectory: join(redirected, "missing"),
        runId: "run-1",
        artifact: reference,
      }),
    ).rejects.toMatchObject({ code: "artifact_identity_changed" });
    await expect(lstat(join(outside, "missing"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("verifies exact finalized bytes and records observed stdout separately", async () => {
    const { root, path, reference } = await fixture();
    const runsDirectory = join(root, "runs");
    await indexRunArtifact({
      runsDirectory,
      runId: "run-1",
      artifact: reference,
    });
    const before = await readFile(path);
    await observePublicStream({
      runsDirectory,
      runId: "run-1",
      outcome: "references_only",
    });
    expect(await resolveRunArtifact("run-1", { runsDirectory })).toMatchObject({
      artifact: reference,
      observed_public_stream: "references_only",
      digest_status: "verified",
    });
    expect(await readFile(path)).toEqual(before);
  });

  it("rejects a removed external target instead of falling back to a stale local file", async () => {
    const { root, path, reference } = await fixture();
    const runsDirectory = join(root, "runs");
    await indexRunArtifact({
      runsDirectory,
      runId: "run-1",
      artifact: reference,
    });
    await writeFile(join(runsDirectory, "run-1.jsonl"), "stale staging\n");
    await rm(path);
    await expect(
      resolveRunArtifact("run-1", { runsDirectory }),
    ).rejects.toMatchObject({ code: "artifact_unavailable" });
  });

  it("rejects replacement identity even when the replacement has identical bytes", async () => {
    const { root, path, reference } = await fixture();
    const runsDirectory = join(root, "runs");
    await indexRunArtifact({
      runsDirectory,
      runId: "run-1",
      artifact: reference,
    });
    await rename(path, join(root, "old.jsonl"));
    await writeFile(path, await readFile(join(root, "old.jsonl")));
    await expect(
      resolveRunArtifact("run-1", { runsDirectory }),
    ).rejects.toMatchObject({ code: "artifact_identity_changed" });
  });

  it("carries indexed identity into replay and rejects a post-lookup replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-mesh-index-read-"));
    directories.push(root);
    const path = join(root, "external.jsonl");
    const writer = await createRunArtifact({
      path,
      runId: "run-1",
      toolVersion: "9.0.0",
    });
    const reference = await writer.finalize({
      run_outcome: "clear",
      gate_outcome: "no_gate_findings",
      coverage_outcome: "complete",
      exit_code: 0,
      raw_source_findings: 0,
      atomic_subfindings: 0,
      canonical_roots: 0,
      gate_eligible_subfindings: 0,
      advisory_subfindings: 0,
      rejected_subfindings: 0,
      needs_verification_subfindings: 0,
      non_gating_subfindings: 0,
      incomplete_lenses: 0,
      result_delivery: {
        completed_results: 0,
        artifact: "complete",
        planned_public_stream: "references_only",
      },
      lens_summaries: [],
      exclusions: [],
      warnings: [],
      deficit_samples: [],
    });
    const runsDirectory = join(root, "runs");
    await indexRunArtifact({
      runsDirectory,
      runId: "run-1",
      artifact: reference,
    });
    const resolved = await resolveRunArtifact("run-1", { runsDirectory });
    expect(resolved.expected_identity).toMatchObject({
      dev: expect.stringMatching(/^\d+$/),
      ino: expect.stringMatching(/^\d+$/),
    });
    await rename(path, join(root, "old.jsonl"));
    await writeFile(path, await readFile(join(root, "old.jsonl")));
    await expect(
      readRunArtifact(path, {
        expectedSha256: resolved.artifact.sha256,
        expectedIdentity: resolved.expected_identity,
      }),
    ).rejects.toMatchObject({ code: "artifact_identity_changed" });
  });

  it("rejects changed content and prevents replacing an existing run index", async () => {
    const { root, path, reference } = await fixture();
    const runsDirectory = join(root, "runs");
    await indexRunArtifact({
      runsDirectory,
      runId: "run-1",
      artifact: reference,
    });
    await expect(
      indexRunArtifact({ runsDirectory, runId: "run-1", artifact: reference }),
    ).rejects.toMatchObject({ code: "index_conflict" });
    await writeFile(path, '{"record":"changed"}\n');
    await expect(
      resolveRunArtifact("run-1", { runsDirectory }),
    ).rejects.toMatchObject({ code: "artifact_digest_mismatch" });
  });

  it("rejects unsupported or unsafe index documents before artifact lookup", async () => {
    const { root, reference } = await fixture();
    const runsDirectory = join(root, "runs");
    await indexRunArtifact({
      runsDirectory,
      runId: "run-1",
      artifact: reference,
    });
    const indexPath = join(runsDirectory, "run-1.index.json");
    const document = JSON.parse(await readFile(indexPath, "utf8"));
    document.schema_version = "999";
    await writeFile(indexPath, JSON.stringify(document));
    await expect(
      resolveRunArtifact("run-1", { runsDirectory }),
    ).rejects.toMatchObject({ code: "unsupported_schema_version" });
    await expect(
      resolveRunArtifact("../outside", { runsDirectory }),
    ).rejects.toMatchObject({ code: "invalid_run_id" });
  });

  it("still reads and updates a legacy v1 index without changing its artifact identity", async () => {
    const { path, runsDirectory, reference } = await completeFixture();
    const indexPath = join(runsDirectory, "run-1.index.json");
    const current = JSON.parse(await readFile(indexPath, "utf8"));
    delete current.alternatives;
    delete current.artifact_ownership;
    current.schema_version = "1";
    await writeFile(indexPath, JSON.stringify(current));
    await observePublicStream({
      runsDirectory,
      runId: "run-1",
      outcome: "complete",
    });
    expect(await resolveRunArtifact("run-1", { runsDirectory })).toMatchObject({
      artifact: reference,
      observed_public_stream: "complete",
      resolution: { source: "primary", primary_path: path },
    });
    expect(JSON.parse(await readFile(indexPath, "utf8")).schema_version).toBe(
      "1",
    );
  });

  it("does not accept an identical-byte replacement of an alternate", async () => {
    const { root, path, reference } = await fixture();
    const runsDirectory = join(root, "runs");
    const alternatePath = join(root, "details.jsonl");
    await writeFile(alternatePath, await readFile(path));
    await indexRunArtifact({
      runsDirectory,
      runId: "run-1",
      artifact: reference,
      alternatives: [{ ...reference, path: alternatePath }],
    });
    await rm(path);
    await rename(alternatePath, `${alternatePath}.old`);
    await writeFile(alternatePath, await readFile(`${alternatePath}.old`));
    await expect(
      resolveRunArtifact("run-1", { runsDirectory }),
    ).rejects.toMatchObject({
      code: "artifact_identity_changed",
      diagnosticDetails: { stage: "resolve_alternate" },
    });
  });

  it("does not mutate a foreign replacement index when reclaiming a dead transaction", async () => {
    const { path, copyPath, runsDirectory } = await completeFixture();
    const indexPath = join(runsDirectory, "run-1.index.json");
    const previous = JSON.parse(await readFile(indexPath, "utf8"));
    const identity = await lstat(indexPath, { bigint: true });
    await mkdir(`${indexPath}.update`);
    await writeFile(
      join(`${indexPath}.update`, "previous.json"),
      JSON.stringify({
        schema_version: "1",
        pid: 2147483647,
        nonce: "00000000-0000-4000-8000-000000000001",
        index_identity: {
          dev: String(identity.dev),
          ino: String(identity.ino),
        },
        previous_sha256: createHash("sha256")
          .update(JSON.stringify(previous) + "\n")
          .digest("hex"),
        previous_document: previous,
      }),
    );
    await rename(indexPath, `${indexPath}.old`);
    await writeFile(indexPath, "foreign replacement");
    await rm(path);
    await expect(
      recoverRunArtifact({
        runsDirectory,
        runId: "run-1",
        artifactPath: copyPath,
      }),
    ).rejects.toMatchObject({ code: "index_conflict" });
    expect(await readFile(indexPath, "utf8")).toBe("foreign replacement");
  });
});
