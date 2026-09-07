import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { AdapterRegistry } from "../../src/adapters/registry.js";
import type {
  AdapterEvent,
  AdapterReviewInput,
} from "../../src/adapters/types.js";
import { runNativeReview } from "../../src/orchestrator/run-native.js";
import type {
  ProviderReviewerResultV4,
  AdjudicationResultV2,
} from "../../src/protocol/v9.js";
import {
  resolvedContext,
  resolvedReviewer,
  roundInput,
} from "../helpers/fixtures.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function run(options: {
  profile?: "strict-evaluation" | "routine-review";
  finding?: boolean;
  failureAt?: number;
  disagreement?: boolean;
  proofIssueAt?: number;
  stallAt?: number;
  downgrade?: boolean;
  delay?: boolean;
  preparationWait?: boolean;
}) {
  const workspace = await mkdtemp(join(tmpdir(), "mesh-native-strict-"));
  roots.push(workspace);
  await writeFile(join(workspace, "source.ts"), "return oldValue;\n");
  const config = roundInput().config;
  Object.assign(config.execution, {
    ...(options.profile ? { review_profile: options.profile } : {}),
    max_concurrency: 8,
    default_provider_concurrency: 8,
    deadline_mode: "adaptive",
    heartbeat_interval_ms: 10,
    ...(options.stallAt === undefined ? {} : { no_progress_timeout_ms: 30 }),
  });
  config.reviewers = Array.from({ length: 40 }, (_, index) =>
    resolvedReviewer({
      id: `lens${Math.floor(index / 5)}::m${index % 5}`,
      agentId: `lens${Math.floor(index / 5)}`,
      modelIndex: index % 5,
      configuredModelIndex: index % 5,
      modelCount: 5,
      model: `m${index % 5}`,
      providerGroup: `p${index % 5}`,
      adapterId: "native",
      adapter: { type: "codex" },
      timeoutMs: 30_000,
      policy: {
        passQuorum: options.profile === "routine-review" ? 2 : 5,
        minimumProviderGroups: options.profile === "routine-review" ? 2 : 5,
        adjudication: "required",
        gateMinimumSeverity: "medium",
        gateMinimumConfidence: "medium",
        changeCoverage: {
          relevantPaths: ["**"],
          minimumInspection: "full_file",
          proof: "native_attested",
        },
      },
    }),
  );
  const received: AdapterReviewInput[] = [];
  const records: Record<string, unknown>[] = [];
  const events: Record<string, any>[] = [];
  const registry = new AdapterRegistry();
  registry.register("codex", () => ({
    id: "native",
    async probe() {
      return {
        available: true,
        authenticated: true,
        model_available: true,
        streaming: true,
        cancellation: true,
        maximumIsolation: "runtime_read_only" as const,
      };
    },
    async *run(input): AsyncIterable<AdapterEvent> {
      received.push(input);
      if (input.reviewer.modelIndex === options.stallAt) {
        await new Promise<void>((resolve) =>
          input.signal.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
        yield {
          type: "failure",
          failure: {
            reason: "cancelled",
            message: "SDK saw cancellation",
            retryable: false,
          },
        };
        return;
      }
      if (options.delay)
        await new Promise((resolve) => setTimeout(resolve, 30));
      if (input.reviewer.modelIndex === options.failureAt) {
        yield {
          type: "failure",
          failure: {
            reason: "process_crashed",
            message: "Safe provider failure",
            retryable: false,
            diagnostics: {
              failure_stage: "native_copilot",
              http_status: 400,
              provider_error_code: "invalid_schema",
            },
          },
        };
        return;
      }
      let result: ProviderReviewerResultV4 | AdjudicationResultV2;
      if (input.reviewer.policy?.mode === "adjudication") {
        const candidates = input.reviewer.policy.candidateFindings as Array<{
          id: string;
        }>;
        const downgraded = options.downgrade && input.reviewer.modelIndex === 4;
        const rejected =
          options.disagreement && input.reviewer.modelIndex === 4;
        result = {
          schema_version: "2",
          kind: "review-mesh.adjudication-result",
          verdict: rejected ? "pass" : "fail",
          review_markdown: "Independently checked the candidate",
          summary: "Candidate checked",
          actionable_findings: [],
          informational_notes: [],
          decisions: candidates.map(({ id }) => ({
            source_finding_id: id,
            decision: rejected
              ? ("rejected" as const)
              : downgraded
                ? ("adjusted" as const)
                : ("confirmed" as const),
            rationale: "Checked the cited branch.",
            cited_evidence: [
              {
                path: "source.ts",
                start_line:
                  input.reviewer.modelIndex === options.proofIssueAt ? 99 : 1,
                end_line:
                  input.reviewer.modelIndex === options.proofIssueAt ? 99 : 1,
                detail: "return oldValue",
              },
            ],
            unverified_assumptions: [],
            ...(downgraded
              ? {
                  adjusted_finding: {
                    severity: "low" as const,
                    confidence: "low" as const,
                    classification: "advisory" as const,
                    title: "Optional improvement",
                    description: "This is advisory.",
                    evidence: [
                      {
                        path: "source.ts",
                        start_line: 1,
                        end_line: 1,
                        detail: "return oldValue",
                      },
                    ],
                    suggested_direction: "Consider an improvement.",
                    external_assumptions: [],
                    category: "correctness" as const,
                    verification: "Review the existing path.",
                    claim: {
                      trigger: "Value changes",
                      affected_behavior: "Old value returned",
                      outcome: "Caller receives stale data",
                    },
                  },
                }
              : {}),
          })),
        };
      } else {
        result = {
          schema_version: "4",
          verdict: options.finding ? "fail" : "pass",
          summary: "Native review",
          review_markdown: "Inspected the whole file",
          native_scope_attestation: {
            complete: true,
            reviewed_paths: ["source.ts"],
            limitations: [],
          },
          informational_notes: [],
          actionable_findings: options.finding
            ? [
                {
                  id: "f1",
                  severity: "high",
                  confidence: "high",
                  classification: "confirmed_defect",
                  category: "correctness",
                  title: "Stale result",
                  description: "The return uses the old value.",
                  evidence: [
                    {
                      path: "source.ts",
                      start_line: 1,
                      end_line: 1,
                      detail: "return oldValue",
                    },
                  ],
                  suggested_direction: "Return the current value.",
                  verification: "Inspect the return.",
                  external_assumptions: [],
                  claim: {
                    trigger: "Value changes",
                    affected_behavior: "Old value returned",
                    outcome: "Caller receives stale data",
                  },
                },
              ]
            : [],
        };
      }
      yield { type: "result", isolation: "runtime_read_only", result };
    },
  }));
  const result = await runNativeReview({
    runId: "strict-evaluation",
    config,
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
        completed_results: 40,
      }),
      outputFailed: () => false,
      close: async () => undefined,
    },
    record: async (record) => {
      records.push(record);
      if (options.preparationWait && record.record === "context")
        await new Promise((resolve) => setTimeout(resolve, 35));
    },
    recordResult: async () => undefined,
  });
  return { result, records, received, events };
}

