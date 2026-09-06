import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import { runReviewApplication } from "../../src/app.js";
import { AdapterRegistry } from "../../src/adapters/registry.js";
import { readRunReport } from "../../src/diagnostics/run-report.js";
import {
  createQualityFixture,
  evaluateQualityReport,
} from "../../src/evaluation/quality-fixtures.js";

it("routes a generated full-scope request through native SDK submission and scores the captured counterexample", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-quality-app-"));
  try {
    const fixture = await createQualityFixture({
      caseId: "state",
      variant: "buggy",
      directory: root,
    });
    const configFile = join(root, "config.toml");
    await writeFile(
      configFile,
      `schema_version="7"
[execution]
max_concurrency=1
heartbeat_interval_ms=1000
shutdown_grace_period_ms=1000
deadline_mode="adaptive"
no_progress_timeout_ms=30000
[diagnostics]
persist_runs=true
max_runs=10
[adapters.test]
type="sdk"
base_url_env="TEST_BASE"
api_key_env="TEST_KEY"


[agents.test]
adapter="test"
model="fixture"
purpose="Review"
instructions="Review the documented behavior."
isolation="prefer_enforced"
timeout_ms=30000
kind="generic"
required_input=[]
adjudication="off"
[agents.test.applicability]
mode="always"
[agents.test.change_coverage]
relevant_paths=["**"]
minimum_inspection="full_file"
proof="native_attested"
[defaults]
agents=["test"]
`,
    );
    const finding = {
      id: "f",
      severity: "medium",
      title: "Empty collection omits retained selection",
      description:
        "A repeated key chooses a later value after an empty associated collection.",
      evidence: [
        {
          path: "engine.mjs",
          start_line: 7,
          end_line: 7,
          detail: "The state update is conditional on associated items.",
        },
      ],
      suggested_direction: "Retain the first selection independently of items.",
      confidence: "high",
      classification: "confirmed_defect",
      external_assumptions: [],
      category: "correctness",
      verification: "Trace the two records in sequence.",
      claim: {
        trigger:
          "Same key with different values and an initially empty collection.",
        affected_behavior: "The first choice is not retained.",
        outcome: "The later record returns a different value.",
      },
    };
    let reviews = 0;
    const scenarios = [
      {
        path: "engine.mjs",
        start_line: 7,
        end_line: 7,
        finding_id: "f",
        input: {
          events: [
            { key: "q", value: 8, items: [] },
            { key: "q", value: 9, items: [] },
          ],
        },
        expected: [8, 8],
        observed: [8, 9],
        reasoning:
          "The first empty collection prevents retaining its selected value, so the later record selects its own proposed value.",
      },
    ];
    const registry = new AdapterRegistry();
    registry.register("copilot", () => ({
      id: "copilot",
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
      async *run(input) {
        reviews++;
        expect(input.coverage).toBeUndefined();
        expect(input.resultPages).toBeUndefined();
        yield {
          type: "result" as const,
          isolation: "runtime_read_only" as const,
          result: {
            schema_version: "4" as const,
            verdict: "fail" as const,
            review_markdown:
              "The first selection is not retained after an empty collection.\n\n```review-mesh-scenarios\n" +
              JSON.stringify(scenarios) +
              "\n```",
            summary: "Empty collection loses state",
            actionable_findings: [finding as never],
            informational_notes: [],
            native_scope_attestation: {
              complete: true,
              reviewed_paths: ["engine.mjs"],
              limitations: [],
            },
          },
        };
      },
    }));
    const stdout = new PassThrough(),
      stderr = new PassThrough();
    stdout.resume();
    let error = "";
    stderr.on("data", (c) => {
      error += String(c);
    });
    const appPaths = {
      configFile,
      reviewersDirectory: join(root, "reviewers"),
      runsDirectory: join(root, "runs"),
    };
    const code = await runReviewApplication({
      requestText: JSON.stringify(fixture.request),
      configFile,
      appPaths,
      stdout,
      stderr,
      signal: new AbortController().signal,
      adapterRegistry: registry,
      runIdFactory: () => "quality-integration",
    });
    expect(error).toBe("");
    expect(code).toBe(1);
    expect(reviews).toBe(1);
    const report = await readRunReport({
      runsDirectory: appPaths.runsDirectory,
      runId: "quality-integration",
      includeRaw: true,
    });
    expect(
      await evaluateQualityReport(fixture.oraclePath, report),
    ).toMatchObject({
      model_execution: "not_performed_by_evaluator",
      detection: { true_positives: 1, false_negatives: 0 },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
