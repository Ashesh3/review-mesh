import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
