import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runV9Review, type V9RunInput } from "../../src/orchestrator/run-v9.js";
import { AdapterRegistry } from "../../src/adapters/registry.js";
import { roundInput, resolvedContext } from "../helpers/fixtures.js";
import type { ReviewerResultV4 } from "../../src/protocol/v9.js";
import type { ReviewAdapter } from "../../src/adapters/types.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function schedulerFixture(
  members: Array<{
    id: string;
    lens: string;
    provider: string;
    timeout?: number;
    attemptTimeout?: number;
    lensDeadline?: number;
    after?: string;
  }>,
  runAdapter: ReviewAdapter["run"],
  options: {
    concurrency?: number;
    runDeadline?: number;
    probe?: ReviewAdapter["probe"];
    passQuorum?: number;
    minimumProviderGroups?: number;
    sourceFiles?: number;
    retry?: V9RunInput["retry"];
  } = {},
) {
  const workspace = await mkdtemp(join(tmpdir(), "review-mesh-v9-scheduler-"));
  roots.push(workspace);
  for (let index = 0; index < (options.sourceFiles ?? 0); index++)
    await writeFile(join(workspace, `source-${index}.ts`), "stable source");
  const base = roundInput();
  base.config.execution.deadline_mode = "fixed";
  base.config.execution.run_deadline_ms = options.runDeadline ?? 10_000;
  base.config.execution.max_concurrency = options.concurrency ?? 2;
  base.config.execution.default_provider_concurrency = 1;
  base.config.execution.provider_limits = {};
  base.config.execution.retry_attempts = 1;
  base.config.reviewers = members.map((member) => ({
    ...structuredClone(base.config.reviewers[0]!),
    id: member.id,
    agentId: member.lens,
    providerGroup: member.provider,
    timeoutMs: member.timeout ?? 8_000,
    attemptTimeoutMs: member.attemptTimeout ?? member.timeout ?? 8_000,
    policy: {
      applicability: { mode: "always" as const },
      requiredCallerContext: [],
      passQuorum: options.passQuorum ?? 1,
      minimumProviderGroups: options.minimumProviderGroups ?? 1,
      adjudication: "off" as const,
      gateMinimumSeverity: "medium" as const,
      gateMinimumConfidence: "medium" as const,
      lensDeadlineMs: member.lensDeadline ?? 10_000,
      changeCoverage: {
        relevantPaths: ["**"],
        minimumInspection: "diff" as const,
        proof: "observed" as const,
      },
    },
  }));
  const admitted = new Map<
    string,
    { promise: Promise<void>; resolve(): void }
  >();
  for (const member of members) {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    admitted.set(member.id, { promise, resolve });
  }
  const registry = new AdapterRegistry();
  registry.register("command", () => ({
    id: "scheduler-fixture",
    probe:
      options.probe ??
      (async (reviewer) => {
        const prerequisite = members.find(
          (member) => member.id === reviewer.id,
        )?.after;
        if (prerequisite !== undefined)
          await admitted.get(prerequisite)!.promise;
        return {
          available: true,
          authenticated: true,
          model_available: true,
          streaming: false,
          cancellation: true,
          maximumIsolation: "runtime_read_only",
          observed_file_access: true,
          progress_observable: false,
        };
      }),
    async *run(input) {
      admitted.get(input.reviewer.id)!.resolve();
      yield* runAdapter(input);
    },
  }));
  const events: Array<{
    event?: string;
    reviewer_id?: string | undefined;
    data?: Record<string, unknown>;
  }> = [];
  const records: Array<Record<string, unknown>> = [];
  const caller = new AbortController();
  const run = runV9Review({
    runId: "scheduler-regression",
    config: base.config,
    context: resolvedContext({
      workspace,
      review_scope: { mode: "full", source: "request" },
    }),
    registry,
    signal: caller.signal,
    writer: {
      emit: async (event) => {
        events.push(event);
      },
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
    now: () => Date.now(),
    ...(options.retry === undefined ? {} : { retry: options.retry }),
  });
  return { run, events, records, caller };
}

const schedulerPass = {
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

async function waitForScheduler(predicate: () => boolean) {
  for (let index = 0; index < 1_000 && !predicate(); index += 1)
    await vi.advanceTimersByTimeAsync(0);
  expect(predicate()).toBe(true);
}

function adapterDelay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    if (signal.aborted) finish();
    else signal.addEventListener("abort", finish, { once: true });
  });
}

