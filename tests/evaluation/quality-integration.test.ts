import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import { runReviewApplication } from "../../src/app.js";
import { AdapterRegistry } from "../../src/adapters/registry.js";
import { createOpenAICompatibleAdapter } from "../../src/adapters/openai-compatible.js";
import { readRunReport } from "../../src/diagnostics/run-report.js";
import {
  createQualityFixture,
  evaluateQualityReport,
} from "../../src/evaluation/quality-fixtures.js";

it("routes a generated full-scope request through trusted checkpoints and scores the captured constructed counterexample", async () => {
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
type="openai_compatible"
base_url_env="TEST_BASE"
api_key_env="TEST_KEY"
streaming="disabled"
semantic_checkpoints=true
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
proof="observed"
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
    const scenario = {
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
        "The first record stores nothing when its collection is empty; the next record finds no retained value.",
    };
    let segments = 0;
    const registry = new AdapterRegistry();
    registry.register("openai_compatible", (registration) =>
      createOpenAICompatibleAdapter(registration as never, {
        environment: {
          TEST_BASE: "https://fixture.invalid/v1",
          TEST_KEY: "local-only",
        },
        fetch: (async (url, init) => {
          if (String(url).endsWith("/models"))
            return Response.json({ data: [{ id: "fixture" }] });
          const body = JSON.parse(String(init?.body));
          let result: unknown;
          if (body.response_format?.json_schema?.name === "review_segment") {
            segments++;
            result = {
              summary: "The selected value can change across repeated records.",
              findings: [finding],
              unresolved_questions: [],
              resolved_question_ids: [],
              follow_up_reads: [],
              scenario_checks: [scenario],
            };
          } else {
            const assignment = [...body.messages]
              .reverse()
              .map((m: { content: string }) => {
                try {
                  return JSON.parse(m.content);
                } catch {
                  return {};
                }
              })
              .find(
                (item: any) =>
                  item.result_id && Number.isInteger(item.page_index),
              );
            if (!assignment) throw new Error("Missing result page assignment");
            result = {
              schema_version: "1",
              kind: "review-mesh.result-page",
              result_id: assignment.result_id,
              result_kind: "reviewer",
              result_schema_version: "4",
              page_index: assignment.page_index,
              page_count: 2,
              previous_page_digest: assignment.previous_page_digest,
              ...(assignment.page_index === 0
                ? {
                    page_kind: "header",
                    payload: {
                      verdict: "fail",
                      summary:
                        "A repeated empty collection changes the selected value.",
                      informational_notes: [],
                      narrative_byte_count: 0,
                      narrative_fragment_count: 0,
                      actionable_finding_count: 1,
                    },
                  }
                : {
                    page_kind: "findings",
                    payload: { actionable_findings: [finding] },
                  }),
            };
          }
          return Response.json({
            choices: [
              {
                message: { role: "assistant", content: JSON.stringify(result) },
                finish_reason: "stop",
              },
            ],
          });
        }) as typeof fetch,
      }),
    );
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
    expect(segments).toBeGreaterThanOrEqual(2);
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
