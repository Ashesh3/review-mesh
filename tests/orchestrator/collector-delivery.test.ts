import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it } from "vitest";
import { AdapterRegistry } from "../../src/adapters/registry.js";
import { adapterFailure } from "../../src/adapters/errors.js";
import { createV9EventWriter } from "../../src/protocol/v9-event-writer.js";
import { runV9Review } from "../../src/orchestrator/run-v9.js";
import { resolvedContext, roundInput } from "../helpers/fixtures.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

it.each([false, true])(
  "delivers provider timeouts without aborting unrelated reviewers or inventing deadlines (bare failure: %s)",
  async (bare) => {
    const workspace = await mkdtemp(join(tmpdir(), "mesh-causal-"));
    roots.push(workspace);
    const base = roundInput();
    Object.assign(base.config.execution, {
      deadline_mode: "fixed",
      run_deadline_ms: 60_000,
      max_concurrency: 2,
      default_provider_concurrency: 2,
      retry_attempts: 1,
    });
    base.config.reviewers = ["gateway", "other"].map((id) => ({
      ...base.config.reviewers[0]!,
      id,
      agentId: bare ? "same-lens" : id,
      providerGroup: id,
      policy: {
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
      },
    }));
    const registry = new AdapterRegistry();
    registry.register("command", () => ({
      id: "test",
      probe: async () => ({
        available: true,
        authenticated: true,
        model_available: true,
        streaming: false,
        cancellation: true,
        maximumIsolation: "runtime_read_only",
        observed_file_access: true,
      }),
      async *run(input) {
        if (input.reviewer.id === "gateway") {
          yield {
            type: "failure",
            failure: bare
              ? {
                  reason: "timeout",
                  message: "Bare timeout without optional fallback flag",
                  retryable: false,
                }
              : adapterFailure.timeout("Gateway timed out", true, {
                  diagnostics: {
                    http_status: 524,
                    failure_code: "gateway_timeout",
                    scope: "provider",
                  },
                }),
          };
          return;
        }
        await new Promise<void>((done) => setTimeout(done, 25));
        expect(input.signal.aborted).toBe(false);
        yield {
          type: "result",
          isolation: "runtime_read_only",
          result: {
            schema_version: "4",
            verdict: "pass",
            summary: "done",
            review_markdown: "",
            actionable_findings: [],
            informational_notes: [],
          },
        };
      },
    }));
    const output = new PassThrough();
    let text = "";
    output.on("data", (c) => (text += String(c)));
    const observed: string[] = [];
    const records: Record<string, unknown>[] = [];
    let results = 0;
    const writer = createV9EventWriter({
      output,
      runId: "causal",
      recordEvent: async (e) => {
        records.push(e);
      },
      finalize: async () => ({
        path: "/artifact",
        sha256: "a".repeat(64),
        byte_count: 1,
        completed_results: results,
      }),
      observe: async (value) => {
        observed.push(value);
      },
    });
    try {
      const result = await runV9Review({
        runId: "causal",
        config: base.config,
        context: resolvedContext({
          workspace,
          review_scope: { mode: "full", source: "request" },
        }),
        registry,
        signal: new AbortController().signal,
        writer,
        record: async (r) => {
          records.push(r);
        },
        recordResult: async () => {
          results++;
        },
        outputMode: "full-jsonl",
      });
      const events = text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(
        result.jobs.find((job) => job.reviewer.id === "other")?.status,
      ).toBe("completed");
      expect(
        events.find((e) => e.event === "reviewer.incomplete")?.data.reason,
      ).toBe("provider_timeout");
      expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
      expect(text).not.toContain("deadline_exceeded");
      expect(observed).toEqual(["complete"]);
    } finally {
      await writer.close();
    }
  },
);

it("persists successful reviewer work after stdout closes and records the causal delivery failure", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "mesh-output-loss-"));
  roots.push(workspace);
  const base = roundInput();
  base.config.execution.retry_attempts = 1;
  base.config.reviewers = base.config.reviewers.slice(0, 1);
  const registry = new AdapterRegistry();
  registry.register("command", () => ({
    id: "local",
    probe: async () => ({
      available: true,
      authenticated: true,
      model_available: true,
      streaming: false,
      cancellation: true,
      maximumIsolation: "runtime_read_only",
      observed_file_access: true,
    }),
    async *run(input) {
      expect(input.signal.aborted).toBe(false);
      yield {
        type: "result",
        isolation: "runtime_read_only",
        result: {
          schema_version: "4",
          verdict: "pass",
          summary: "Preserved after output loss",
          review_markdown: "",
          actionable_findings: [],
          informational_notes: [],
        },
      };
    },
  }));
  const output = new PassThrough();
  output.on("error", () => undefined);
  output.destroy(Object.assign(new Error("pipe closed"), { code: "EPIPE" }));
  const observed: string[] = [];
  const records: Record<string, unknown>[] = [];
  let saved: Record<string, unknown> | undefined;
  let results = 0;
  const writer = createV9EventWriter({
    output,
    runId: "output-loss",
    recordEvent: async (e) => {
      records.push(e);
    },
    finalize: async (summary) => {
      saved = summary;
      return {
        path: "/artifact",
        sha256: "a".repeat(64),
        byte_count: 1,
        completed_results: results,
      };
    },
    observe: async (value) => {
      observed.push(value);
    },
  });
  try {
    await expect(
      runV9Review({
        runId: "output-loss",
        config: base.config,
        context: resolvedContext({
          workspace,
          review_scope: { mode: "full", source: "request" },
        }),
        registry,
        signal: new AbortController().signal,
        writer,
        record: async (r) => {
          records.push(r);
        },
        recordResult: async () => {
          results++;
        },
      }),
    ).rejects.toThrow();
    expect(results).toBe(1);
    expect(records.filter((r) => r.record === "run.error")).toHaveLength(1);
    expect(saved).toMatchObject({
      delivery_failure: { stage: "output_write", event: "run.started" },
      result_delivery: { planned_public_stream: "failed" },
      model_runs: { completed: 1 },
    });
    expect(observed).toEqual(["failed"]);
    expect(JSON.stringify(records)).not.toContain("deadline_exceeded");
  } finally {
    await writer.close();
  }
});
