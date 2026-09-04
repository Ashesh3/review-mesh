import { describe, expect, it } from "vitest";
import {
  aggregateRun,
  createSuiteState,
  exitCodeFor,
  summarizeSuite,
} from "../../src/orchestrator/state.js";
import type { RunStatus } from "../../src/protocol/schemas.js";
import { validateAdjudication } from "../../src/findings/adjudication.js";
import {
  completedFail,
  completedPass,
  incomplete,
  resolvedReviewer,
  suiteState,
} from "../helpers/fixtures.js";

describe("suite state", () => {
  const precedenceCases: Array<
    [ReturnType<typeof suiteState>, RunStatus, 0 | 1 | 3]
  > = [
    [suiteState([completedPass("a"), completedPass("b")]), "passed", 0],
    [suiteState([completedPass("a"), completedFail("b")]), "findings", 1],
    [
      suiteState([completedFail("a"), incomplete("b", "timeout")]),
      "incomplete",
      3,
    ],
  ];

  it.each(precedenceCases)(
    "applies unanimous precedence",
    (state, status, exitCode) => {
      expect(aggregateRun(state).status).toBe(status);
      expect(exitCodeFor(status, false)).toBe(exitCode);
    },
  );

  it("lets incomplete override findings and interruption override the exit code", () => {
    const state = suiteState([
      completedFail("first"),
      incomplete("second", "process_crashed"),
    ]);

    expect(aggregateRun(state).status).toBe("incomplete");
    expect(exitCodeFor("passed", true)).toBe(4);
    expect(exitCodeFor("findings", true)).toBe(4);
    expect(exitCodeFor("incomplete", true)).toBe(4);
  });

  it("rejects illegal completed to reviewing transitions", () => {
    const state = createSuiteState([resolvedReviewer({ id: "a" })]);
    state.transition("a", "probing");
    state.transition("a", "starting");
    state.transition("a", "reviewing");
    state.complete("a", completedPass("a").result, "enforced_read_only");

    expect(() => state.transition("a", "reviewing")).toThrow(
      "illegal reviewer transition",
    );
  });

  it("rejects direct terminal transitions without a terminal payload", () => {
    const state = createSuiteState([resolvedReviewer({ id: "a" })]);
    state.transition("a", "probing");
    state.transition("a", "starting");
    state.transition("a", "reviewing");

    expect(() => state.transition("a", "completed" as never)).toThrow(
      "illegal reviewer transition",
    );
    expect(() => state.transition("a", "incomplete" as never)).toThrow(
      "illegal reviewer transition",
    );
    expect(
      state.complete("a", completedPass("a").result, "prompt_only").status,
    ).toBe("completed");
  });

  it("allows a successfully probed reviewer to wait before starting", () => {
    const state = createSuiteState([resolvedReviewer({ id: "a" })]);

    state.transition("a", "probing");
    state.transition("a", "queued");

    expect(state.transition("a", "starting").status).toBe("starting");
  });

  it("rejects a duplicate terminal result", () => {
    const state = createSuiteState([resolvedReviewer({ id: "a" })]);
    state.transition("a", "probing");
    state.transition("a", "starting");
    state.transition("a", "reviewing");
    state.complete("a", completedPass("a").result, "enforced_read_only");

    expect(() =>
      state.complete("a", completedPass("a").result, "enforced_read_only"),
    ).toThrow("already terminal");
  });

  it("rejects state changes for reviewers outside the resolved roster", () => {
    const state = createSuiteState([resolvedReviewer({ id: "a" })]);

    expect(() => state.transition("missing", "probing")).toThrow(
      'unknown reviewer id: "missing"',
    );
  });

  it("tracks reviewer activity and reports exact lifecycle summary counts", () => {
    const state = createSuiteState([
      resolvedReviewer({ id: "queued" }),
      resolvedReviewer({ id: "probing" }),
      resolvedReviewer({ id: "reviewing" }),
      resolvedReviewer({ id: "complete" }),
      resolvedReviewer({ id: "incomplete" }),
    ]);
    state.transition("probing", "probing");
    state.transition("reviewing", "probing");
    state.transition("reviewing", "starting");
    state.transition("reviewing", "reviewing");
    state.recordActivity("reviewing", "reading files");
    state.transition("complete", "probing");
    state.transition("complete", "starting");
    state.transition("complete", "reviewing");
    state.complete("complete", completedPass("complete").result, "prompt_only");
    state.incomplete("incomplete", {
      reason: "timeout",
      message: "Timed out.",
      retryable: true,
    });

    expect(state.reviewer("reviewing").lastActivity?.message).toBe(
      "reading files",
    );
    expect(summarizeSuite(state)).toEqual({
      total: 5,
      deferred: 0,
      queued: 1,
      running: 2,
      completed: 1,
      incomplete: 1,
      skipped: 0,
    });
  });

  it("aggregates terminal records in resolved roster order", () => {
    const state = suiteState([
      completedPass("first"),
      completedFail("second"),
      completedPass("third"),
    ]);

    expect(
      aggregateRun(state).reviewers.map((reviewer) => reviewer.reviewer_id),
    ).toEqual(["first", "second", "third"]);
  });

  it("uses the canonical unique population independently of gate thresholds", () => {
    const first = completedFail("first");
    if (first.result.schema_version !== "3") throw new Error("v3 fixture required");
    first.result.actionable_findings[0]!.title = "Shared root";
    first.result.actionable_findings[0]!.description = "First description.";
    first.result.actionable_findings[0]!.root_issue_id = "shared-root";
    const second = completedFail("second");
    if (second.result.schema_version !== "3") throw new Error("v3 fixture required");
    second.result.actionable_findings[0]!.title = "Different wording";
    second.result.actionable_findings[0]!.description = "Second description.";
    second.result.actionable_findings[0]!.root_issue_id = "shared-root";
    second.result.actionable_findings[0]!.severity = "low";
    second.result.actionable_findings[0]!.classification = "advisory";

    const aggregate = aggregateRun(suiteState([first, second]));

    expect(aggregate.rawFindings).toBe(2);
    expect(aggregate.uniqueFindings).toBe(1);
    expect(aggregate.gateFindings).toBe(1);
    expect(aggregate.advisoryFindings).toBe(0);
  });

  it("uses an adjusted advisory finding for live canonical counts while preserving the source result", () => {
    const sourceReviewer = resolvedReviewer({
      id: "reliability::source",
      agentId: "reliability",
      policy: {
        passQuorum: 1,
        minimumProviderGroups: 1,
        adjudication: "required",
        gateMinimumSeverity: "medium",
        gateMinimumConfidence: "medium",
      },
    });
    const judgeReviewer = resolvedReviewer({
      id: "reliability::judge",
      agentId: "reliability",
      policy: {
        passQuorum: 1,
        minimumProviderGroups: 1,
        adjudication: "required",
        gateMinimumSeverity: "medium",
        gateMinimumConfidence: "medium",
      },
    });
    const state = createSuiteState([sourceReviewer, judgeReviewer]);
    state.transition(sourceReviewer.id, "starting");
    state.transition(sourceReviewer.id, "reviewing");
    const candidate = completedFail(sourceReviewer.id).result;
    if (candidate.schema_version !== "3") throw new Error("v3 fixture required");
    candidate.actionable_findings[0]!.category = "correctness";
    state.complete(sourceReviewer.id, candidate, "enforced_read_only");
    state.setAdjudication(judgeReviewer.id, sourceReviewer.id);
    state.transition(judgeReviewer.id, "starting");
    state.transition(judgeReviewer.id, "reviewing");
    const adjudication = {
      schema_version: "1" as const,
      kind: "review-mesh.adjudication-result" as const,
      verdict: "pass" as const,
      review_markdown: "# Adjudication\n\nAdjusted to advisory.",
      summary: "Adjusted.",
      actionable_findings: [] as [],
      decisions: [
        {
          source_finding_id: `${sourceReviewer.id}-finding`,
          decision: "adjusted" as const,
          rationale: "The fallback avoids the defect.",
          cited_evidence: [
            {
              path: "src/reliability.ts",
              start_line: 10,
              end_line: 12,
              detail: "The fallback handles it.",
            },
          ],
          adjusted_finding: {
            severity: "low" as const,
            title: "Fallback is undocumented",
            description: "The behavior is advisory only.",
            evidence: [
              {
                path: "src/reliability.ts",
                start_line: 10,
                end_line: 12,
                detail: "The fallback handles it.",
              },
            ],
            suggested_direction: "Document it.",
            confidence: "high" as const,
            classification: "advisory" as const,
            external_assumptions: [],
          },
          unverified_assumptions: [],
        },
      ],
      informational_notes: [],
    };
    const outcome = validateAdjudication(candidate, adjudication, {
      reviewScope: "full",
    });
    state.complete(
      judgeReviewer.id,
      adjudication,
      "enforced_read_only",
      outcome,
    );

    const aggregate = aggregateRun(state);

    expect(state.reviewer(sourceReviewer.id).result).toEqual(candidate);
    expect(aggregate).toMatchObject({
      rawFindings: 1,
      uniqueFindings: 1,
      gateFindings: 0,
      advisoryFindings: 1,
      gateOutcome: "no_findings",
    });
  });

  it("uses non-default lens gate thresholds for live counts", () => {
    const strict = completedFail("strict::primary");
    if (strict.result.schema_version !== "3") throw new Error("v3 fixture required");
    strict.lens_id = "strict";
    strict.result.actionable_findings[0]!.severity = "medium";
    strict.result.actionable_findings[0]!.confidence = "high";
    const state = suiteState([strict]);
    const internal = state.reviewer("strict::primary");
    internal.reviewer.policy = {
      passQuorum: 1,
      minimumProviderGroups: 1,
      adjudication: "off",
      gateMinimumSeverity: "high",
      gateMinimumConfidence: "high",
    };

    const configured = createSuiteState([internal.reviewer]);
    configured.transition("strict::primary", "starting");
    configured.transition("strict::primary", "reviewing");
    configured.complete(
      "strict::primary",
      strict.result,
      "enforced_read_only",
    );
    const aggregate = aggregateRun(configured);

    expect(aggregate).toMatchObject({
      rawFindings: 1,
      uniqueFindings: 1,
      gateFindings: 0,
      advisoryFindings: 1,
      gateOutcome: "no_findings",
    });
  });

  it("isolates caller-owned inputs and returned snapshots from stored state", () => {
    const reviewer = resolvedReviewer({ id: "a", purpose: "original" });
    const capabilities = {
      available: true,
      authenticated: true,
      model_available: true,
      streaming: true,
      cancellation: true,
      maximumIsolation: "enforced_read_only" as const,
      message: "original",
    };
    const result = completedPass("a").result;
    const state = createSuiteState([reviewer]);
    state.transition("a", "probing");
    state.setCapabilities("a", capabilities);
    state.transition("a", "starting");
    state.transition("a", "reviewing");
    const completed = state.complete("a", result, "enforced_read_only");

    reviewer.purpose = "mutated";
    capabilities.message = "mutated";
    result.summary = "mutated";
    completed.reviewer.purpose = "snapshot mutation";
    completed.capabilities!.message = "snapshot mutation";
    completed.result!.summary = "snapshot mutation";
    completed.completedAt!.setFullYear(2000);

    const stored = state.reviewer("a");
    const aggregate = aggregateRun(state);
    expect(stored.reviewer.purpose).toBe("original");
    expect(stored.capabilities?.message).toBe("original");
    expect(stored.result?.summary).toBe("No actionable findings.");
    expect(stored.completedAt?.getFullYear()).not.toBe(2000);
    expect(aggregate.reviewers[0]?.status).toBe("completed");
    expect(
      aggregate.reviewers[0]?.status === "completed" &&
        aggregate.reviewers[0].result.summary,
    ).toBe("No actionable findings.");
  });
});
