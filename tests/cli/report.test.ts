import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdapterRegistry } from "../../src/adapters/registry.js";
import type { AdapterReviewInput } from "../../src/adapters/types.js";
import {
  serializeManagedConfig,
  type ManagedConfig,
} from "../../src/config/manage.js";
import { runCli } from "../../src/cli.js";
import type { ReviewApplicationOptions } from "../../src/app.js";
import { passResult } from "../helpers/fixtures.js";

const roots: string[] = [];

function stream(): PassThrough {
  const value = new PassThrough();
  value.setEncoding("utf8");
  return value;
}

async function output(value: PassThrough): Promise<string> {
  value.end();
  let result = "";
  for await (const chunk of value) result += String(chunk);
  return result;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("report and findings commands", () => {
  it("renders a persisted detailed report and deduplicated findings", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-mesh-report-cli-"));
    roots.push(root);
    const runsDirectory = join(root, "runs");
    await mkdir(runsDirectory);
    const runId = "run-report";
    const records = [
      {
        record: "resolution",
        run_id: runId,
        resolution: {
          reviewers: [
            { id: "security::one", agent_id: "security" },
            { id: "security::two", agent_id: "security" },
          ],
        },
      },
      {
        record: "reviewer.result",
        run_id: runId,
        reviewer_id: "security::one",
        lens_id: "security",
        result: {
          schema_version: "2",
          verdict: "fail",
          summary: "Issue found.",
          actionable_findings: [
            {
              id: "f-1",
              severity: "high",
              title: "Unsafe trust boundary",
              description: "Input crosses a trust boundary.",
              evidence: [{ path: "src/a.ts", detail: "Unvalidated input." }],
              suggested_direction: "Validate it.",
              confidence: "high",
              classification: "confirmed_defect",
              external_assumptions: [],
            },
          ],
          informational_notes: [],
        },
      },
      {
        schema_version: "5",
        event: "run.completed",
        run_id: runId,
        seq: 1,
        timestamp: "2026-09-03T00:00:00.000Z",
        data: {
          gate_outcome: "findings",
          coverage_outcome: "complete",
          exit_code: 1,
          consistency_mode: "live_worktree",
          total_elapsed_ms: 1,
          logical_lenses: {
            total: 1,
            pending: 0,
            findings: 1,
            passed: 0,
            incomplete: 0,
            not_applicable: 0,
            not_evaluated: 0,
            not_selected: 0,
          },
          model_runs: {
            total: 2,
            deferred: 0,
            queued: 0,
            running: 0,
            completed: 1,
            incomplete: 0,
            skipped: 1,
          },
          suite: {
            total: 2,
            deferred: 0,
            queued: 0,
            running: 0,
            completed: 1,
            incomplete: 0,
            skipped: 1,
          },
          report_path: join(runsDirectory, `${runId}.jsonl`),
        },
      },
    ];
    await writeFile(
      join(runsDirectory, `${runId}.jsonl`),
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    );

    const stdout = stream();
    const stderr = stream();
    await runCli(process, {
      argv: ["report", runId, "--format", "markdown"],
      output: stdout,
      error: stderr,
      appPaths: {
        configFile: join(root, "config.toml"),
        reviewersDirectory: join(root, "reviewers"),
        runsDirectory,
      },
    });
    const reportOutput = await output(stdout);
    const reportError = await output(stderr);
    expect(reportError).toBe("");
    expect(reportOutput).toContain("# Review Mesh Report");

    const findingsOutput = stream();
    await runCli(process, {
      argv: ["findings", runId, "--deduplicate", "--json"],
      output: findingsOutput,
      error: stream(),
      appPaths: {
        configFile: join(root, "config.toml"),
        reviewersDirectory: join(root, "reviewers"),
        runsDirectory,
      },
    });
    expect(JSON.parse(await output(findingsOutput))).toMatchObject({
      run_id: runId,
      findings: [{ severity: "high", confidence: "high" }],
    });
  });

  it("keeps strict diagnostics but allows explicit best-effort finding salvage", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-mesh-salvage-cli-"));
    roots.push(root);
    const runsDirectory = join(root, "runs");
    await mkdir(runsDirectory);
    const runId = "run-salvage";
    const validResult = {
      record: "reviewer.result",
      run_id: runId,
      reviewer_id: "security",
      result: {
        schema_version: "2",
        verdict: "fail",
        summary: "Issue found.",
        actionable_findings: [
          {
            id: "f-1",
            severity: "high",
            title: "Unsafe trust boundary",
            description: "Input crosses a trust boundary.",
            evidence: [{ detail: "Unvalidated input." }],
            suggested_direction: "Validate it.",
            confidence: "high",
            classification: "confirmed_defect",
            external_assumptions: [],
          },
        ],
        informational_notes: [],
      },
    };
    await writeFile(
      join(runsDirectory, `${runId}.jsonl`),
      [
        JSON.stringify(validResult),
        JSON.stringify({ record: "future.private", run_id: runId }),
      ].join("\n") + "\n",
    );
    const strictError = stream();
    await runCli(process, {
      argv: ["findings", runId, "--json"],
      output: stream(),
      error: strictError,
      appPaths: {
        configFile: join(root, "config.toml"),
        reviewersDirectory: join(root, "reviewers"),
        runsDirectory,
      },
    });
    expect(JSON.parse(await output(strictError))).toMatchObject({
      error: "invalid_run_record",
      line: 2,
      record_type: "future.private",
      schema_paths: expect.any(Array),
    });

    const salvageOutput = stream();
    await runCli(process, {
      argv: ["findings", runId, "--deduplicate", "--json", "--best-effort"],
      output: salvageOutput,
      error: stream(),
      appPaths: {
        configFile: join(root, "config.toml"),
        reviewersDirectory: join(root, "reviewers"),
        runsDirectory,
      },
    });
    expect(JSON.parse(await output(salvageOutput))).toMatchObject({
      run_id: runId,
      findings: [expect.objectContaining({ id: "f-1" })],
      record_warnings: [
        expect.objectContaining({ line: 2, record_type: "future.private" }),
      ],
    });
  });

  it("retries only persisted incomplete lenses through trusted application options", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-mesh-retry-cli-"));
    roots.push(root);
    const runsDirectory = join(root, "runs");
    await mkdir(runsDirectory);
    const runId = "run-incomplete";
    const request = {
      schema_version: "2",
      project_name: "demo",
      workspace: root,
      instructions: "Review the changes.",
      review_scope: { mode: "changes" },
    };
    const records = [
      {
        record: "resolution",
        run_id: runId,
        resolution: { reviewers: [] },
      },
      { record: "request", run_id: runId, request },
      {
        schema_version: "5",
        event: "run.completed",
        run_id: runId,
        seq: 1,
        timestamp: "2026-09-03T00:00:00.000Z",
        data: {
          gate_outcome: "no_findings",
          coverage_outcome: "partial",
          exit_code: 3,
          consistency_mode: "live_worktree",
          total_elapsed_ms: 1,
          logical_lenses: {
            total: 2,
            pending: 0,
            findings: 0,
            passed: 0,
            incomplete: 2,
            not_applicable: 0,
            not_evaluated: 0,
            not_selected: 0,
          },
          model_runs: {
            total: 2,
            deferred: 0,
            queued: 0,
            running: 0,
            completed: 0,
            incomplete: 2,
            skipped: 0,
          },
          suite: {
            total: 2,
            deferred: 0,
            queued: 0,
            running: 0,
            completed: 0,
            incomplete: 2,
            skipped: 0,
          },
          incomplete_lenses: ["security", "readiness"],
        },
      },
    ];
    await writeFile(
      join(runsDirectory, `${runId}.jsonl`),
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    );

    let invocation: ReviewApplicationOptions | undefined;
    const processLike = Object.assign(new EventEmitter(), { exitCode: 0 });
    const retryError = stream();
    await runCli(processLike, {
      argv: ["retry", runId, "--only-incomplete"],
      output: stream(),
      error: retryError,
      appPaths: {
        configFile: join(root, "config.toml"),
        reviewersDirectory: join(root, "reviewers"),
        runsDirectory,
      },
      runReview: vi.fn(async (options) => {
        invocation = options;
        return 3;
      }),
    });

    expect(await output(retryError)).toBe("");
    expect(invocation).toMatchObject({
      parentRunId: runId,
      onlyLensIds: ["readiness", "security"],
    });
    expect(JSON.parse(invocation!.requestText)).toEqual(request);
    expect(invocation!.requestText).not.toContain("review_mesh_retry");
    expect(process.exitCode).toBe(3);
    process.exitCode = undefined;
  });

  it("uses the real adapter run path, selected effort, tools, and v3 schema for doctor", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-mesh-doctor-cli-"));
    roots.push(root);
    const workspace = join(root, "demo");
    const configFile = join(root, "config.toml");
    await mkdir(workspace);
    const config: ManagedConfig = {
      schema_version: "5",
      execution: {
        max_concurrency: 1,
        heartbeat_interval_ms: 1_000,
        shutdown_grace_period_ms: 100,
      },
      diagnostics: { persist_runs: false, max_runs: 1 },
      adapters: {
        fake: {
          type: "command",
          command: "unused",
          protocol: "review-mesh-command-v1",
        },
      },
      agents: {
        security: {
          adapter: "fake",
          model: "review-model",
          effort: "high",
          purpose: "Security",
          instructions: "Review security.",
          isolation: "prefer_enforced",
          timeout_ms: 1_000,
        },
      },
      defaults: { agents: ["security"] },
      projects: {},
    };
    await writeFile(configFile, serializeManagedConfig(config));

    let runInput: AdapterReviewInput | undefined;
    let sentinel = "";
    const registry = new AdapterRegistry();
    registry.register("command", () => ({
      id: "fake",
      async probe() {
        return {
          available: true,
          authenticated: true,
          model_available: true,
          streaming: true,
          cancellation: true,
          maximumIsolation: "prompt_only",
        };
      },
      async *run(input) {
        runInput = input;
        sentinel = await readFile(
          join(input.context.workspace, "review-mesh-doctor.txt"),
          "utf8",
        );
        yield { type: "progress", phase: "reviewing" };
        yield {
          type: "activity",
          message: "Read review-mesh-doctor.txt with the adapter tool.",
        };
        yield { type: "progress", phase: "validating" };
        yield {
          type: "result",
          result: passResult("Doctor parity."),
          isolation: "prompt_only",
        };
      },
    }));
    const stdout = stream();
    const processLike = Object.assign(new EventEmitter(), { exitCode: 0 });
    await runCli(processLike, {
      argv: ["doctor", workspace, "--structured-output"],
      output: stdout,
      error: stream(),
      configFile,
      cwd: root,
      adapterRegistry: registry,
    });

    expect(runInput?.reviewer).toMatchObject({
      id: "security",
      model: "review-model",
      effort: "high",
    });
    expect(runInput?.context.workspace).not.toBe(await realpath(workspace));
    expect(sentinel).toContain("Review Mesh doctor synthetic workspace");
    expect(
      (runInput?.resultJsonSchema.properties as Record<string, any>)
        .schema_version.const,
    ).toBe("3");
    expect(JSON.parse(await output(stdout))).toEqual({
      schema_version: "1",
      kind: "review-mesh.doctor",
      workspace: await realpath(workspace),
      ready: true,
      reviewers: [
        {
          reviewer_id: "security",
          adapter: "fake",
          model: "review-model",
          provider_group: "fake",
          ready: true,
          checks: [
            { name: "authentication", passed: true },
            { name: "model", passed: true },
            { name: "streaming_negotiation", passed: true },
            { name: "read_tool_execution", passed: true },
            { name: "complete_result_production", passed: true },
            { name: "schema_validation", passed: true },
          ],
        },
      ],
    });
    expect(process.exitCode).toBe(0);
    process.exitCode = undefined;
  });

  it("labels a real run tool-stage failure and retains typed diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-mesh-doctor-tool-"));
    roots.push(root);
    const workspace = join(root, "demo");
    const configFile = join(root, "config.toml");
    await mkdir(workspace);
    const config: ManagedConfig = {
      schema_version: "5",
      execution: {
        max_concurrency: 1,
        heartbeat_interval_ms: 1_000,
        shutdown_grace_period_ms: 100,
      },
      diagnostics: { persist_runs: false, max_runs: 1 },
      adapters: {
        fake: {
          type: "command",
          command: "unused",
          protocol: "review-mesh-command-v1",
        },
      },
      agents: {
        security: {
          adapter: "fake",
          model: "review-model",
          purpose: "Security",
          instructions: "Review security.",
          isolation: "prefer_enforced",
          timeout_ms: 1_000,
        },
      },
      defaults: { agents: ["security"] },
      projects: {},
    };
    await writeFile(configFile, serializeManagedConfig(config));
    const registry = new AdapterRegistry();
    registry.register("command", () => ({
      id: "fake",
      async probe() {
        return {
          available: true,
          authenticated: true,
          model_available: true,
          streaming: true,
          cancellation: true,
          maximumIsolation: "prompt_only",
        };
      },
      async *run() {
        yield {
          type: "failure",
          isolation: "prompt_only",
          failure: {
            reason: "read_failure",
            message: "Synthetic read failed.",
            retryable: false,
            fallback_eligible: false,
            circuit_qualifying: false,
            diagnostics: {
              failure_code: "provider_response_invalid",
              failure_stage: "tool_execution",
              scope: "model",
              http_status: 200,
              provider_request_id: "request-123",
              validation_issues: [
                {
                  path: "$.tool_calls[0]",
                  code: "invalid_tool_call",
                  message: "Tool call was invalid.",
                },
              ],
              attempt_count: 2,
              retry_outcome: "exhausted",
            },
          },
        };
      },
    }));
    const stdout = stream();
    await runCli(process, {
      argv: ["doctor", workspace, "--structured-output"],
      output: stdout,
      error: stream(),
      configFile,
      adapterRegistry: registry,
    });

    const result = JSON.parse(await output(stdout));
    expect(result.ready).toBe(false);
    expect(result.reviewers[0].checks).toContainEqual({
      name: "read_tool_execution",
      passed: false,
      message: "Synthetic read failed.",
      failure: expect.objectContaining({
        reason: "read_failure",
        diagnostics: expect.objectContaining({
          failure_stage: "tool_execution",
          provider_request_id: "request-123",
          attempt_count: 2,
          retry_outcome: "exhausted",
          validation_issues: [
            expect.objectContaining({ path: "$.tool_calls[0]" }),
          ],
        }),
      }),
    });
    expect(result.reviewers[0].checks).not.toContainEqual(
      expect.objectContaining({
        name: "schema_validation",
        message: "Synthetic read failed.",
      }),
    );
    expect(process.exitCode).toBe(3);
    process.exitCode = undefined;
  });

  it("filters doctor by exact adapter and model before creating adapters", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-mesh-doctor-filter-"));
    roots.push(root);
    const workspace = join(root, "demo");
    const configFile = join(root, "config.toml");
    await mkdir(workspace);
    const config: ManagedConfig = {
      schema_version: "5",
      execution: {
        max_concurrency: 1,
        heartbeat_interval_ms: 1_000,
        shutdown_grace_period_ms: 100,
      },
      diagnostics: { persist_runs: false, max_runs: 1 },
      adapters: {
        first: {
          type: "command",
          command: "first",
          protocol: "review-mesh-command-v1",
        },
        second: {
          type: "command",
          command: "second",
          protocol: "review-mesh-command-v1",
        },
      },
      agents: {
        first: {
          adapter: "first",
          model: "shared-model",
          purpose: "First",
          instructions: "First.",
          isolation: "prefer_enforced",
          timeout_ms: 1_000,
        },
        second: {
          adapter: "second",
          model: "shared-model",
          purpose: "Second",
          instructions: "Second.",
          isolation: "prefer_enforced",
          timeout_ms: 1_000,
        },
      },
      defaults: { agents: ["first", "second"] },
      projects: {},
    };
    await writeFile(configFile, serializeManagedConfig(config));

    const created: string[] = [];
    const probed: string[] = [];
    const registry = new AdapterRegistry();
    registry.register("command", (registration) => {
      if (registration.type !== "command") throw new Error("expected command");
      created.push(registration.command);
      return {
        id: registration.command,
        async probe(reviewer) {
          probed.push(reviewer.id);
          return {
            available: true,
            authenticated: true,
            model_available: true,
            streaming: false,
            cancellation: true,
            maximumIsolation: "prompt_only",
          };
        },
        async *run() {
          throw new Error("not used");
        },
      };
    });
    const stdout = stream();
    await runCli(process, {
      argv: [
        "doctor",
        workspace,
        "--adapter",
        "second",
        "--model",
        "shared-model",
      ],
      output: stdout,
      error: stream(),
      configFile,
      adapterRegistry: registry,
    });

    expect(created).toEqual(["second"]);
    expect(probed).toEqual(["second"]);
    expect(JSON.parse(await output(stdout))).toMatchObject({
      ready: true,
      reviewers: [{ reviewer_id: "second", adapter: "second" }],
    });
    process.exitCode = undefined;
  });

  it("fails doctor selection cleanly when no exact reviewer matches", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-mesh-doctor-empty-"));
    roots.push(root);
    const workspace = join(root, "demo");
    const configFile = join(root, "config.toml");
    await mkdir(workspace);
    const config: ManagedConfig = {
      schema_version: "5",
      execution: {
        max_concurrency: 1,
        heartbeat_interval_ms: 1_000,
        shutdown_grace_period_ms: 100,
      },
      diagnostics: { persist_runs: false, max_runs: 1 },
      adapters: {
        fake: {
          type: "command",
          command: "unused",
          protocol: "review-mesh-command-v1",
        },
      },
      agents: {
        security: {
          adapter: "fake",
          model: "review-model",
          purpose: "Security",
          instructions: "Review security.",
          isolation: "prefer_enforced",
          timeout_ms: 1_000,
        },
      },
      defaults: { agents: ["security"] },
      projects: {},
    };
    await writeFile(configFile, serializeManagedConfig(config));
    const error = stream();
    let created = 0;
    const registry = new AdapterRegistry();
    registry.register("command", () => {
      created += 1;
      throw new Error("must not create an unselected adapter");
    });

    await runCli(process, {
      argv: ["doctor", workspace, "--model", "missing-model"],
      output: stream(),
      error,
      configFile,
      adapterRegistry: registry,
    });

    expect(created).toBe(0);
    expect(JSON.parse(await output(error))).toMatchObject({
      kind: "review-mesh.diagnostic",
      error: "doctor_selection_empty",
      retryable: false,
    });
    expect(process.exitCode).toBe(2);
    process.exitCode = undefined;
  });

  it("rejects missing or repeated doctor selector values as usage errors", async () => {
    for (const argv of [
      ["doctor", "--adapter"],
      ["doctor", "--model", "one", "--model", "two"],
    ]) {
      const error = stream();
      await runCli(process, { argv, output: stream(), error });
      expect(JSON.parse(await output(error))).toMatchObject({
        error: "invalid_usage",
        retryable: false,
      });
      process.exitCode = undefined;
    }
  });
});