it("executes all forty strict jobs after early findings while retaining required adjudication", async () => {
  const { result, received } = await run({
    profile: "strict-evaluation",
    finding: true,
  });
  expect(received).toHaveLength(40);
  expect(result.jobs.filter((job) => job.status === "completed")).toHaveLength(
    40,
  );
  expect(
    received.filter((input) => input.reviewer.policy?.mode === "adjudication"),
  ).toHaveLength(32);
  expect(result.summary).toMatchObject({
    review_profile: "strict-evaluation",
    coverage_outcome: "complete",
    model_runs: { total: 40, completed: 40, incomplete: 0, skipped: 0 },
  });
  expect(result.exitCode).toBe(1);
  expect(result.canonical.counts.raw_source_findings).toBe(8);
  expect(result.canonical.counts.gate_eligible_subfindings).toBe(1);
});

it("does not call strict execution complete when any configured adjudicator fails", async () => {
  const { result, received, records } = await run({
    profile: "strict-evaluation",
    finding: true,
    failureAt: 3,
  });
  expect(received).toHaveLength(40);
  expect(result.summary).toMatchObject({
    coverage_outcome: "partial",
    model_runs: { completed: 32, incomplete: 8, skipped: 0 },
  });
  expect(result.exitCode).toBe(3);
  expect(records).toContainEqual(
    expect.objectContaining({
      record: "reviewer.attempt",
      data: expect.objectContaining({
        failure: expect.objectContaining({
          diagnostics: expect.objectContaining({
            http_status: 400,
            provider_error_code: "invalid_schema",
          }),
        }),
      }),
    }),
  );
});

