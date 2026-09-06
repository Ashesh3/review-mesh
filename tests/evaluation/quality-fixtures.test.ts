import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import {
  createQualityFixture,
  runQualityBehavior,
  evaluateQualityReport,
} from "../../src/evaluation/quality-fixtures.js";
import { createChangeCoverageLedger } from "../../src/context/change-coverage.js";
import { resolvedContext } from "../helpers/fixtures.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

it.each(["state", "search", "eligibility"] as const)(
  "has independently failing and corrected %s behavior with an inaccessible answer key",
  async (caseId) => {
    const root = await mkdtemp(join(tmpdir(), "mesh-quality-test-"));
    roots.push(root);
    for (const variant of ["buggy", "corrected"] as const) {
      const fixture = await createQualityFixture({
        caseId,
        variant,
        directory: root,
      });
      expect(fixture.adapter_requirements).toEqual({
        semantic_checkpoints: true,
      });
      expect(fixture.request.project_name).toBe("workspace");
      expect(
        relative(fixture.workspace, fixture.oraclePath).startsWith(".."),
      ).toBe(true);
      expect(await readdir(fixture.workspace)).toEqual([
        "contract.md",
        "engine.mjs",
      ]);
      expect(JSON.stringify(fixture.request)).not.toMatch(
        /oracle|buggy|corrected|replay|cutover/,
      );
      const behavior = await runQualityBehavior(fixture.oraclePath);
      expect(behavior.some((check) => !check.matches_contract)).toBe(
        variant === "buggy",
      );
      const ledger = await createChangeCoverageLedger({
        context: resolvedContext({
          workspace: fixture.workspace,
          review_scope: { mode: "full", source: "request" },
        }),
        policy: {
          relevantPaths: ["**"],
          minimumInspection: "full_file",
          proof: "observed",
        },
      });
      expect(ledger.snapshotFiles().map((file) => file.path)).not.toContain(
        "oracle.json",
      );
      expect(
        await ledger.readFile({ path: "../private/oracle.json" }),
      ).toMatchObject({ ok: false, reason: "invalid_path" });
      await ledger.close();
    }
  },
);

it("does not award detection for keywords or a blanket pass; requires executable input, consequence and linked source finding", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-quality-score-"));
  roots.push(root);
  const fixture = await createQualityFixture({
    caseId: "state",
    variant: "buggy",
    directory: root,
  });
  const oracle = JSON.parse(await readFile(fixture.oraclePath, "utf8"));
  const check = (await runQualityBehavior(fixture.oraclePath)).find(
    (item) => !item.matches_contract,
  )!;
  const report = {
    run_id: "real-run",
    context: { workspace: fixture.workspace },
    run_outcome: "clear",
    coverage_outcome: "complete",
    reviewers: [
      {
        reviewer_id: "r",
        status: "completed",
        result: { verdict: "pass", actionable_findings: [] },
      },
    ],
    records: [] as unknown[],
  };
  expect(await evaluateQualityReport(fixture.oraclePath, report)).toMatchObject(
    {
      detection: { true_positives: 0, false_negatives: 1 },
      unsupported_clear: true,
      model_execution: "not_performed_by_evaluator",
    },
  );
  const finding = {
    id: "f",
    title: "replay cap cutover",
    description: "Everything is broken",
    evidence: [
      {
        path: "engine.mjs",
        start_line: oracle.region.start_line,
        end_line: oracle.region.end_line,
      },
    ],
    claim: {
      trigger: "Repeated key without items",
      affected_behavior: "Retained value is lost",
      outcome: "Second result changes",
    },
  };
  const failed = {
    ...report,
    run_outcome: "gate_findings",
    reviewers: [
      {
        reviewer_id: "r",
        status: "completed",
        result: { verdict: "fail", actionable_findings: [finding] },
      },
    ],
  };
  expect(
    (await evaluateQualityReport(fixture.oraclePath, failed)).detection
      .true_positives,
  ).toBe(0);
  failed.records.push({
    record: "reviewer.segment",
    reviewer_id: "r",
    data: {
      scenario_checks: [
        {
          finding_id: "f",
          path: "engine.mjs",
          start_line: oracle.region.start_line,
          end_line: oracle.region.end_line,
          input: check.input,
          expected: check.expected,
          observed: check.observed,
          reasoning:
            "The second record reads no retained value because the first empty collection stored nothing.",
        },
      ],
    },
  });
  expect(await evaluateQualityReport(fixture.oraclePath, failed)).toMatchObject(
    {
      detection: { true_positives: 1, false_negatives: 0 },
      verified_scenarios: 1,
    },
  );
  const fake = structuredClone(failed);
  (
    fake.records[0] as {
      data: { scenario_checks: Array<{ observed: unknown }> };
    }
  ).data.scenario_checks[0]!.observed = [123, 123];
  expect(
    (await evaluateQualityReport(fixture.oraclePath, fake)).detection
      .true_positives,
  ).toBe(0);
  const wrongLocation = structuredClone(failed);
  wrongLocation.reviewers[0]!.result.actionable_findings[0]!.evidence[0]!.start_line = 1;
  wrongLocation.reviewers[0]!.result.actionable_findings[0]!.evidence[0]!.end_line = 1;
  expect(
    (await evaluateQualityReport(fixture.oraclePath, wrongLocation)).detection
      .true_positives,
  ).toBe(0);
  const incomplete = structuredClone(failed);
  incomplete.reviewers[0]!.status = "incomplete";
  expect(
    (await evaluateQualityReport(fixture.oraclePath, incomplete)).detection
      .true_positives,
  ).toBe(0);
  await expect(
    evaluateQualityReport(fixture.oraclePath, {
      ...failed,
      context: { workspace: root },
    }),
  ).rejects.toThrow("exact fixture workspace");
});

