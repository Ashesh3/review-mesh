import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AdapterRegistry } from "../../src/adapters/registry.js";
import type { AdapterEvent } from "../../src/adapters/types.js";
import { runNativeReview } from "../../src/orchestrator/run-native.js";
import {
  resolvedContext,
  resolvedReviewer,
  roundInput,
} from "../helpers/fixtures.js";
import { privatePayloadSchemas } from "../../src/diagnostics/artifact-payloads.js";
import { createNativeActivityRecorder } from "../../src/orchestrator/native-activity.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

it("bounds periodic records across long runs and flushes the latest real progress once", () => {
  const recorder = createNativeActivityRecorder({
    reviewerId: "native",
    startedAt: 0,
    intervalMs: 10,
    maximumSamples: 3,
  });
  const records = [];
  for (let index = 0; index < 50_000; index++)
    records.push(
      ...recorder.record(
        { type: "activity", message: "Authorization: Bearer PRIVATE" },
        index === 49_995,
        index * 10,
      ),
    );
  records.push(...recorder.finish(true));
  expect(records).toHaveLength(9);
  expect(records.at(-1)?.data).toMatchObject({
    last_at: 499_990,
    last_progress_at: 499_950,
    overflow: true,
    identity_overflow: true,
    suppressed_count: 49_995,
    phases: [{ events: 50_000 }],
  });
  expect(
    records
      .filter((record) => record.record === "reviewer.activity")
      .map((record) => record.data.at),
  ).toEqual([0, 10, 20, 499_950, 499_990]);
  expect(recorder.finish()).toEqual([]);
  expect(
    recorder.record({ type: "activity", message: "late" }, true, 600_000),
  ).toEqual([]);
  expect(JSON.stringify(records)).not.toContain("PRIVATE");
  for (const record of records)
    expect(
      privatePayloadSchemas[record.record]!.safeParse(record.data).success,
    ).toBe(true);
});

it("does not retain generic raw identities or reset the last progress time at finalization", () => {
  const recorder = createNativeActivityRecorder({
    reviewerId: "native",
    startedAt: 100,
  });
  expect(
    recorder.record(
      { type: "activity", message: "first", identity: "PRIVATE_TOOL_ARGUMENT" },
      true,
      150,
    ),
  ).toHaveLength(2);
  expect(
    recorder.record({ type: "activity", message: "waiting" }, false, 200),
  ).toEqual([]);
  const final = recorder.finish();
  expect(final.at(-1)?.data).toMatchObject({
    last_at: 200,
    last_progress_at: 150,
    suppressed_count: 0,
  });
  expect(JSON.stringify(final)).not.toContain("PRIVATE_TOOL_ARGUMENT");
});

it("bounds fifty thousand generic native frames without losing exact progress or delaying the result", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "mesh-native-activity-"));
  roots.push(workspace);
  await writeFile(join(workspace, "source.ts"), "export const value = 1;\n");
  const config = roundInput().config;
  config.reviewers = [
    resolvedReviewer({
      id: "native",
      adapterId: "native",
      adapter: { type: "codex" },
      model: "fixture",
      timeoutMs: 60_000,
    }),
  ];
  config.execution.no_progress_timeout_ms = 60_000;
  const registry = new AdapterRegistry();
  const activity: Record<string, any>[] = [];
  let totalRecords = 0;
  let writesBeforeResult = 0;
  let current = Date.now();
  let progressAt = current;
  registry.register("codex", () => ({
    id: "fixture",
    async probe() {
      return {
        available: true,
        authenticated: true,
        model_available: true,
        streaming: true,
        cancellation: true,
        maximumIsolation: "runtime_read_only",
      };
    },
    async *run(): AsyncIterable<AdapterEvent> {
      for (let index = 0; index < 50_000; index++) {
        current++;
        if (index === 25_000) progressAt = current;
        yield {
          type: "activity",
          message: "Native runtime is active.",
          ...(index === 25_000 ? { identity: "PRIVATE_READ_ARGUMENTS" } : {}),
        };
      }
      writesBeforeResult = activity.length;
      yield {
        type: "result",
        isolation: "runtime_read_only",
        result: {
          schema_version: "4",
          verdict: "pass",
          summary: "Complete result",
          review_markdown: "Preserved complete review",
          actionable_findings: [],
          informational_notes: [],
          native_scope_attestation: {
            complete: true,
            reviewed_paths: ["source.ts"],
            limitations: [],
          },
        },
      };
    },
  }));
  const result = await runNativeReview({
    runId: "activity-coalescing",
    config,
    registry,
    context: resolvedContext({
      workspace,
      review_scope: { mode: "full", source: "request" },
    }),
    signal: new AbortController().signal,
    now: () => current,
    writer: {
      async emit() {},
      async finish() {
        return {
          path: "/artifact",
          sha256: "a".repeat(64),
          byte_count: 1,
          completed_results: 1,
        };
      },
      outputFailed: () => false,
      async close() {},
    },
    async record(record) {
      totalRecords++;
      if (
        record.record === "reviewer.activity" ||
        record.record === "reviewer.activity_summary"
      )
        activity.push(record);
    },
    async recordResult(_id, saved) {
      expect(saved.review_markdown).toBe("Preserved complete review");
    },
  });
  expect(result.exitCode).toBe(0);
  expect(writesBeforeResult).toBeLessThan(500);
  expect(totalRecords).toBeLessThan(550);
  expect(activity.length).toBeLessThan(500);
  const summaries = activity.filter(
    (record) => record.record === "reviewer.activity_summary",
  );
  expect(summaries.at(-1)?.data).toMatchObject({
    reviewer_id: "native",
    last_at: current,
    last_progress_at: progressAt,
    phases: [{ phase: "reviewing", events: 50_000 }],
  });
  expect(summaries.at(-1)?.data.suppressed_count).toBeGreaterThan(49_500);
  for (const record of activity)
    expect(
      privatePayloadSchemas[record.record]!.safeParse(record.data).success,
    ).toBe(true);
  expect(JSON.stringify(activity)).not.toContain("PRIVATE_READ_ARGUMENTS");
});