describe("v9 run orchestration", () => {
  it("keeps a run snapshot capture alive after its first candidate probe expires", async () => {
    const executed: string[] = [];
    const fixture = await schedulerFixture(
      [
        {
          id: "short",
          lens: "snapshot",
          provider: "first",
          attemptTimeout: 25,
          timeout: 1000,
        },
        {
          id: "fallback",
          lens: "snapshot",
          provider: "second",
          attemptTimeout: 8000,
          timeout: 8000,
        },
      ],
      async function* (input) {
        executed.push(input.reviewer.id);
        yield schedulerPass;
      },
      { sourceFiles: 300 },
    );
    const completion = await fixture.run;
    expect(executed).toContain("fallback");
    expect(completion.exitCode).toBe(0);
  });
  it("retains an unsatisfied provider quorum when every model is inherited", async () => {
    const inherited = ["first", "second"].map((reviewerId) => ({
      reviewerId,
      lensId: "quorum",
      result: {
        ...schedulerPass.result,
        change_coverage: {
          status: "not_applicable" as const,
          inspected_count: 0,
          deficit_count: 0,
          deficit_sample: [],
        },
      },
      resultDigest: "a".repeat(64),
      resultByteCount: 1,
      coverageEntries: [],
      terminal: { status: "completed", lens_id: "quorum", mode: "full_review" },
    }));
    const fixture = await schedulerFixture(
      [
        { id: "first", lens: "quorum", provider: "same" },
        { id: "second", lens: "quorum", provider: "same" },
      ],
      async function* () {
        throw new Error("inherited models must not rerun");
      },
      {
        passQuorum: 2,
        minimumProviderGroups: 2,
        retry: {
          parentRunId: "parent",
          runLensIds: [],
          inherited,
          inheritance: "exact",
          rawFindings: [],
          proofBySourceRef: {},
          adjudicationOutcomes: [],
        },
      },
    );
    const completion = await fixture.run;
    expect(completion.exitCode).toBe(3);
    expect(completion.summary.lens_summaries).toContainEqual({
      lens_id: "quorum",
      outcome: "incomplete",
    });
  });
  const findingResult = (): Omit<ReviewerResultV4, "change_coverage"> => ({
    schema_version: "4",
    verdict: "fail",
    summary: "A changed behavior is broken.",
    review_markdown: "A changed behavior is broken.",
    actionable_findings: [
      {
        id: "finding-1",
        severity: "high",
        title: "Changed behavior fails",
        description: "The changed function returns the wrong value.",
        evidence: [
          {
            path: "worker.ts",
            start_line: 1,
            end_line: 1,
            detail: "The changed return is here.",
          },
        ],
        suggested_direction: "Restore the expected return value.",
        confidence: "high",
        classification: "confirmed_defect",
        external_assumptions: [],
        category: "correctness",
        verification: "Call the changed function.",
        change_impact: "The changed line introduces the wrong return.",
        claim: {
          trigger: "The changed function runs",
          affected_behavior: "It returns a value",
          outcome: "The caller receives the wrong value",
        },
      },
    ],
    informational_notes: [],
  });

  it("does not treat a full-scope policy-excluded entry as finding proof", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "review-mesh-v9-run-"));
    roots.push(workspace);
    await writeFile(join(workspace, "worker.ts"), "return wrong;\n");
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
        minimumInspection: "full_file",
        proof: "observed",
      },
    };
    const registry = new AdapterRegistry();
    registry.register("command", () => ({
      id: "proof",
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
          result: findingResult(),
        };
      },
    }));
    const recorded: Record<string, unknown>[] = [];
    const completion = await runV9Review({
      runId: "full-scope-unread",
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
      record: async (value) => {
        recorded.push(value);
      },
      recordResult: async () => undefined,
    });
    expect(completion.canonical.counts.gate_eligible_subfindings).toBe(0);
    const resolution = recorded.find((entry) => entry.record === "resolution")
      ?.resolution as { reviewers: Record<string, unknown>[] };
    expect(resolution.reviewers[0]).toMatchObject({
      adapter: base.config.reviewers[0]!.adapterId,
      model: base.config.reviewers[0]!.model,
      purpose: base.config.reviewers[0]!.purpose,
      isolation: base.config.reviewers[0]!.isolationPolicy,
    });
    expect(resolution.reviewers[0]).not.toHaveProperty("instruction_layers");
    expect(resolution.reviewers[0]).not.toHaveProperty("runtime");
    expect(completion.canonical.atomics[0]?.gate_eligibility.reasons).toContain(
      "evidence_unverified",
    );
  });

  it("accepts an acknowledged observed read as finding-specific proof", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "review-mesh-v9-run-"));
    roots.push(workspace);
    await writeFile(join(workspace, "worker.ts"), "return wrong;\n");
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
        minimumInspection: "full_file",
        proof: "observed",
      },
    };
    const registry = new AdapterRegistry();
    registry.register("command", () => ({
      id: "proof",
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
      async *run(input) {
        const read = await input.coverage!.readFile({ path: "worker.ts" });
        if (read.ok) read.acknowledgeDelivered();
        yield {
          type: "result" as const,
          isolation: "runtime_read_only" as const,
          result: findingResult(),
        };
      },
    }));
    const completion = await runV9Review({
      runId: "full-scope-read",
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
    expect(completion.canonical.counts.gate_eligible_subfindings).toBe(1);
  });
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
    let admittedReviewerId: string | undefined;
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
      async *run(input) {
        providerCalls += 1;
        admittedReviewerId = input.reviewer.id;
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
          data: expect.objectContaining({
            failure: expect.objectContaining({
              diagnostics: expect.objectContaining({
                retry_blocked_by_circuit: true,
                circuit_caused_by_reviewer_id: admittedReviewerId,
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
              const page = JSON.stringify({
                schema_version: "1",
                kind: "review-mesh.result-page",
                result_id: "fixture-pages",
                result_kind: "reviewer",
                result_schema_version: "4",
                page_index: 0,
                page_count: 2,
                page_kind: "header",
                previous_page_digest: null,
                payload: {
                  verdict: "pass",
                  summary: "done",
                  informational_notes: [],
                  narrative_byte_count: 4,
                  narrative_fragment_count: 1,
                  actionable_finding_count: 0,
                  coverage_attestation: null,
                },
              });
              const digest = createHash("sha256").update(page).digest("hex");
              yield { raw: page, sha256: digest };
              const next = JSON.stringify({
                schema_version: "1",
                kind: "review-mesh.result-page",
                result_id: "fixture-pages",
                result_kind: "reviewer",
                result_schema_version: "4",
                page_index: 1,
                page_count: 2,
                page_kind: "narrative",
                previous_page_digest: digest,
                payload: { text_fragment: "done" },
              });
              yield {
                raw: next,
                sha256: createHash("sha256").update(next).digest("hex"),
              };
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
      expect.objectContaining({
        index: 0,
        serialization_boundary: "provider_raw",
      }),
      expect.objectContaining({
        index: 1,
        serialization_boundary: "provider_raw",
      }),
    ]);
  });

  it("falls back when repeated activity identities do not make progress", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const workspace = await mkdtemp(join(tmpdir(), "review-mesh-v9-run-"));
      roots.push(workspace);
      const base = roundInput();
      base.config.execution.no_progress_timeout_ms = 1_000;
      base.config.execution.retry_attempts = 1;
      const reviewers = ["stalled", "fallback"].map((id) => ({
        ...structuredClone(base.config.reviewers[0]!),
        id,
        agentId: "progress-lens",
        adapterId: id,
        timeoutMs: 10_000,
        attemptTimeoutMs: 10_000,
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
      const registry = new AdapterRegistry();
      let fallbackCalls = 0;
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
            progress_observable:
              registration.type === "command" &&
              registration.command === "stalled",
          };
        },
        async *run(input) {
          if (
            registration.type === "command" &&
            registration.command === "fallback"
          ) {
            fallbackCalls += 1;
            yield {
              type: "result" as const,
              isolation: "runtime_read_only" as const,
              result: {
                schema_version: "4" as const,
                verdict: "pass" as const,
                summary: "fallback completed",
                review_markdown: "fallback completed",
                actionable_findings: [],
                informational_notes: [],
              },
            };
            return;
          }
          while (!input.signal.aborted) {
            await new Promise((resolve) => setTimeout(resolve, 400));
            yield {
              type: "activity" as const,
              message: "Still processing the same response.",
              identity: "same-response",
              byteCount: 1,
            };
          }
        },
      }));
      const records: Array<Record<string, unknown>> = [];
      let completion: Awaited<ReturnType<typeof runV9Review>> | undefined;
      runV9Review({
        runId: "no-progress",
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
        record: async (record) => {
          records.push(record);
        },
        recordResult: async () => undefined,
        now: () => Date.now(),
      }).then((value) => {
        completion = value;
      });
      for (let index = 0; index < 100 && completion === undefined; index += 1)
        await vi.advanceTimersByTimeAsync(100);
      expect(completion?.exitCode).toBe(0);
      expect(fallbackCalls).toBe(1);
      expect(records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            reviewer_id: "stalled",
            data: expect.objectContaining({
              failure: expect.objectContaining({
                reason: "no_progress_timeout",
              }),
            }),
          }),
        ]),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps forty-model liveness bounded through an eighty-one-minute run", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const workspace = await mkdtemp(join(tmpdir(), "review-mesh-v9-run-"));
      roots.push(workspace);
      const base = roundInput();
      const duration = 81 * 60_000;
      base.config.execution.deadline_mode = "fixed";
      base.config.execution.run_deadline_ms = duration;
      base.config.execution.heartbeat_interval_ms = 1_000;
      base.config.execution.max_concurrency = 40;
      base.config.execution.default_provider_concurrency = 40;
      base.config.execution.retry_attempts = 1;
      base.config.reviewers = Array.from({ length: 40 }, (_, index) => ({
        ...structuredClone(base.config.reviewers[0]!),
        id: `reviewer-${index.toString().padStart(2, "0")}`,
        agentId: `lens-${index.toString().padStart(2, "0")}`,
        timeoutMs: duration,
        attemptTimeoutMs: duration,
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
      const registry = new AdapterRegistry();
      registry.register("command", () => ({
        id: "long-running",
        async probe() {
          return {
            available: true,
            authenticated: true,
            model_available: true,
            streaming: false,
            cancellation: true,
            maximumIsolation: "runtime_read_only",
            observed_file_access: true,
            progress_observable: false,
          };
        },
        async *run(input) {
          await new Promise<void>((resolve) => {
            input.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
        },
      }));
      const events: Array<{ event?: string; data?: Record<string, unknown> }> =
        [];
      let completion: Awaited<ReturnType<typeof runV9Review>> | undefined;
      runV9Review({
        runId: "long-liveness",
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
          finish: async () => ({
            path: "/artifact",
            sha256: "a".repeat(64),
            byte_count: 1,
            completed_results: 0,
          }),
          outputFailed: () => false,
          close: async () => undefined,
        },
        record: async () => undefined,
        recordResult: async () => undefined,
        now: () => Date.now(),
      }).then((value) => {
        completion = value;
      });
      vi.runOnlyPendingTimersAsync();
      for (
        let index = 0;
        index < 100 &&
        events.filter((event) => event.event === "reviewer.started").length <
          40;
        index += 1
      )
        await Promise.resolve();
      for (
        let index = 0;
        index < 1_000 &&
        events.filter((event) => event.event === "reviewer.started").length <
          40;
        index += 1
      )
        await vi.advanceTimersByTimeAsync(0);
      expect(
        events.filter((event) => event.event === "reviewer.started"),
      ).toHaveLength(40);
      await vi.advanceTimersByTimeAsync(duration);
      for (let index = 0; index < 100 && completion === undefined; index += 1)
        await vi.advanceTimersByTimeAsync(0);
      expect(completion?.exitCode).toBe(3);
      const heartbeats = events.filter(
        (event) => event.event === "suite.heartbeat",
      );
      expect(heartbeats.length).toBeGreaterThanOrEqual(duration / 1_000 - 1);
      expect(heartbeats.some((event) => event.data?.minimal === true)).toBe(
        true,
      );
      expect(
        Math.max(
          ...heartbeats.map((event) =>
            Buffer.byteLength(JSON.stringify(event), "utf8"),
          ),
        ),
      ).toBeLessThan(16 * 1_024);
      expect(
        Math.max(
          ...heartbeats.map((event) =>
            Array.isArray(event.data?.active) ? event.data.active.length : 0,
          ),
        ),
      ).toBeLessThanOrEqual(8);
      const elapsed = heartbeats.map((event) => Number(event.data?.elapsed_ms));
      const gaps = elapsed
        .slice(1)
        .map((value, index) => value - elapsed[index]!);
      expect(Math.max(...gaps)).toBeLessThanOrEqual(1_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses caller cancellation as the primary cause after genuine admission", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const workspace = await mkdtemp(join(tmpdir(), "review-mesh-v9-run-"));
      roots.push(workspace);
      const base = roundInput();
      base.config.execution.deadline_mode = "fixed";
      base.config.execution.run_deadline_ms = 1_000;
      base.config.execution.no_progress_timeout_ms = 1_000;
      base.config.execution.retry_attempts = 1;
      base.config.reviewers = base.config.reviewers.slice(0, 1);
      base.config.reviewers[0]!.timeoutMs = 1_000;
      base.config.reviewers[0]!.attemptTimeoutMs = 1_000;
      base.config.reviewers[0]!.policy = {
        applicability: { mode: "always" },
        requiredCallerContext: [],
        passQuorum: 1,
        minimumProviderGroups: 1,
        adjudication: "off",
        gateMinimumSeverity: "medium",
        gateMinimumConfidence: "medium",
        lensDeadlineMs: 1_000,
        changeCoverage: {
          relevantPaths: ["**"],
          minimumInspection: "diff",
          proof: "observed",
        },
      };
      const registry = new AdapterRegistry();
      let admitted = false;
      registry.register("command", () => ({
        id: "cancel",
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
          admitted = true;
          await new Promise<void>((resolve) => {
            input.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
        },
      }));
      const caller = new AbortController();
      const records: Array<Record<string, unknown>> = [];
      let completion: Awaited<ReturnType<typeof runV9Review>> | undefined;
      runV9Review({
        runId: "cancel-precedence",
        config: base.config,
        context: resolvedContext({
          workspace,
          review_scope: { mode: "full", source: "request" },
        }),
        registry,
        signal: caller.signal,
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
        now: () => Date.now(),
      }).then((value) => {
        completion = value;
      });
      for (let index = 0; index < 100 && !admitted; index += 1)
        await vi.advanceTimersByTimeAsync(0);
      for (let index = 0; index < 100 && !admitted; index += 1)
        await vi.advanceTimersByTimeAsync(1);
      expect(admitted).toBe(true);
      caller.abort(new Error("caller cancelled"));
      for (let index = 0; index < 100 && completion === undefined; index += 1)
        await vi.advanceTimersByTimeAsync(0);
      expect(completion?.exitCode).toBe(4);
      expect(records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            reviewer_id: base.config.reviewers[0]!.id,
            data: expect.objectContaining({
              failure: expect.objectContaining({ reason: "cancelled" }),
            }),
          }),
        ]),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives a fallback its execution budget after a busy provider admits it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const starts: Record<string, number> = {};
      const fixture = await schedulerFixture(
        [
          { id: "busy", lens: "busy", provider: "astra" },
          {
            id: "primary",
            lens: "fallback-lens",
            provider: "opus",
            after: "busy",
          },
          {
            id: "fallback",
            lens: "fallback-lens",
            provider: "astra",
            timeout: 1_000,
          },
        ],
        async function* (input) {
          const id = input.reviewer.id;
          starts[id] = Date.now();
          if (id === "primary") {
            yield {
              type: "failure",
              failure: {
                reason: "invalid_result",
                message: "Use the fallback",
                retryable: false,
                fallback_eligible: true,
                circuit_qualifying: false,
              },
            };
            return;
          }
          await adapterDelay(id === "busy" ? 2_000 : 700, input.signal);
          if (!input.signal.aborted) yield schedulerPass;
        },
      );
      await waitForScheduler(() => starts.busy !== undefined);
      await waitForScheduler(() =>
        fixture.events.some(
          (event) =>
            event.reviewer_id === "fallback" && event.data?.phase === "queued",
        ),
      );
      await vi.advanceTimersByTimeAsync(3_000);
      const completion = await fixture.run;
      expect(completion.exitCode).toBe(0);
      expect(starts.fallback).toBeGreaterThanOrEqual(2_000);
      expect(fixture.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: "reviewer.started",
            reviewer_id: "fallback",
            data: expect.objectContaining({ timeout_ms: 1_000 }),
          }),
          expect.objectContaining({
            event: "reviewer.completed",
            reviewer_id: "fallback",
          }),
        ]),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("admits another provider while an earlier fallback waits for capacity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const starts: Record<string, number> = {};
      const fixture = await schedulerFixture(
        [
          { id: "busy", lens: "busy", provider: "astra" },
          { id: "primary", lens: "chain", provider: "opus", after: "busy" },
          { id: "fallback", lens: "chain", provider: "astra" },
          { id: "ready", lens: "ready", provider: "opus", after: "primary" },
        ],
        async function* (input) {
          starts[input.reviewer.id] = Date.now();
          if (input.reviewer.id === "primary") {
            yield {
              type: "failure",
              failure: {
                reason: "invalid_result",
                message: "Use the fallback",
                retryable: false,
                fallback_eligible: true,
                circuit_qualifying: false,
              },
            };
            return;
          }
          if (input.reviewer.id === "busy")
            await adapterDelay(5_000, input.signal);
          if (!input.signal.aborted) yield schedulerPass;
        },
      );
      await waitForScheduler(() => starts.primary !== undefined);
      await waitForScheduler(() =>
        fixture.events.some(
          (event) =>
            event.reviewer_id === "fallback" && event.data?.phase === "queued",
        ),
      );
      await vi.advanceTimersByTimeAsync(6_000);
      await fixture.run;
      expect(starts.ready).toBeLessThan(5_000);
      expect(starts.fallback).toBeGreaterThanOrEqual(5_000);
      expect(fixture.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: "reviewer.progress",
            reviewer_id: "fallback",
            data: expect.objectContaining({
              phase: "queued",
              queue_reason: "provider_limit",
            }),
          }),
        ]),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    {
      runDeadline: 1_000,
      lensDeadline: 5_000,
      boundary: "run_deadline_exceeded",
    },
    {
      runDeadline: 5_000,
      lensDeadline: 1_000,
      boundary: "lens_deadline_exceeded",
    },
  ])(
    "identifies $boundary while a reviewer waits in the provider queue",
    async (item) => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      try {
        const starts: string[] = [];
        const fixture = await schedulerFixture(
          [
            { id: "busy", lens: "busy", provider: "astra" },
            {
              id: "queued",
              lens: "queued",
              provider: "astra",
              lensDeadline: item.lensDeadline,
              timeout: 10_000,
              after: "busy",
            },
          ],
          async function* (input) {
            starts.push(input.reviewer.id);
            await adapterDelay(2_000, input.signal);
            if (!input.signal.aborted) yield schedulerPass;
          },
          { runDeadline: item.runDeadline },
        );
        await waitForScheduler(() => starts.includes("busy"));
        await waitForScheduler(() =>
          fixture.events.some(
            (event) =>
              event.reviewer_id === "queued" && event.data?.phase === "queued",
          ),
        );
        await vi.advanceTimersByTimeAsync(2_100);
        await fixture.run;
        expect(starts).not.toContain("queued");
        expect(fixture.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              event: "reviewer.incomplete",
              reviewer_id: "queued",
              data: expect.objectContaining({
                reason: "queue_deadline_exceeded",
                failure_stage: "queued",
                expired_boundary: item.boundary,
              }),
            }),
          ]),
        );
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("separates probe time from admitted attempt time and reconciles timestamps", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      let probing = false;
      let admitted = false;
      const fixture = await schedulerFixture(
        [
          {
            id: "timed",
            lens: "timed",
            provider: "opus",
            timeout: 2_000,
            attemptTimeout: 1_000,
          },
        ],
        async function* (input) {
          admitted = true;
          await adapterDelay(5_000, input.signal);
          if (!input.signal.aborted) yield schedulerPass;
        },
        {
          probe: async (_reviewer, signal) => {
            probing = true;
            await adapterDelay(500, signal!);
            return {
              available: true,
              authenticated: true,
              model_available: true,
              streaming: false,
              cancellation: true,
              maximumIsolation: "runtime_read_only",
              observed_file_access: true,
              progress_observable: false,
            };
          },
        },
      );
      await waitForScheduler(() => probing);
      await vi.advanceTimersByTimeAsync(500);
      await waitForScheduler(() => admitted);
      await vi.advanceTimersByTimeAsync(1_000);
      await fixture.run;
      expect(fixture.records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            record: "reviewer.attempt",
            reviewer_id: "timed",
            data: expect.objectContaining({
              started_at: "1970-01-01T00:00:00.500Z",
              admitted_at: "1970-01-01T00:00:00.500Z",
              ended_at: "1970-01-01T00:00:01.500Z",
              elapsed_ms: 1_000,
              execution_elapsed_ms: 1_000,
              probe_elapsed_ms: 500,
              queue_wait_ms: 0,
              failure: expect.objectContaining({
                reason: "attempt_deadline_exceeded",
              }),
            }),
          }),
        ]),
      );
      expect(fixture.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: "reviewer.started",
            data: expect.objectContaining({
              admitted_at: "1970-01-01T00:00:00.500Z",
              timeout_ms: 1_000,
              probe_elapsed_ms: 500,
            }),
          }),
        ]),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves a completed model slot when retrying a lens with an unmet quorum", async () => {
    const executed: string[] = [];
    const inheritedResult = {
      ...schedulerPass.result,
      change_coverage: {
        status: "not_applicable" as const,
        inspected_count: 0,
        deficit_count: 0,
        deficit_sample: [],
      },
    };
    const fixture = await schedulerFixture(
      [
        { id: "retained", lens: "quorum", provider: "opus" },
        { id: "remaining", lens: "quorum", provider: "astra" },
      ],
      async function* (input) {
        executed.push(input.reviewer.id);
        yield schedulerPass;
      },
      {
        passQuorum: 2,
        retry: {
          parentRunId: "parent",
          runLensIds: ["quorum"],
          inherited: [
            {
              reviewerId: "retained",
              lensId: "quorum",
              result: inheritedResult,
              resultDigest: "a".repeat(64),
              resultByteCount: 1,
              coverageEntries: [],
              terminal: {
                status: "completed",
                lens_id: "quorum",
                mode: "full_review",
              },
            },
          ],
          inheritance: "exact",
          rawFindings: [],
          proofBySourceRef: {},
          adjudicationOutcomes: [],
        },
      },
    );
    const completion = await fixture.run;
    expect(executed).toEqual(["remaining"]);
    expect(completion.exitCode).toBe(0);
    expect(completion.summary.model_runs).toMatchObject({
      total: 2,
      completed: 2,
    });
  });

  it("publishes schema and coverage repair progress with their bounded messages", async () => {
    const fixture = await schedulerFixture(
      [{ id: "repairing", lens: "repairing", provider: "opus" }],
      async function* () {
        yield {
          type: "progress",
          phase: "schema_repair",
          message: "Repairing result page 1 (attempt 1 of 2).",
        };
        yield {
          type: "progress",
          phase: "schema_repair",
          message: "Repairing result page 1 (attempt 2 of 2).",
        };
        yield {
          type: "progress",
          phase: "coverage_repair",
          message: "Inspecting remaining snapshot ranges.",
        };
        yield schedulerPass;
      },
    );
    await fixture.run;
    const progress = fixture.events.filter(
      (event) => event.event === "reviewer.progress",
    );
    expect(progress).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({
            phase: "validating",
            message: "Repairing result page 1 (attempt 1 of 2).",
          }),
        }),
        expect.objectContaining({
          data: expect.objectContaining({
            phase: "validating",
            message: "Repairing result page 1 (attempt 2 of 2).",
          }),
        }),
        expect.objectContaining({
          data: expect.objectContaining({
            phase: "reviewing",
            message: "Inspecting remaining snapshot ranges.",
          }),
        }),
      ]),
    );
  });

  it("reports run, lens, candidate, and attempt boundaries in scheduler precedence", async () => {
    vi.useFakeTimers();
    try {
      const workspace = await mkdtemp(join(tmpdir(), "review-mesh-v9-run-"));
      roots.push(workspace);
      const cases = [
        {
          expected: "run_deadline_exceeded",
          run: 1_000,
          lens: 1_000,
          candidate: 1_000,
          attempt: 1_000,
        },
        {
          expected: "lens_deadline_exceeded",
          run: 5_000,
          lens: 1_000,
          candidate: 1_000,
          attempt: 1_000,
        },
        {
          expected: "model_candidate_deadline_exceeded",
          run: 5_000,
          lens: 5_000,
          candidate: 1_000,
          attempt: 1_000,
        },
        {
          expected: "attempt_deadline_exceeded",
          run: 5_000,
          lens: 5_000,
          candidate: 5_000,
          attempt: 1_000,
        },
      ] as const;
      for (const item of cases) {
        vi.setSystemTime(0);
        const base = roundInput();
        base.config.execution.deadline_mode = "fixed";
        base.config.execution.run_deadline_ms = item.run;
        base.config.execution.no_progress_timeout_ms = 10_000;
        base.config.execution.retry_attempts = 1;
        base.config.reviewers = base.config.reviewers.slice(0, 1);
        base.config.reviewers[0]!.timeoutMs = item.candidate;
        base.config.reviewers[0]!.attemptTimeoutMs = item.attempt;
        base.config.reviewers[0]!.policy = {
          applicability: { mode: "always" },
          requiredCallerContext: [],
          passQuorum: 1,
          minimumProviderGroups: 1,
          adjudication: "off",
          gateMinimumSeverity: "medium",
          gateMinimumConfidence: "medium",
          lensDeadlineMs: item.lens,
          changeCoverage: {
            relevantPaths: ["**"],
            minimumInspection: "diff",
            proof: "observed",
          },
        };
        let admitted = false;
        const registry = new AdapterRegistry();
        registry.register("command", () => ({
          id: "boundary",
          async probe() {
            return {
              available: true,
              authenticated: true,
              model_available: true,
              streaming: false,
              cancellation: true,
              maximumIsolation: "runtime_read_only",
              observed_file_access: true,
              progress_observable: false,
            };
          },
          async *run(input) {
            admitted = true;
            await new Promise<void>((resolve) => {
              input.signal.addEventListener("abort", () => resolve(), {
                once: true,
              });
            });
          },
        }));
        const records: Array<Record<string, unknown>> = [];
        let completion: Awaited<ReturnType<typeof runV9Review>> | undefined;
        runV9Review({
          runId: `boundary-${item.expected}`,
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
          now: () => Date.now(),
        }).then((value) => {
          completion = value;
        });
        for (let index = 0; index < 1_000 && !admitted; index += 1)
          await vi.advanceTimersByTimeAsync(0);
        expect(admitted).toBe(true);
        await vi.advanceTimersByTimeAsync(1_000);
        for (let index = 0; index < 100 && completion === undefined; index += 1)
          await vi.advanceTimersByTimeAsync(0);
        expect(records).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              record: "reviewer.attempt",
              data: expect.objectContaining({
                failure: expect.objectContaining({ reason: item.expected }),
              }),
            }),
          ]),
        );
      }
    } finally {
      vi.useRealTimers();
    }
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
      vi.runOnlyPendingTimersAsync();
      for (let index = 0; index < 1_000 && !finishStarted; index += 1)
        await vi.advanceTimersByTimeAsync(0);
      expect(finishStarted).toBe(true);
      const before = events.filter(
        (event) => event.event === "suite.heartbeat",
      ).length;
      await vi.advanceTimersByTimeAsync(2_000);
      expect(
        events.filter((event) => event.event === "suite.heartbeat").length,
      ).toBeGreaterThanOrEqual(before + 2);
      releaseFinalize();
      await run;
    } finally {
      vi.useRealTimers();
    }
  });
});
