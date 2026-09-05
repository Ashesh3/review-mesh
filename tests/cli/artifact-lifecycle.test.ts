import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it } from "vitest";
import { runReviewApplication } from "../../src/app.js";
import { AdapterRegistry } from "../../src/adapters/registry.js";
import { readRunStatus } from "../../src/diagnostics/run-status.js";
import { resolveRunArtifact } from "../../src/diagnostics/run-index.js";
import { listV9Runs } from "../../src/diagnostics/v9-views.js";
import { readRunArtifact } from "../../src/diagnostics/run-artifact.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture(
  options: { persist?: boolean; sabotageIndex?: boolean } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "mesh-lifecycle-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  const runsDirectory = join(root, "runs");
  const details = join(root, "details.jsonl");
  await mkdir(workspace);
  const configFile = join(root, "config.toml");
  await writeFile(
    configFile,
    `schema_version = "7"
[execution]
max_concurrency = 1
heartbeat_interval_ms = 1000
shutdown_grace_period_ms = 1000
deadline_mode = "adaptive"
no_progress_timeout_ms = 1000
[diagnostics]
persist_runs = ${options.persist !== false}
max_runs = 10
[adapters.test]
type = "command"
command = "unused"
protocol = "review-mesh-command-v2"
[agents.test]
adapter = "test"
model = "fixture"
purpose = "Review"
instructions = "Review"
isolation = "prefer_enforced"
timeout_ms = 10000
kind = "generic"
required_input = []
adjudication = "off"
[agents.test.applicability]
mode = "always"
[agents.test.change_coverage]
relevant_paths = ["**"]
minimum_inspection = "full_file"
proof = "attested"
[defaults]
agents = ["test"]
`,
  );
  let activeSeen = false;
  const registry = new AdapterRegistry();
  registry.register("command", () => ({
    id: "test",
    async probe() {
      return {
        available: true,
        authenticated: true,
        model_available: true,
        streaming: false,
        cancellation: true,
        maximumIsolation: "runtime_read_only",
        observed_file_access: false,
        progress_observable: false,
      };
    },
    async *run() {
      expect(await readdir(runsDirectory)).toContain(
        "run-lifecycle.jsonl.active",
      );
      expect(await readdir(runsDirectory)).not.toContain("run-lifecycle.jsonl");
      expect(await listV9Runs(runsDirectory)).toContain("run-lifecycle");
      expect(
        await readRunStatus({ runsDirectory, runId: "run-lifecycle" }),
      ).toMatchObject({ active: true, terminal: false });
      activeSeen = true;
      if (options.sabotageIndex)
        await writeFile(
          join(runsDirectory, "run-lifecycle.index.json"),
          "foreign index\n",
        );
      yield {
        type: "result",
        isolation: "runtime_read_only",
        result: {
          schema_version: "4",
          verdict: "pass",
          summary: "Finished",
          review_markdown: "Keep expensive review",
          actionable_findings: [],
          informational_notes: [],
        },
      };
    },
  }));
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let events = "",
    diagnostics = "";
  stdout.on("data", (chunk) => {
    events += chunk.toString();
  });
  stderr.on("data", (chunk) => {
    diagnostics += chunk.toString();
  });
  const code = await runReviewApplication({
    requestText: JSON.stringify({
      schema_version: "3",
      workspace,
      project_name: "workspace",
      instructions: "Review",
      review_scope: { mode: "full" },
    }),
    configFile,
    appPaths: {
      configFile,
      reviewersDirectory: join(root, "reviewers"),
      runsDirectory,
    },
    detailsFile: details,
    stdout,
    stderr,
    signal: new AbortController().signal,
    adapterRegistry: registry,
    runIdFactory: () => "run-lifecycle",
  });
  return {
    root,
    runsDirectory,
    details,
    code,
    events,
    diagnostics,
    activeSeen,
  };
}

it("discovers protected active runs and retains details as an indexed identical backup", async () => {
  const result = await fixture();
  expect(result.activeSeen, result.diagnostics || result.events).toBe(true);
  expect(result.code, result.diagnostics).toBe(0);
  const index = JSON.parse(
    await readFile(
      join(result.runsDirectory, "run-lifecycle.index.json"),
      "utf8",
    ),
  );
  expect(index.alternatives).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        artifact: expect.objectContaining({ path: result.details }),
      }),
    ]),
  );
  await rm(join(result.runsDirectory, "run-lifecycle.jsonl"));
  const resolved = await resolveRunArtifact("run-lifecycle", {
    runsDirectory: result.runsDirectory,
  });
  expect(
    (await readRunArtifact(resolved.artifact.path)).results[0]?.result
      .review_markdown,
  ).toBe("Keep expensive review");
});

it("wipes owned staging copies only after durable caller-only publication succeeds", async () => {
  const result = await fixture({ persist: false });
  expect(result.code, result.diagnostics).toBe(0);
  expect(await readRunArtifact(result.details)).toMatchObject({
    active: false,
  });
  expect(
    await readFile(
      join(result.runsDirectory, "run-lifecycle.jsonl.active"),
      "utf8",
    ),
  ).toBe("");
  await expect(
    readFile(join(result.runsDirectory, "run-lifecycle.jsonl")),
  ).rejects.toMatchObject({ code: "ENOENT" });
  const recoveryFiles = await readdir(join(result.runsDirectory, ".recovery"));
  expect(recoveryFiles).toHaveLength(1);
  expect(
    await readFile(
      join(result.runsDirectory, ".recovery", recoveryFiles[0]!),
      "utf8",
    ),
  ).toBe("");
  const index = JSON.parse(
    await readFile(
      join(result.runsDirectory, "run-lifecycle.index.json"),
      "utf8",
    ),
  );
  expect(index).toMatchObject({
    artifact: { path: result.details },
    artifact_ownership: "caller",
    alternatives: [],
  });
});

it.each([true, false])(
  "keeps recovery bytes and caller details when index publication fails (persist=%s)",
  async (persist) => {
    const result = await fixture({ persist, sabotageIndex: true });
    expect(result.activeSeen, result.diagnostics || result.events).toBe(true);
    expect(result.code).toBe(3);
    expect(result.events).not.toContain('"event":"run.completed"');
    expect(await readRunArtifact(result.details)).toMatchObject({
      active: false,
      results: [expect.objectContaining({ reviewer_id: "test" })],
    });
    const diagnostic = JSON.parse(result.diagnostics.trim());
    expect(diagnostic.details).toMatchObject({
      stage: "artifact_index_publication",
      recovery_artifact: expect.objectContaining({ completed_results: 1 }),
    });
    const events = result.events
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.at(-1)).toMatchObject({
      event: "run.persistence_failed",
      data: {
        terminal: true,
        exit_code: 3,
        stage: "artifact_index_publication",
        recovery_artifact: diagnostic.details.recovery_artifact,
      },
    });
    expect(
      await readRunArtifact(diagnostic.details.recovery_artifact.path),
    ).toMatchObject({ active: false });
    expect(
      await readFile(
        join(result.runsDirectory, "run-lifecycle.index.json"),
        "utf8",
      ),
    ).toBe("foreign index\n");
  },
);