it("does not let a later contradictory strict adjudication erase verified findings", async () => {
  const { result, received } = await run({
    profile: "strict-evaluation",
    finding: true,
    disagreement: true,
  });
  expect(received).toHaveLength(40);
  expect(result.canonical.counts.raw_source_findings).toBe(8);
  expect(result.canonical.counts.gate_eligible_subfindings).toBe(1);
  expect(result.summary.coverage_outcome).toBe("partial");
  expect(result.summary.warnings).toContain("adjudication_disagreement");
});

it("does not hide an invalid strict adjudicator proof behind a later valid decision", async () => {
  const { result } = await run({
    profile: "strict-evaluation",
    finding: true,
    proofIssueAt: 3,
  });
  expect(result.summary).toMatchObject({
    model_runs: { completed: 32, incomplete: 8, skipped: 0 },
    coverage_outcome: "partial",
  });
  expect(result.canonical.counts.gate_eligible_subfindings).toBe(1);
});

it("retains a verified strict finding when another adjudicator downgrades its gate classification", async () => {
  const { result } = await run({
    profile: "strict-evaluation",
    finding: true,
    downgrade: true,
  });
  expect(result.canonical.counts.gate_eligible_subfindings).toBe(1);
  expect(result.summary).toMatchObject({
    coverage_outcome: "partial",
    warnings: ["adjudication_disagreement"],
  });
});

it("retains routine early exits without pretending skipped jobs ran", async () => {
  const { result, received } = await run({
    profile: "routine-review",
    finding: true,
  });
  expect(received).toHaveLength(16);
  expect(result.jobs.filter((job) => job.status === "skipped")).toHaveLength(
    24,
  );
  expect(result.summary.coverage_outcome).toBe("complete");
});

it("enforces the configured native silence deadline and preserves its cause through SDK cancellation", async () => {
  const { result } = await run({ profile: "strict-evaluation", stallAt: 0 });
  expect(
    result.jobs.filter((job) => job.reason === "no_progress_timeout"),
  ).toHaveLength(8);
  expect(result.summary).toMatchObject({
    model_runs: { completed: 32, incomplete: 8 },
    coverage_outcome: "partial",
  });
}, 1000);

it("emits native heartbeat counters and current reviewer details during full roster work", async () => {
  const { result, events } = await run({
    profile: "strict-evaluation",
    delay: true,
  });
  expect(result.exitCode).toBe(0);
  const active = events.find(
    (event) => event.event === "suite.heartbeat" && event.data.active_count > 0,
  );
  expect(active?.data).toMatchObject({
    model_runs: { total: 40 },
    active: expect.arrayContaining([
      expect.objectContaining({
        reviewer_id: expect.any(String),
        phase: "reviewing",
      }),
    ]),
  });
});

it("keeps a heartbeat visible during native workspace preparation before suite resolution", async () => {
  const { events } = await run({ preparationWait: true });
  const suite = events.findIndex((event) => event.event === "suite.resolved");
  expect(events.slice(0, suite)).toContainEqual(
    expect.objectContaining({
      event: "suite.heartbeat",
      data: expect.objectContaining({
        active_count: 0,
        model_runs: {
          total: 40,
          completed: 0,
          incomplete: 0,
          skipped: 0,
          running: 0,
          queued: 40,
        },
      }),
    }),
  );
});
