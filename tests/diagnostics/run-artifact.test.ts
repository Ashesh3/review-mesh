import { createHash } from "node:crypto";
import {
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
  createRunArtifact,
  readRunArtifact,
} from "../../src/diagnostics/run-artifact.js";
import { reviewerResultDigest } from "../../src/results/digest.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "review-mesh-artifact-"));
  roots.push(root);
  return { root, path: join(root, "run-1.jsonl") };
}
const complete = {
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
    completed_results: 1,
    artifact: "complete",
    planned_public_stream: "references_only",
  },
  lens_summaries: [],
  exclusions: [],
  warnings: [],
  deficit_samples: [],
};

describe("immutable artifact format two", () => {
  it("rejects redirected ancestors for creation and replay", async () => {
    const { root } = await fixture();
    const outside = join(root, "outside");
    const redirected = join(root, "redirected");
    await mkdir(outside);
    await symlink(
      outside,
      redirected,
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(
      createRunArtifact({
        path: join(redirected, "run.jsonl"),
        runId: "run-1",
        toolVersion: "9.0.0",
      }),
    ).rejects.toMatchObject({ code: "artifact_identity_changed" });

    const writer = await createRunArtifact({
      path: join(outside, "existing.jsonl"),
      runId: "run-1",
      toolVersion: "9.0.0",
    });
    await writer.finalize({
      ...complete,
      result_delivery: { ...complete.result_delivery, completed_results: 0 },
    });
    await expect(
      readRunArtifact(join(redirected, "existing.jsonl")),
    ).rejects.toMatchObject({ code: "artifact_identity_changed" });
  });

  it("rejects parent replacement during finalization", async () => {
    const { root } = await fixture();
    const parent = join(root, "artifact-parent");
    await mkdir(parent);
    const writer = await createRunArtifact({
      path: join(parent, "run.jsonl"),
      runId: "run-1",
      toolVersion: "9.0.0",
      beforeFinalVerify: async () => {
        await rename(parent, join(root, "artifact-parent-old"));
        await mkdir(parent);
      },
    });
    await expect(
      writer.finalize({
        ...complete,
        result_delivery: {
          ...complete.result_delivery,
          completed_results: 0,
        },
      }),
    ).rejects.toMatchObject({ code: "artifact_identity_changed" });
  });

  it("does not return a stale reference when the open file is modified during finalization", async () => {
    const { path } = await fixture();
    const writer = await createRunArtifact({
      path,
      runId: "run-1",
      toolVersion: "9.0.0",
      beforeFinalVerify: () => writeFile(path, "foreign bytes\n"),
    });
    await expect(
      writer.finalize({
        ...complete,
        result_delivery: {
          ...complete.result_delivery,
          completed_results: 0,
        },
      }),
    ).rejects.toMatchObject({ code: "artifact_digest_mismatch" });
  });

  it("rejects parent replacement before completing replay", async () => {
    const { root } = await fixture();
    const parent = join(root, "read-parent");
    const path = join(parent, "run.jsonl");
    await mkdir(parent);
    const writer = await createRunArtifact({
      path,
      runId: "run-1",
      toolVersion: "9.0.0",
    });
    const reference = await writer.finalize({
      ...complete,
      result_delivery: { ...complete.result_delivery, completed_results: 0 },
    });
    await expect(
      readRunArtifact(path, {
        expectedSha256: reference.sha256,
        beforeFinalVerify: async () => {
          await rename(parent, join(root, "read-parent-old"));
          await mkdir(parent);
        },
      }),
    ).rejects.toMatchObject({ code: "artifact_identity_changed" });
  });

  it("finalizes private summary and content digest without mirroring the public terminal", async () => {
    const { path } = await fixture();
    const writer = await createRunArtifact({
      path,
      runId: "run-1",
      toolVersion: "9.0.0",
      createdAt: "2026-09-05T00:00:00.000Z",
    });
    await writer.record({
      record: "resolution",
      resolution: { reviewers: [] },
    });
    const artifact = await writer.finalize({
      ...complete,
      result_delivery: { ...complete.result_delivery, completed_results: 0 },
    });
    const bytes = await readFile(path);
    const lines = bytes.toString("utf8").trimEnd().split("\n");
    const records = lines.map((line) => JSON.parse(line));
    expect(records[0]).toMatchObject({
      record: "run.artifact",
      artifact_format_version: "2",
    });
    expect(records.at(-2)?.record).toBe("run.terminal_summary");
    expect(records.at(-1)?.record).toBe("run.artifact_terminal");
    expect(records.some((record) => record.event === "run.completed")).toBe(
      false,
    );
    expect(records.at(-1)?.content_sha256).toBe(
      createHash("sha256")
        .update(lines.slice(0, -1).join("\n") + "\n")
        .digest("hex"),
    );
    expect(artifact.sha256).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    await expect(
      writer.record({ record: "request", request: {} }),
    ).rejects.toThrow(/finalized/);
  });

  it("reconstructs a thirteen MiB accepted narrative and verifies its exact digest", async () => {
    const { path } = await fixture();
    const writer = await createRunArtifact({
      path,
      runId: "run-1",
      toolVersion: "9.0.0",
    });
    const result = {
      schema_version: "4" as const,
      verdict: "pass" as const,
      review_markdown: "x".repeat(13 * 1024 * 1024),
      summary: "Review complete",
      actionable_findings: [],
      informational_notes: [],
      change_coverage: {
        status: "not_applicable" as const,
        inspected_count: 0,
        deficit_count: 0,
        deficit_sample: [],
      },
    };
    await writer.result("reviewer-1", result);
    const reference = await writer.finalize(complete);
    const artifact = await readRunArtifact(path, {
      expectedSha256: reference.sha256,
    });
    expect(artifact.results[0]?.result.review_markdown).toBe(
      result.review_markdown,
    );
    expect(artifact.results[0]?.digest).toBe(reviewerResultDigest(result));
    expect(artifact.digest_status).toBe("verified");
  });

  it("rejects future format and mismatched final digest", async () => {
    const { path } = await fixture();
    const writer = await createRunArtifact({
      path,
      runId: "run-1",
      toolVersion: "9.0.0",
    });
    await writer.finalize({
      ...complete,
      result_delivery: { ...complete.result_delivery, completed_results: 0 },
    });
    await expect(
      readRunArtifact(path, { expectedSha256: "a".repeat(64) }),
    ).rejects.toMatchObject({ code: "artifact_digest_mismatch" });
    expect((await readRunArtifact(path)).digest_status).toBe(
      "final_digest_unavailable",
    );
    const bytes = await readFile(path, "utf8");
    await writeFile(
      path,
      bytes.replace(
        '"artifact_format_version":"2"',
        '"artifact_format_version":"999"',
      ),
    );
    await expect(readRunArtifact(path)).rejects.toMatchObject({
      code: "unsupported_schema_version",
    });
  });

  it("rejects unknown private schema versions even when the final byte digest is recomputed", async () => {
    const { path } = await fixture();
    const writer = await createRunArtifact({
      path,
      runId: "run-1",
      toolVersion: "9.0.0",
    });
    await writer.record({ record: "context", context: {} });
    await writer.finalize({
      ...complete,
      result_delivery: { ...complete.result_delivery, completed_results: 0 },
    });
    const records = (await readFile(path, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    records[1].schema_version = "999";
    const prefix =
      records
        .slice(0, -1)
        .map((record) => JSON.stringify(record))
        .join("\n") + "\n";
    records.at(-1).content_sha256 = createHash("sha256")
      .update(prefix)
      .digest("hex");
    records.at(-1).content_byte_count = Buffer.byteLength(prefix);
    await writeFile(path, prefix + JSON.stringify(records.at(-1)) + "\n");
    await expect(readRunArtifact(path)).rejects.toMatchObject({
      code: "unsupported_schema_version",
    });
  });

  it("classifies future header manifests and malformed known records", async () => {
    const { path } = await fixture();
    const writer = await createRunArtifact({
      path,
      runId: "run-1",
      toolVersion: "9.0.0",
    });
    await writer.record({ record: "context", context: {} });
    await writer.finalize({
      ...complete,
      result_delivery: { ...complete.result_delivery, completed_results: 0 },
    });
    const original = await readFile(path, "utf8");
    await writeFile(path, original.replace('"request":"3"', '"request":"999"'));
    await expect(readRunArtifact(path)).rejects.toMatchObject({
      code: "unsupported_schema_version",
    });

    await writeFile(
      path,
      original.replace('"context":{}', '"context":"invalid"'),
    );
    await expect(readRunArtifact(path)).rejects.toMatchObject({
      code: "invalid_artifact_record",
    });
  });

  it("rejects aggregate orphan narrative chunks before consuming a later record", async () => {
    const { path } = await fixture();
    const versions = {
      resolution: "1",
      request: "3",
      context: "1",
      "reviewer.attempt": "1",
      "reviewer.activity": "1",
      "reviewer.activity_summary": "1",
      "reviewer.coverage": "1",
      "reviewer.result_page": "1",
      "reviewer.narrative": "1",
      "reviewer.result": "1",
      "reviewer.terminal": "1",
      "run.terminal_summary": "1",
      "run.artifact_terminal": "1",
    };
    const chunk = "x".repeat(24 * 1024);
    const chunkHash = createHash("sha256").update(chunk).digest("hex");
    const lines = [
      JSON.stringify({
        record: "run.artifact",
        artifact_format_version: "2",
        tool_version: "9.0.0",
        run_id: "run-1",
        created_at: "2026-09-05T00:00:00.000Z",
        private_record_versions: versions,
      }),
    ];
    for (
      let index = 0;
      index <= Math.floor((16 * 1024 * 1024) / chunk.length);
      index++
    )
      lines.push(
        JSON.stringify({
          record: "reviewer.narrative",
          schema_version: "1",
          run_id: "run-1",
          reviewer_id: index % 2 === 0 ? "reviewer-1" : "reviewer-2",
          index: Math.floor(index / 2),
          text: chunk,
          sha256: chunkHash,
        }),
      );
    lines.push("this is deliberately not JSON");
    await writeFile(path, lines.join("\n") + "\n");
    await expect(readRunArtifact(path)).rejects.toMatchObject({
      code: "invalid_artifact_record",
      message: expect.stringMatching(/narrative.*limit/i),
    });
  });

  it("rejects contradictory immutable terminal summaries before claiming finalization", async () => {
    const { path } = await fixture();
    const writer = await createRunArtifact({
      path,
      runId: "run-1",
      toolVersion: "9.0.0",
    });
    await expect(
      writer.finalize({
        ...complete,
        coverage_outcome: "partial",
        result_delivery: { ...complete.result_delivery, completed_results: 0 },
      }),
    ).rejects.toThrow();
  });
});
