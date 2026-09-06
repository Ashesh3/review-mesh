import {
  chmod,
  mkdtemp,
  mkdir,
  open,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, expect, it } from "vitest";
import { runReviewApplication } from "../../src/app.js";
import { AdapterRegistry } from "../../src/adapters/registry.js";
import { loadV9Run } from "../../src/diagnostics/v9-views.js";
import type {
  AdapterEvent,
  AdapterReviewInput,
} from "../../src/adapters/types.js";
import type {
  ActionableFindingV4,
  ProviderReviewerResultV4,
  AdjudicationResultV2,
} from "../../src/protocol/v9.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const finding: ActionableFindingV4 = {
  id: "f1",
  severity: "high",
  title: "Stale result",
  description: "The return branch reads the old value.",
  evidence: [
    {
      path: "source.ts",
      start_line: 1,
      end_line: 1,
      detail: "The old value is returned.",
    },
  ],
  suggested_direction: "Return the new value.",
  confidence: "high",
  classification: "confirmed_defect",
  external_assumptions: [],
  category: "correctness",
  verification: "Trace the return branch.",
  claim: {
    trigger: "The value changes.",
    affected_behavior: "The branch returns the prior value.",
    outcome: "The caller receives stale data.",
  },
};
const clean = (): ProviderReviewerResultV4 => ({
  schema_version: "4",
  verdict: "pass",
  review_markdown: "Complete native review",
  summary: "No defects",
  actionable_findings: [],
  informational_notes: [],
  native_scope_attestation: {
    complete: true,
    reviewed_paths: ["source.ts"],
    limitations: [],
  },
});
const failed = (
  category: ActionableFindingV4["category"] = "correctness",
): ProviderReviewerResultV4 => ({
  ...clean(),
  verdict: "fail",
  summary: "One defect",
  actionable_findings: [{ ...structuredClone(finding), category }],
});

type Scenario =
  | "finding"
  | "missing_attestation"
  | "complete_scope_caveats"
  | "incomplete_scope_caveats"
  | "disconnect"
  | "dist_mutation"
  | "nested_dist_mutation"
  | "metadata_only"
  | "same_size_content"
  | "large_binary_content"
  | "timeout"
  | "cancel"
  | "result_cleanup_error"
  | "finding_cleanup_error"
  | "duplicate_result"
  | "malformed_result_cleanup_error"
  | "adjudication_missing"
  | "adjudication_adjusted"
  | "adjudication_ordered";
