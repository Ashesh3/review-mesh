import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it } from "vitest";
import { AdapterRegistry } from "../../src/adapters/registry.js";
import type { AdapterReviewInput } from "../../src/adapters/types.js";
import { runV9Application } from "../../src/app-v9.js";
import { runCli } from "../../src/cli.js";
import { readNormalizedRun } from "../../src/diagnostics/normalize-run.js";
import { resolveRunArtifact } from "../../src/diagnostics/run-index.js";
import { readRunStatus } from "../../src/diagnostics/run-status.js";

const roots: string[] = [];
afterEach(async () => {
  process.exitCode = undefined;
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

function capture() {
  const stream = new PassThrough();
  let text = "";
  stream.on("data", (chunk) => {
    text += String(chunk);
  });
  return {
    stream,
    text: () => text,
    json: () =>
      text
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
  };
}

it.each(["cancel", "pause"] as const)(
  "CLI %s finalizes the live application and resume reuses a completed compatible model",
  async (action) => {
    const root = await mkdtemp(
      join(tmpdir(), "review-mesh-control-integration-"),
    );
    roots.push(root);
    const workspace = join(root, "project");
    await mkdir(workspace);
    await writeFile(join(workspace, "source.txt"), "stable review evidence\n");
    const configFile = join(root, "config.toml");
    await writeFile(
      configFile,
      `schema_version = "7"
[execution]
max_concurrency = 1
heartbeat_interval_ms = 1000
shutdown_grace_period_ms = 1000
deadline_mode = "adaptive"
no_progress_timeout_ms = 10000
distribute_primaries = false
[diagnostics]
persist_runs = true
max_runs = 10
[adapters.test]
type = "command"
command = "fixture"
protocol = "review-mesh-command-v2"
[agents.test]
adapter = "test"
purpose = "Review"
instructions = "Review the supplied evidence"
isolation = "prefer_enforced"
timeout_ms = 30000
kind = "generic"
required_input = []
adjudication = "off"
pass_quorum = 2
minimum_provider_groups = 1
[[agents.test.model_runs]]
id = "first"
model = "completed-model"
[[agents.test.model_runs]]
id = "second"
model = "unfinished-model"
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
    const appPaths = {
      configFile,
      reviewersDirectory: join(root, "reviewers"),
      runsDirectory: join(root, "runs"),
    };
    const parentRunId = `control-parent-${action}`;
    const childRunId = `control-child-${action}`;
    const calls: Array<{ runId: string; reviewerId: string }> = [];
    let admitted!: () => void;
    const secondAdmitted = new Promise<void>((resolve) => {
      admitted = resolve;
    });
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
          maximumIsolation: "runtime_read_only" as const,
          observed_file_access: false,
          progress_observable: false,
        };
      },
      async *run(input: AdapterReviewInput) {
        calls.push({ runId: input.runId, reviewerId: input.reviewer.id });
        if (
          input.runId === parentRunId &&
          input.reviewer.id === "test::second"
        ) {
          admitted();
          await new Promise<void>((resolve) => {
            if (input.signal.aborted) resolve();
            else
              input.signal.addEventListener("abort", () => resolve(), {
                once: true,
              });
          });
          yield {
            type: "failure" as const,
            isolation: "runtime_read_only" as const,
            failure: {
              reason: "cancelled" as const,
              message: "Cooperative abort received.",
              retryable: false,
            },
          };
          return;
        }
        yield {
          type: "result" as const,
          isolation: "runtime_read_only" as const,
          result: {
            schema_version: "4" as const,
            verdict: "pass" as const,
            review_markdown: `Completed ${input.reviewer.id}`,
            summary: "Complete",
            actionable_findings: [],
            informational_notes: [],
          },
        };
      },
    }));
    const parentOutput = capture(),
      parentError = capture();
    const emergency = new AbortController();
    const parent = runV9Application({
      requestText: JSON.stringify({
        schema_version: "3",
        project_name: "project",
        workspace,
        instructions: "Review",
        review_scope: { mode: "full" },
      }),
      configFile,
      appPaths,
      adapterRegistry: registry,
      stdout: parentOutput.stream,
      stderr: parentError.stream,
      signal: emergency.signal,
      runIdFactory: () => parentRunId,
    });
    try {
      await secondAdmitted;
      expect(calls).toEqual([
        { runId: parentRunId, reviewerId: "test::first" },
        { runId: parentRunId, reviewerId: "test::second" },
      ]);
      const cancelOutput = capture(),
        cancelError = capture();
      await runCli(new EventEmitter(), {
        argv: [action, parentRunId],
        appPaths,
        output: cancelOutput.stream,
        error: cancelError.stream,
      });
      expect(cancelError.text()).toBe("");
      expect(cancelOutput.json()).toEqual([
        expect.objectContaining({
          run_id: parentRunId,
          action,
          status: "requested",
        }),
      ]);
      expect(await parent).toBe(4);
      expect(parentError.text()).toBe("");
      expect(parentOutput.json().at(-1)).toMatchObject({
        event: "run.completed",
        data: { run_outcome: "cancelled", exit_code: 4 },
      });
      expect(
        await readRunStatus({
          runsDirectory: appPaths.runsDirectory,
          runId: parentRunId,
        }),
      ).toMatchObject({
        terminal: true,
        active: false,
        run_outcome: "cancelled",
        exit_code: 4,
      });
      const parentArtifact = await resolveRunArtifact(parentRunId, {
        runsDirectory: appPaths.runsDirectory,
      });
      const parentRun = await readNormalizedRun(parentArtifact.artifact.path, {
        expectedSha256: parentArtifact.artifact.sha256,
        expectedIdentity: parentArtifact.expected_identity,
      });
      expect(parentRun.reviewers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            reviewer_id: "test::first",
            status: "completed",
          }),
          expect.objectContaining({
            reviewer_id: "test::second",
            status: "incomplete",
            reason: "cancelled",
          }),
        ]),
      );

      const resumeOutput = capture(),
        resumeError = capture();
      await runCli(new EventEmitter(), {
        argv: ["resume", parentRunId],
        appPaths,
        adapterRegistry: registry,
        output: resumeOutput.stream,
        error: resumeError.stream,
        runReview: (options) =>
          runV9Application({
            ...options,
            configFile,
            runIdFactory: () => childRunId,
          }),
      });
      expect(resumeError.text()).toBe("");
      expect(process.exitCode).toBe(0);
      expect(calls).toEqual([
        { runId: parentRunId, reviewerId: "test::first" },
        { runId: parentRunId, reviewerId: "test::second" },
        { runId: childRunId, reviewerId: "test::second" },
      ]);
      expect(resumeOutput.json().at(-1)).toMatchObject({
        event: "run.completed",
        data: { run_outcome: "clear", exit_code: 0 },
      });
      const childArtifact = await resolveRunArtifact(childRunId, {
        runsDirectory: appPaths.runsDirectory,
      });
      const childRun = await readNormalizedRun(childArtifact.artifact.path, {
        expectedSha256: childArtifact.artifact.sha256,
        expectedIdentity: childArtifact.expected_identity,
      });
      expect(childRun.reviewers).toHaveLength(2);
      expect(
        childRun.reviewers.every((reviewer) => reviewer.status === "completed"),
      ).toBe(true);
      expect(
        childRun.reviewers.find(
          (reviewer) => reviewer.reviewer_id === "test::first",
        )?.digest,
      ).toBe(
        parentRun.reviewers.find(
          (reviewer) => reviewer.reviewer_id === "test::first",
        )?.digest,
      );
      expect(childRun.resolution).toMatchObject({
        retry: {
          parent_run_id: parentRunId,
          inheritance: "exact",
          evidence: "snapshot_identity_verified",
          reused_reviewer_ids: ["test::first"],
        },
      });
    } finally {
      emergency.abort();
      await parent;
    }
  },
  15000,
);