it("requires runtime-checked boundary and control scenarios for a corrected pass", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-quality-pass-"));
  roots.push(root);
  const fixture = await createQualityFixture({
    caseId: "state",
    variant: "corrected",
    directory: root,
  });
  const checks = await runQualityBehavior(fixture.oraclePath);
  const report = {
    context: { workspace: fixture.workspace },
    run_outcome: "clear",
    coverage_outcome: "complete",
    reviewers: [
      {
        reviewer_id: "r",
        status: "completed",
        result: { verdict: "pass", actionable_findings: [] },
      },
    ],
    records: [
      {
        record: "reviewer.segment",
        reviewer_id: "r",
        data: {
          scenario_checks: checks.map((check) => ({
            path: "engine.mjs",
            start_line: 7,
            end_line: 7,
            input: check.input,
            expected: check.expected,
            observed: check.observed,
            reasoning:
              "The selected value is stored even when the associated collection is empty.",
          })),
        },
      },
    ],
  };
  expect(await evaluateQualityReport(fixture.oraclePath, report)).toMatchObject(
    {
      unsubstantiated_passes: 0,
      detection: { false_positives_on_control: 0, false_negatives: 0 },
    },
  );
  const nested = structuredClone(report) as unknown as {
    records: Array<{ data: Record<string, unknown> }>;
  };
  nested.records[0]!.data = {
    attempt: 1,
    segment_id: "segment-1",
    index: 0,
    phase: "evidence",
    data: report.records[0]!.data,
  };
  expect(
    (await evaluateQualityReport(fixture.oraclePath, nested))
      .verified_scenarios,
  ).toBe(checks.length);
  report.records[0]!.data.scenario_checks.shift();
  expect(
    (await evaluateQualityReport(fixture.oraclePath, report))
      .unsubstantiated_passes,
  ).toBe(1);
  const oracle = JSON.parse(await readFile(fixture.oraclePath, "utf8"));
  oracle.source_sha256 = "f".repeat(64);
  await writeFile(fixture.oraclePath, JSON.stringify(oracle));
  await expect(runQualityBehavior(fixture.oraclePath)).rejects.toThrow(
    "registered synthetic fixture",
  );
});
