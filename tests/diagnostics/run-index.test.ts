import { createHash } from "node:crypto";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  indexRunArtifact,
  observePublicStream,
  resolveRunArtifact,
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

describe("authoritative run artifact index", () => {
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
});