async function run(scenario: Scenario) {
  const distPath =
    scenario === "nested_dist_mutation"
      ? "packages/app/dist"
      : scenario === "dist_mutation"
        ? "dist"
        : undefined;
  const root = await mkdtemp(join(tmpdir(), "mesh-native-regression-"));
  roots.push(root);
  const workspace = join(root, "project");
  await mkdir(workspace);
  await writeFile(
    join(workspace, "source.ts"),
    "return oldValue;\nconsume(value);\n",
  );
  if (scenario === "large_binary_content")
    await writeFile(
      join(workspace, "binary.dat"),
      Buffer.alloc(17 * 1024 * 1024),
    );
  if (distPath) {
    await mkdir(join(workspace, distPath), { recursive: true });
    await writeFile(join(workspace, distPath, "reviewed.js"), "before");
  }
  const adjudication = scenario.startsWith("adjudication_");
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
retry_attempts = 3
distribute_primaries = false
allow_provider_concentration = true
[diagnostics]
persist_runs = true
max_runs = 10
[adapters.native]
type = "sdk"
[agents.review]
adapter = "native"
${adjudication ? 'model_runs = [{id="primary",model="gpt-5.6",provider_group="one"},{id="judge",model="gpt-5.6",provider_group="two"}]' : 'model = "gpt-5.6"'}
purpose = "Review"
instructions = "Review"
isolation = "prefer_enforced"
timeout_ms = 10000
kind = "generic"
required_input = []
adjudication = "${adjudication ? "required" : "off"}"
pass_quorum = 1
minimum_provider_groups = 1
gate_minimum_severity = "medium"
[agents.review.applicability]
mode = "always"
[agents.review.change_coverage]
relevant_paths = ["**"]
minimum_inspection = "full_file"
proof = "native_attested"
[defaults]
agents = ["review"]
`,
  );
  const controller = new AbortController(),
    received: AdapterReviewInput[] = [];
  let cleanupCalls = 0,
    aborted = false;
  const registry = new AdapterRegistry();
  registry.register("codex", () => ({
    id: "codex",
    async probe() {
      return {
        available: true,
        authenticated: true,
        model_available: true,
        streaming: true,
        cancellation: true,
        maximumIsolation: "runtime_read_only",
        runtime_version: "fixture",
        observed_file_access: false,
        progress_observable: true,
      };
    },
    async *run(input): AsyncIterable<AdapterEvent> {
      received.push(input);
      if (scenario === "cancel") {
        controller.abort(new Error("Requested cancellation"));
        await new Promise<void>((resolve) => {
          if (input.signal.aborted) {
            aborted = true;
            resolve();
          } else
            input.signal.addEventListener(
              "abort",
              () => {
                aborted = true;
                resolve();
              },
              { once: true },
            );
        });
        return;
      }
      if (scenario === "timeout") {
        yield {
          type: "failure",
          failure: {
            reason: "timeout",
            message: "Native timed out",
            retryable: true,
          },
        };
        return;
      }
      let result: ProviderReviewerResultV4 | AdjudicationResultV2 =
        scenario === "finding" ||
        scenario === "finding_cleanup_error" ||
        scenario === "complete_scope_caveats" ||
        scenario === "incomplete_scope_caveats"
          ? failed()
          : clean();
      if (scenario === "missing_attestation")
        delete result.native_scope_attestation;
      if (scenario === "metadata_only") {
        await chmod(join(workspace, "source.ts"), 0o444);
        await chmod(join(workspace, "source.ts"), 0o666);
        await utimes(
          join(workspace, "source.ts"),
          new Date("2000-01-01T00:00:00Z"),
          new Date("2000-01-01T00:00:00Z"),
        );
      }
      if (
        scenario === "same_size_content" ||
        scenario === "large_binary_content"
      ) {
        const path = join(
            workspace,
            scenario === "large_binary_content" ? "binary.dat" : "source.ts",
          ),
          before = await stat(path);
        if (scenario === "same_size_content")
          await writeFile(path, "return newValue;\nconsume(value);\n");
        else {
          const handle = await open(path, "r+");
          try {
            await handle.write(Buffer.from([1]), 0, 1, 17 * 1024 * 1024 - 1);
          } finally {
            await handle.close();
          }
        }
        await utimes(path, before.atime, before.mtime);
      }
      if (
        scenario === "complete_scope_caveats" ||
        scenario === "incomplete_scope_caveats"
      ) {
        result.native_scope_attestation!.complete =
          scenario === "complete_scope_caveats";
        result.native_scope_attestation!.limitations = [
          "No tests were executed.",
          "This review is not exhaustive proof of correctness.",
        ];
      }
      if (distPath) {
        await writeFile(
          join(workspace, distPath, "reviewed.js"),
          "after and different",
        );
        result.native_scope_attestation!.reviewed_paths = [
          `${distPath}/reviewed.js`,
        ];
      }
      if (adjudication && input.reviewer.policy?.mode !== "adjudication") {
        result = failed(
          scenario === "adjudication_ordered" ? "lifecycle" : "correctness",
        );
        if (scenario === "adjudication_ordered")
          result.actionable_findings[0]!.evidence[0]!.end_line = 2;
      }
      if (input.reviewer.policy?.mode === "adjudication") {
        const candidate = (
          input.reviewer.policy.candidateFindings as Array<{ id: string }>
        )[0]!;
        const { id: _id, ...adjusted } = finding;
        result = {
          schema_version: "2",
          kind: "review-mesh.adjudication-result",
          verdict: "fail",
          summary: "Judge result",
          review_markdown: "Complete judge narrative",
          actionable_findings: [],
          informational_notes: [],
          decisions:
            scenario === "adjudication_missing"
              ? []
              : [
                  {
                    source_finding_id: candidate.id,
                    decision:
                      scenario === "adjudication_adjusted"
                        ? "adjusted"
                        : "confirmed",
                    rationale: "Validated the cited behavior.",
                    cited_evidence: structuredClone(finding.evidence),
                    unverified_assumptions: [],
                    ...(scenario === "adjudication_adjusted"
                      ? {
                          adjusted_finding: {
                            ...adjusted,
                            severity: "low" as const,
                          },
                        }
                      : {
                          ordered_execution_proof: {
                            steps: [
                              {
                                order: 1,
                                description: "Read the prior value.",
                                citation: finding.evidence[0]!,
                              },
                              {
                                order: 2,
                                description: "Consume the stale result.",
                                citation: {
                                  ...finding.evidence[0]!,
                                  start_line: 2,
                                  end_line: 2,
                                },
                              },
                            ],
                            failure_point: {
                              step_order: 2,
                              citation: {
                                ...finding.evidence[0]!,
                                start_line: 2,
                                end_line: 2,
                              },
                              detail: "The consumer sees stale state.",
                            },
                          },
                        }),
                  },
                ],
        };
      }
      if (scenario === "malformed_result_cleanup_error")
        result = {
          ...clean(),
          summary: 17,
        } as unknown as ProviderReviewerResultV4;
      yield { type: "result", isolation: "runtime_read_only", result };
      if (scenario === "duplicate_result")
        yield { type: "result", isolation: "runtime_read_only", result };
      if (
        scenario === "result_cleanup_error" ||
        scenario === "finding_cleanup_error" ||
        scenario === "malformed_result_cleanup_error"
      )
        throw new Error("Native cleanup failed after terminal result");
    },
    async forceCleanup() {
      cleanupCalls++;
    },
  }));
  let output = "",
    errors = "";
  const stdout = new Writable({
    write(chunk, _encoding, done) {
      const line = chunk.toString();
      if (
        scenario === "disconnect" &&
        line.includes('"event":"reviewer.completed"')
      ) {
        done(Object.assign(new Error("Pipe disconnected"), { code: "EPIPE" }));
        return;
      }
      output += line;
      done();
    },
  });
  const stderr = new PassThrough();
  stderr.on("data", (chunk) => {
    errors += chunk;
  });
  const runsDirectory = join(root, "runs");
  const code = await runReviewApplication({
    requestText: JSON.stringify({
      schema_version: "3",
      project_name: "project",
      workspace,
      instructions: "Review",
      review_scope: {
        mode: "full",
        ...(distPath ? { paths: [distPath] } : {}),
      },
    }),
    configFile,
    appPaths: {
      configFile,
      reviewersDirectory: join(root, "reviewers"),
      runsDirectory,
    },
    stdout,
    stderr,
    signal: controller.signal,
    adapterRegistry: registry,
    runIdFactory: () => "run-native",
  });
  const report = await loadV9Run(runsDirectory, "run-native");
  return {
    code,
    report,
    received,
    cleanupCalls,
    aborted,
    errors,
    events: output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  };
}

it("gates a native finding with explicit model attestation and validated citations", async () => {
  const r = await run("finding");
  expect(r.errors).toBe("");
  expect(r.code).toBe(1);
  expect(r.report?.canonical.counts.gate_eligible_subfindings).toBe(1);
});
it("keeps missing native attestation inconclusive and retains the report", async () => {
  const r = await run("missing_attestation");
  expect(r.code).toBe(3);
  expect(r.report?.reviewers[0]?.result?.review_markdown).toBe(
    "Complete native review",
  );
  expect(r.report?.run_outcome).toBe("inconclusive");
});
it("honors explicit completed scope while preserving informational review caveats", async () => {
  const r = await run("complete_scope_caveats");
  expect(r.errors).toBe("");
  expect(r.code).toBe(1);
  expect(r.report?.run_outcome).toBe("gate_findings");
  expect(r.report?.reviewers[0]).toMatchObject({
    status: "completed",
    result: {
      native_scope_attestation: {
        complete: true,
        limitations: [
          "No tests were executed.",
          "This review is not exhaustive proof of correctness.",
        ],
      },
    },
  });
});
it("keeps explicitly incomplete scope inconclusive regardless of limitation wording", async () => {
  const r = await run("incomplete_scope_caveats");
  expect(r.errors).toBe("");
  expect(r.code).toBe(3);
  expect(r.report?.run_outcome).toBe("inconclusive");
  expect(r.report?.reviewers[0]?.status).toBe("incomplete");
});
it("seals the artifact after stdout disconnects following a completed review", async () => {
  const r = await run("disconnect");
  expect(r.code).toBe(3);
  expect(r.report?.active).toBe(false);
  expect(r.report?.digest_status).toBe("verified");
  expect(r.report?.reviewers[0]?.result?.review_markdown).toBe(
    "Complete native review",
  );
});
it("detects a mutation inside an explicitly requested dist scope", async () => {
  const r = await run("dist_mutation");
  expect(r.code).toBe(3);
  expect(r.report?.run_outcome).toBe("inconclusive");
  expect(
    r.report?.records.find(
      (record) => record.record === "run.native_consistency",
    )?.data,
  ).toMatchObject({ changed: true });
});
it("ignores permission and timestamp changes when workspace bytes remain unchanged", async () => {
  const r = await run("metadata_only");
  expect(r.errors).toBe("");
  expect(r.code).toBe(0);
  expect(r.report?.run_outcome).toBe("clear");
  expect(
    r.report?.records.find(
      (record) => record.record === "run.native_consistency",
    )?.data,
  ).toMatchObject({ changed: false });
});
it.each(["same_size_content", "large_binary_content"] as const)(
  "detects %s mutations even when length and mtime are preserved",
  async (scenario) => {
    const r = await run(scenario);
    expect(r.errors).toBe("");
    expect(r.code).toBe(3);
    expect(r.report?.run_outcome).toBe("inconclusive");
    expect(
      r.report?.records.find(
        (record) => record.record === "run.native_consistency",
      )?.data,
    ).toMatchObject({
      changed: true,
      initial: { complete: true },
      final: { complete: true },
    });
  },
);
it("detects a mutation inside a nested explicitly requested dist directory", async () => {
  const r = await run("nested_dist_mutation");
  expect(r.code).toBe(3);
  expect(r.report?.run_outcome).toBe("inconclusive");
  expect(
    r.report?.records.find(
      (record) => record.record === "run.native_consistency",
    )?.data,
  ).toMatchObject({ changed: true });
});
it("normalizes adapter timeout reasons and preserves the terminal artifact", async () => {
  const r = await run("timeout");
  expect(r.errors).toBe("");
  expect(r.code).toBe(3);
  expect(r.received).toHaveLength(1);
  expect(r.events).toContainEqual(
    expect.objectContaining({
      event: "reviewer.incomplete",
      data: expect.objectContaining({ reason: "provider_timeout" }),
    }),
  );
  expect(r.report?.active).toBe(false);
});
it("cancels native work and runs cleanup before sealing a cancelled artifact", async () => {
  const r = await run("cancel");
  expect(r.code).toBe(4);
  expect(r.aborted).toBe(true);
  expect(r.cleanupCalls).toBe(1);
  expect(r.report?.run_outcome).toBe("cancelled");
  expect(r.report?.active).toBe(false);
});
it("retains a validated terminal report when the SDK cleanup throws and marks the run incomplete", async () => {
  const r = await run("result_cleanup_error");
  expect(r.errors).toBe("");
  expect(r.code).toBe(3);
  expect(r.report?.run_outcome).toBe("inconclusive");
  expect(r.report?.reviewers[0]).toMatchObject({
    status: "incomplete",
    result: { review_markdown: "Complete native review" },
  });
  expect(r.events.at(-1)).toMatchObject({
    event: "run.completed",
    data: { result_delivery: { completed_results: 1 } },
  });
  expect(r.events).toContainEqual(
    expect.objectContaining({
      event: "reviewer.incomplete",
      data: expect.objectContaining({
        failure_stage: "finalizing",
        reason: "process_crashed",
      }),
    }),
  );
});
it.each(["duplicate_result", "malformed_result_cleanup_error"] as const)(
  "does not accept %s as a clean or validated terminal result",
  async (scenario) => {
    const r = await run(scenario);
    expect(r.code).toBe(3);
    expect(r.report?.run_outcome).toBe("inconclusive");
    expect(r.report?.reviewers[0]?.result).toBeUndefined();
    expect(r.events.at(-1)).toMatchObject({
      event: "run.completed",
      data: { result_delivery: { completed_results: 0 } },
    });
  },
);
it("retains actionable findings while cleanup failure makes the run inconclusive", async () => {
  const r = await run("finding_cleanup_error");
  expect(r.code).toBe(3);
  expect(r.report?.run_outcome).toBe("inconclusive");
  expect(r.report?.reviewers[0]?.result?.actionable_findings).toHaveLength(1);
  expect(r.report?.canonical.counts.gate_eligible_subfindings).toBe(1);
  expect(r.events.at(-1)).toMatchObject({
    event: "run.completed",
    data: {
      run_outcome: "inconclusive",
      gate_outcome: "gate_findings",
      result_delivery: { completed_results: 1 },
    },
  });
});
it("retains the full judge report when required candidate decisions are missing", async () => {
  const r = await run("adjudication_missing");
  expect(r.errors).toBe("");
  expect(r.code).toBe(3);
  expect(
    r.report?.reviewers.map((reviewer) => reviewer.result?.review_markdown),
  ).toContain("Complete judge narrative");
});
it("applies adjudicator severity adjustments before computing gate findings", async () => {
  const r = await run("adjudication_adjusted");
  expect(r.errors).toBe("");
  expect(r.code).toBe(0);
  expect(r.report?.canonical.atomics[0]?.severity).toBe("low");
  expect(r.report?.canonical.counts.gate_eligible_subfindings).toBe(0);
});
it("credits a validated ordered execution proof from native adjudication", async () => {
  const r = await run("adjudication_ordered");
  expect(r.errors).toBe("");
  expect(r.code).toBe(1);
  expect(r.report?.canonical.counts.gate_eligible_subfindings).toBe(1);
});
