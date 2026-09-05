import { EventEmitter } from "node:events";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";
import { createRunArtifact } from "../../src/diagnostics/run-artifact.js";
import {
  indexRunArtifact,
  observePublicStream,
} from "../../src/diagnostics/run-index.js";

const roots: string[] = [];
afterEach(async () => {
  process.exitCode = undefined;
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
function capture() {
  const stream = new PassThrough();
  let text = "";
  stream.on("data", (chunk) => (text += String(chunk)));
  return { stream, text: () => text };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "review-mesh-recover-cli-"));
  roots.push(root);
  const runId = "run-recovery",
    runsDirectory = join(root, "runs"),
    path = join(runsDirectory, `${runId}.jsonl`),
    backup = join(root, "details.jsonl");
  const writer = await createRunArtifact({ path, runId, toolVersion: "9.0.0" });
  await writer.record({
    record: "context",
    context: { review_scope: { mode: "full", source: "request" } },
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
  await copyFile(path, backup);
  await indexRunArtifact({ runsDirectory, runId, artifact: reference });
  await observePublicStream({
    runsDirectory,
    runId,
    outcome: "references_only",
  });
  await rm(path);
  const appPaths = {
    runsDirectory,
    configFile: join(root, "config.toml"),
    reviewersDirectory: join(root, "reviewers"),
  };
  async function command(argv: string[]) {
    const output = capture(),
      error = capture();
    await runCli(new EventEmitter(), {
      argv,
      appPaths,
      cwd: root,
      output: output.stream,
      error: error.stream,
    });
    return {
      output: output.text(),
      error: error.text(),
      code: process.exitCode,
    };
  }
  return { root, runId, path, backup, reference, command };
}
it.each([
  ["status", "--json"],
  ["report", "--format", "json"],
  ["findings", "--json"],
])(
  "reports native missing-artifact details for %j",
  async (command, ...flags) => {
    const f = await fixture();
    const result = await f.command([command!, f.runId, ...flags]);
    expect(result.code).toBe(2);
    expect(JSON.parse(result.error)).toMatchObject({
      error: "artifact_unavailable",
      native_error_code: "ENOENT",
      path: f.path,
      run_id: f.runId,
      recovery_command: expect.stringContaining("recover"),
    });
    expect(result.error).not.toContain("stack");
  },
);
it("recovers an orphan index from the exact details copy and reads the completed report", async () => {
  const f = await fixture(),
    original = await readFile(f.backup);
  const recovered = await f.command([
    "recover",
    f.runId,
    "--artifact",
    "details.jsonl",
  ]);
  expect(recovered.error).toBe("");
  expect(recovered.code).toBe(0);
  expect(JSON.parse(recovered.output)).toMatchObject({
    kind: "review-mesh.artifact-recovery",
    run_id: f.runId,
    status: "recovered",
    caller_owned: true,
  });
  const status = await f.command(["status", f.runId, "--json"]);
  expect(status.error).toBe("");
  expect(JSON.parse(status.output)).toMatchObject({
    terminal: true,
    run_outcome: "clear",
    artifact: { sha256: f.reference.sha256, path: f.backup },
  });
  const report = await f.command(["report", f.runId, "--format", "json"]);
  expect(report.error).toBe("");
  expect(JSON.parse(report.output)).toMatchObject({
    run_id: f.runId,
    run_outcome: "clear",
  });
  expect(await readFile(f.backup)).toEqual(original);
});
