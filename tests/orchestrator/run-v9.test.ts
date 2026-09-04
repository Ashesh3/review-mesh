import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runV9Review } from "../../src/orchestrator/run-v9.js";
import { AdapterRegistry } from "../../src/adapters/registry.js";
import { roundInput, resolvedContext } from "../helpers/fixtures.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

describe("v9 run orchestration", () => {
  it("does not count an unread changed-file pass as clean coverage", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "review-mesh-v9-run-"));
    roots.push(workspace);
    await writeFile(join(workspace, "worker.ts"), "hello\n");
    const config = roundInput().config;
    config.reviewers = config.reviewers.slice(0, 1);
    config.reviewers[0]!.policy = {
      ...config.reviewers[0]!.policy!,
      applicability: { mode: "always" },
      passQuorum: 1,
      minimumProviderGroups: 1,
      adjudication: "off",
      gateMinimumSeverity: "medium",
      gateMinimumConfidence: "medium",
      changeCoverage: {
        relevantPaths: ["**"],
        minimumInspection: "full_file",
        proof: "observed",
      },
    };
    const context = resolvedContext({
      workspace,
      git: {
        is_repository: true,
        root: workspace,
        branch: "feature",
        head: "a",
        merge_base: "b",
        changed_files: ["worker.ts"],
        changed_paths: [{ path: "worker.ts", kind: "untracked" }],
        status_entries: [],
        diff: "",
        diff_stat: "",
        raw_diff: {
          byte_count: 0,
          sha256:
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        },
        shallow: false,
        truncated: {
          changed_files: false,
          diff: false,
          diff_stat: false,
          status_entries: false,
        },
      },
    });
    const registry = new AdapterRegistry();
    registry.register(config.reviewers[0]!.adapter.type, () => ({
      id: "test",
      async probe() {
        return {
          available: true,
          authenticated: true,
          model_available: true,
          streaming: true,
          cancellation: true,
          maximumIsolation: "runtime_read_only",
          observed_file_access: true,
          progress_observable: true,
        };
      },
      async *run() {
        yield {
          type: "result" as const,
          isolation: "runtime_read_only" as const,
          result: {
            schema_version: "4" as const,
            verdict: "pass" as const,
            summary: "I could not read the file",
            review_markdown: "File unavailable",
            actionable_findings: [],
            informational_notes: [],
          },
        };
      },
    }));
    const events: unknown[] = [],
      records: unknown[] = [],
      results: unknown[] = [];
    const completion = await runV9Review({
      runId: "run-1",
      config,
      context,
      registry,
      signal: new AbortController().signal,
      writer: {
        emit: async (event) => {
          events.push(event);
        },
        finish: async (summary) => {
          events.push(summary);
          return {
            path: "/artifact",
            sha256: "a".repeat(64),
            byte_count: 1,
            completed_results: 1,
          };
        },
        outputFailed: () => false,
        close: async () => undefined,
      },
      record: async (record) => {
        records.push(record);
      },
      recordResult: async (_id, result) => {
        results.push(result);
      },
    });
    expect(completion).toMatchObject({
      runOutcome: "inconclusive",
      coverageOutcome: "partial",
      exitCode: 3,
    });
    expect(results).toHaveLength(1);
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          record: "reviewer.terminal",
          data: expect.objectContaining({
            reason: "change_coverage_incomplete",
          }),
        }),
      ]),
    );
  });

  it("falls back after retaining a valid result with incomplete change coverage", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "review-mesh-v9-run-"));
    roots.push(workspace);
    await writeFile(join(workspace, "worker.ts"), "hello\n");
    const base = roundInput();
    const first = structuredClone(base.config.reviewers[0]!);
    const second = structuredClone(base.config.reviewers[0]!);
    first.id = "lens::first";
    first.agentId = "lens";
    first.adapterId = "first";
    first.adapter = {
      type: "command",
      command: "first",
      protocol: "review-mesh-command-v1",
    };
    second.id = "lens::fallback";
    second.agentId = "lens";
    second.adapterId = "fallback";
    second.adapter = {
      type: "command",
      command: "fallback",
      protocol: "review-mesh-command-v1",
    };
    for (const reviewer of [first, second]) {
      reviewer.policy = {
        applicability: { mode: "always" },
        requiredCallerContext: [],
        passQuorum: 1,
        minimumProviderGroups: 1,
        adjudication: "off",
        gateMinimumSeverity: "medium",
        gateMinimumConfidence: "medium",
        changeCoverage: {
          relevantPaths: ["**"],
          minimumInspection: "full_file",
          proof: "observed",
        },
      };
    }
    const config = base.config;
    config.reviewers = [first, second];
    const context = resolvedContext({
      workspace,
      git: {
        is_repository: true,
        root: workspace,
        branch: "feature",
        head: "a",
        merge_base: "b",
        changed_files: ["worker.ts"],
        changed_paths: [{ path: "worker.ts", kind: "untracked" }],
        status_entries: [],
        diff: "",
        diff_stat: "",
        raw_diff: {
          byte_count: 0,
          sha256:
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        },
        shallow: false,
        truncated: {
          changed_files: false,
          diff: false,
          diff_stat: false,
          status_entries: false,
        },
      },
    });
    const registry = new AdapterRegistry();
    let firstCalls = 0;
    let fallbackCalls = 0;
    const result = {
      schema_version: "4" as const,
      verdict: "pass" as const,
      summary: "No findings",
      review_markdown: "No findings",
      actionable_findings: [],
      informational_notes: [],
    };
    registry.register("command", (registration) => ({
      id: registration.type === "command" ? registration.command : "unknown",
      async probe() {
        return {
          available: true,
          authenticated: true,
          model_available: true,
          streaming: true,
          cancellation: true,
          maximumIsolation: "runtime_read_only",
          observed_file_access: true,
          progress_observable: true,
        };
      },
      async *run(input) {
        if (
          registration.type === "command" &&
          registration.command === "first"
        ) {
          firstCalls += 1;
        } else {
          fallbackCalls += 1;
          const read = await input.coverage!.readFile({ path: "worker.ts" });
          if (read.ok) read.acknowledgeDelivered();
          input.coverage!.recordDiffDelivery(
            ["worker.ts"],
            context.git.is_repository
              ? {
                  byteCount: context.git.raw_diff!.byte_count,
                  sha256: context.git.raw_diff!.sha256,
                }
              : { byteCount: 0, sha256: "" },
          );
        }
        yield {
          type: "result" as const,
          isolation: "runtime_read_only" as const,
          result,
        };
      },
    }));
    const stored: unknown[] = [];
    const completion = await runV9Review({
      runId: "run-fallback",
      config,
      context,
      registry,
      signal: new AbortController().signal,
      writer: {
        emit: async () => undefined,
        finish: async () => ({
          path: "/artifact",
          sha256: "a".repeat(64),
          byte_count: 1,
          completed_results: stored.length,
        }),
        outputFailed: () => false,
        close: async () => undefined,
      },
      record: async () => undefined,
      recordResult: async (_id, value) => {
        stored.push(value);
      },
    });
    expect(firstCalls).toBe(1);
    expect(fallbackCalls).toBe(1);
    expect(stored).toHaveLength(2);
    expect(completion).toMatchObject({
      runOutcome: "clear",
      coverageOutcome: "complete",
      exitCode: 0,
    });
  });

  it("probes readiness once before retrying an admitted provider attempt", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "review-mesh-v9-run-"));
    roots.push(workspace);
    const base = roundInput();
    base.config.execution.retry_attempts = 2;
    base.config.execution.retry_backoff_ms = 0;
    base.config.reviewers = base.config.reviewers.slice(0, 1);
    base.config.reviewers[0]!.policy = {
      applicability: { mode: "always" },
      requiredCallerContext: [],
      passQuorum: 1,
      minimumProviderGroups: 1,
      adjudication: "off",
      gateMinimumSeverity: "medium",
      gateMinimumConfidence: "medium",
      changeCoverage: {
        relevantPaths: ["**"],
        minimumInspection: "diff",
        proof: "observed",
      },
    };
    let probes = 0;
    let attempts = 0;
    const registry = new AdapterRegistry();
    registry.register("command", () => ({
      id: "retry",
      async probe() {
        probes += 1;
        return {
          available: true,
          authenticated: true,
          model_available: true,
          streaming: true,
          cancellation: true,
          maximumIsolation: "runtime_read_only",
          observed_file_access: true,
          progress_observable: false,
        };
      },
      async *run() {
        attempts += 1;
        if (attempts === 1) {
          yield {
            type: "failure" as const,
            failure: {
              reason: "adapter_unavailable" as const,
              message: "temporary outage",
              retryable: true,
              fallback_eligible: true,
              circuit_qualifying: true,
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
            summary: "done",
            review_markdown: "done",
            actionable_findings: [],
            informational_notes: [],
          },
        };
      },
    }));
    const completion = await runV9Review({
      runId: "retry-probe",
      config: base.config,
      context: resolvedContext({
        workspace,
        review_scope: { mode: "full", source: "request" },
      }),
      registry,
      signal: new AbortController().signal,
      writer: {
        emit: async () => undefined,
        finish: async () => ({
          path: "/artifact",
          sha256: "a".repeat(64),
          byte_count: 1,
          completed_results: 1,
        }),
        outputFailed: () => false,
        close: async () => undefined,
      },
      record: async () => undefined,
      recordResult: async () => undefined,
    });
    expect(probes).toBe(1);
    expect(attempts).toBe(2);
    expect(completion.exitCode).toBe(0);
  });

  it("preserves the provider circuit breaker across queued logical lenses", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "review-mesh-v9-run-"));
    roots.push(workspace);
    const base = roundInput();
    base.config.execution.max_concurrency = 1;
    base.config.execution.retry_attempts = 1;
    base.config.execution.circuit_breaker_threshold = 1;
    base.config.reviewers = ["first", "second"].map((id) => ({
      ...structuredClone(base.config.reviewers[0]!),
      id,
      agentId: id,
      providerGroup: "shared",
      policy: {
        applicability: { mode: "always" as const },
        requiredCallerContext: [],
        passQuorum: 1,
        minimumProviderGroups: 1,
        adjudication: "off" as const,
        gateMinimumSeverity: "medium" as const,
        gateMinimumConfidence: "medium" as const,
        changeCoverage: {
          relevantPaths: ["**"],
          minimumInspection: "diff" as const,
          proof: "observed" as const,
        },
      },
    }));
    let providerCalls = 0;
    const registry = new AdapterRegistry();
    registry.register("command", () => ({
      id: "circuit",
      async probe() {
        return {
          available: true,
          authenticated: true,
          model_available: true,
          streaming: true,
          cancellation: true,
          maximumIsolation: "runtime_read_only",
          observed_file_access: true,
          progress_observable: false,
        };
      },
      async *run() {
        providerCalls += 1;
        yield {
          type: "failure" as const,
          failure: {
            reason: "adapter_unavailable" as const,
            message: "provider outage",
            retryable: true,
            fallback_eligible: true,
            circuit_qualifying: true,
            diagnostics: { scope: "provider" as const },
          },
        };
      },
    }));
    const records: Array<Record<string, unknown>> = [];
    await runV9Review({
      runId: "circuit",
      config: base.config,
      context: resolvedContext({
        workspace,
        review_scope: { mode: "full", source: "request" },
      }),
      registry,
      signal: new AbortController().signal,
      writer: {
        emit: async () => undefined,
        finish: async () => ({
          path: "/artifact",
          sha256: "a".repeat(64),
          byte_count: 1,
          completed_results: 0,
        }),
        outputFailed: () => false,
        close: async () => undefined,
      },
      record: async (record) => {
        records.push(record);
      },
      recordResult: async () => undefined,
    });
    expect(providerCalls).toBe(1);
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reviewer_id: "second",
          data: expect.objectContaining({
            failure: expect.objectContaining({
              diagnostics: expect.objectContaining({
                retry_blocked_by_circuit: true,
              }),
            }),
          }),
        }),
      ]),
    );
  });

  it("stops a logical chain when a failure is not fallback eligible", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "review-mesh-v9-run-"));
    roots.push(workspace);
    const base = roundInput();
    const reviewers = ["first", "second"].map((id) => ({
      ...structuredClone(base.config.reviewers[0]!),
      id,
      agentId: "same-lens",
      adapterId: id,
      adapter: {
        type: "command" as const,
        command: id,
        protocol: "review-mesh-command-v1" as const,
      },
      policy: {
        applicability: { mode: "always" as const },
        requiredCallerContext: [],
        passQuorum: 1,
        minimumProviderGroups: 1,
        adjudication: "off" as const,
        gateMinimumSeverity: "medium" as const,
        gateMinimumConfidence: "medium" as const,
        changeCoverage: {
          relevantPaths: ["**"],
          minimumInspection: "diff" as const,
          proof: "observed" as const,
        },
      },
    }));
    base.config.reviewers = reviewers;
    let secondCalls = 0;
    const registry = new AdapterRegistry();
    registry.register("command", (registration) => ({
      id: registration.type === "command" ? registration.command : "test",
      async probe() {
        return {
          available: true,
          authenticated: true,
          model_available: true,
          streaming: true,
          cancellation: true,
          maximumIsolation: "runtime_read_only",
          observed_file_access: true,
          progress_observable: false,
        };
      },
      async *run() {
        if (
          registration.type === "command" &&
          registration.command === "second"
        )
          secondCalls += 1;
        yield {
          type: "failure" as const,
          failure: {
            reason: "read_failure" as const,
            message: "workspace unavailable",
            retryable: false,
            fallback_eligible: false,
            circuit_qualifying: false,
          },
        };
      },
    }));
    const records: Array<Record<string, unknown>> = [];
    await runV9Review({
      runId: "no-fallback",
      config: base.config,
      context: resolvedContext({
        workspace,
        review_scope: { mode: "full", source: "request" },
      }),
      registry,
      signal: new AbortController().signal,
      writer: {
        emit: async () => undefined,
        finish: async () => ({
          path: "/artifact",
          sha256: "a".repeat(64),
          byte_count: 1,
          completed_results: 0,
        }),
        outputFailed: () => false,
        close: async () => undefined,
      },
      record: async (record) => {
        records.push(record);
      },
      recordResult: async () => undefined,
    });
    expect(secondCalls).toBe(0);
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          record: "reviewer.terminal",
          reviewer_id: "second",
          data: expect.objectContaining({
            status: "skipped",
            reason: "blocked_by_infrastructure_failure",
          }),
        }),
      ]),
    );
  });

  it("persists exact accepted result pages before acknowledging adapter storage", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "review-mesh-v9-run-"));
    roots.push(workspace);
    const base = roundInput();
    base.config.reviewers = base.config.reviewers.slice(0, 1);
    base.config.reviewers[0]!.policy = {
      applicability: { mode: "always" },
      requiredCallerContext: [],
      passQuorum: 1,
      minimumProviderGroups: 1,
      adjudication: "off",
      gateMinimumSeverity: "medium",
      gateMinimumConfidence: "medium",
      changeCoverage: {
        relevantPaths: ["**"],
        minimumInspection: "diff",
        proof: "observed",
      },
    };
    const order: string[] = [];
    const registry = new AdapterRegistry();
    registry.register("command", () => ({
      id: "pages",
      async probe() {
        return {
          available: true,
          authenticated: true,
          model_available: true,
          streaming: true,
          cancellation: true,
          maximumIsolation: "runtime_read_only",
          observed_file_access: true,
          progress_observable: false,
        };
      },
      async *run() {
        yield {
          type: "result" as const,
          isolation: "runtime_read_only" as const,
          result: {
            schema_version: "4" as const,
            verdict: "pass" as const,
            summary: "done",
            review_markdown: "done",
            actionable_findings: [],
            informational_notes: [],
          },
          resultStorage: {
            async *pages() {
              yield { raw: '{"page":0}', sha256: "a".repeat(64) };
              yield { raw: '{"page":1}', sha256: "b".repeat(64) };
            },
            persisted() {
              order.push("persisted");
            },
            abandoned() {
              order.push("abandoned");
            },
          },
        };
      },
    }));
    const records: Array<Record<string, unknown>> = [];
    await runV9Review({
      runId: "pages",
      config: base.config,
      context: resolvedContext({
        workspace,
        review_scope: { mode: "full", source: "request" },
      }),
      registry,
      signal: new AbortController().signal,
      writer: {
        emit: async () => undefined,
        finish: async () => ({
          path: "/artifact",
          sha256: "c".repeat(64),
          byte_count: 1,
          completed_results: 1,
        }),
        outputFailed: () => false,
        close: async () => undefined,
      },
      record: async (record) => {
        records.push(record);
        if (record.record === "reviewer.result_page") order.push("page");
      },
      recordResult: async () => undefined,
    });
    expect(order).toEqual(["page", "page", "persisted"]);
    expect(
      records
        .filter((record) => record.record === "reviewer.result_page")
        .map((record) => record.data),
    ).toEqual([
      { index: 0, raw: '{"page":0}', sha256: "a".repeat(64) },
      { index: 1, raw: '{"page":1}', sha256: "b".repeat(64) },
    ]);
  });

  it("keeps suite heartbeats running until terminal finalization completes", async () => {
    vi.useFakeTimers();
    try {
      const workspace = await mkdtemp(join(tmpdir(), "review-mesh-v9-run-"));
      roots.push(workspace);
      const base = roundInput();
      base.config.execution.heartbeat_interval_ms = 1_000;
      base.config.reviewers = base.config.reviewers.slice(0, 1);
      base.config.reviewers[0]!.policy = {
        applicability: { mode: "always" },
        requiredCallerContext: [],
        passQuorum: 1,
        minimumProviderGroups: 1,
        adjudication: "off",
        gateMinimumSeverity: "medium",
        gateMinimumConfidence: "medium",
        changeCoverage: {
          relevantPaths: ["**"],
          minimumInspection: "diff",
          proof: "observed",
        },
      };
      const registry = new AdapterRegistry();
      registry.register("command", () => ({
        id: "test",
        async probe() {
          return {
            available: true,
            authenticated: true,
            model_available: true,
            streaming: true,
            cancellation: true,
            maximumIsolation: "runtime_read_only",
            observed_file_access: true,
            progress_observable: true,
          };
        },
        async *run() {
          yield {
            type: "result" as const,
            isolation: "runtime_read_only" as const,
            result: {
              schema_version: "4" as const,
              verdict: "pass" as const,
              summary: "done",
              review_markdown: "done",
              actionable_findings: [],
              informational_notes: [],
            },
          };
        },
      }));
      const events: Array<{ event?: string }> = [];
      let finishStarted = false;
      let releaseFinalize!: () => void;
      const finalizing = new Promise<void>((resolve) => {
        releaseFinalize = resolve;
      });
      const run = runV9Review({
        runId: "run-heartbeat",
        config: base.config,
        context: resolvedContext({
          workspace,
          review_scope: { mode: "full", source: "request" },
        }),
        registry,
        signal: new AbortController().signal,
        writer: {
          emit: async (event) => {
            events.push(event);
          },
          finish: async () => {
            finishStarted = true;
            await finalizing;
            return {
              path: "/artifact",
              sha256: "a".repeat(64),
              byte_count: 1,
              completed_results: 1,
            };
          },
          outputFailed: () => false,
          close: async () => undefined,
        },
        record: async () => undefined,
        recordResult: async () => undefined,
        now: () => Date.now(),
      });
      for (let index = 0; index < 100 && !finishStarted; index += 1) {
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(10);
      }
      expect(finishStarted).toBe(true);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(
        events.filter((event) => event.event === "suite.heartbeat"),
      ).toHaveLength(2);
      releaseFinalize();
      await run;
    } finally {
      vi.useRealTimers();
    }
  });
});
