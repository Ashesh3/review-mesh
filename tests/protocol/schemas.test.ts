import { describe, expect, it } from "vitest";
import {
  publicEventSchema,
  reviewRequestSchema,
  type ReviewerResult,
  reviewerResultSchema,
} from "../../src/protocol/schemas.js";

describe("reviewRequestSchema", () => {
  it("preserves raw instructions and arbitrary context", () => {
    const request = reviewRequestSchema.parse({
      schema_version: "1",
      request_id: "caller-7",
      workspace: "F:\\Projects\\demo",
      instructions: "Review current changes exactly as supplied.",
      scope_hints: { base: "origin/master", staged: false },
      context: { nested: { custom: [1, true, "x"] } },
    });

    expect(request.instructions).toBe(
      "Review current changes exactly as supplied.",
    );
    expect(request.context).toEqual({ nested: { custom: [1, true, "x"] } });
  });

  it("rejects reviewer selection and unknown top-level fields", () => {
    expect(() =>
      reviewRequestSchema.parse({
        schema_version: "1",
        workspace: ".",
        instructions: "review",
        reviewers: ["security-claude"],
      }),
    ).toThrow();
  });
});

describe("reviewerResultSchema", () => {
  it("accepts a clean pass", () => {
    expect(
      reviewerResultSchema.parse({
        schema_version: "1",
        verdict: "pass",
        summary: "No actionable findings.",
        actionable_findings: [],
        informational_notes: [],
      }).verdict,
    ).toBe("pass");
  });

  it("rejects a pass containing actionable findings", () => {
    expect(() =>
      reviewerResultSchema.parse({
        schema_version: "1",
        verdict: "pass",
        summary: "Contradictory",
        actionable_findings: [
          {
            id: "f-1",
            severity: "high",
            title: "Bug",
            description: "Broken invariant",
            evidence: [{ detail: "Repository-wide evidence" }],
            suggested_direction: "Restore the invariant.",
          },
        ],
        informational_notes: [],
      }),
    ).toThrow(/pass.*empty/i);
  });
});

describe("publicEventSchema", () => {
  const cleanResult: ReviewerResult = {
    schema_version: "1",
    verdict: "pass",
    summary: "No actionable findings.",
    actionable_findings: [],
    informational_notes: [],
  };

  const failedResult: ReviewerResult = {
    schema_version: "1",
    verdict: "fail",
    summary: "An actionable finding was found.",
    actionable_findings: [
      {
        id: "f-1",
        severity: "high",
        title: "Bug",
        description: "Broken invariant",
        evidence: [{ detail: "Repository-wide evidence" }],
        suggested_direction: "Restore the invariant.",
      },
    ],
    informational_notes: [],
  };

  const completedReviewer = (result: ReviewerResult = cleanResult) => ({
    reviewer_id: "reviewer-1",
    status: "completed" as const,
    adapter: "test",
    model: "test-model",
    isolation: "runtime_read_only" as const,
    elapsed_ms: 1,
    result,
  });

  const incompleteReviewer = {
    reviewer_id: "reviewer-1",
    status: "incomplete" as const,
    adapter: "test",
    model: "test-model",
    elapsed_ms: 1,
    reason: "timeout" as const,
    message: "Timed out.",
    retryable: true,
  };

  const runCompleted = (
    status: "passed" | "findings" | "incomplete",
    reviewers: readonly unknown[],
  ) => ({
    schema_version: "2",
    event: "run.completed",
    run_id: "run-1",
    seq: 1,
    timestamp: "2026-08-30T00:00:00.000Z",
    data: {
      status,
      exit_code: 0,
      consistency_mode: "live_worktree",
      total_elapsed_ms: 1,
      suite: {
        total: reviewers.length,
        queued: 0,
        running: 0,
        completed: reviewers.filter(
          (reviewer) =>
            typeof reviewer === "object" &&
            reviewer !== null &&
            "status" in reviewer &&
            reviewer.status === "completed",
        ).length,
        incomplete: reviewers.filter(
          (reviewer) =>
            typeof reviewer === "object" &&
            reviewer !== null &&
            "status" in reviewer &&
            reviewer.status === "incomplete",
        ).length,
      },
      reviewers,
    },
  });

  it("requires incomplete status when any terminal reviewer is incomplete", () => {
    expect(() =>
      publicEventSchema.parse(runCompleted("passed", [incompleteReviewer])),
    ).toThrow(/incomplete/i);
  });

  it("requires findings status when a completed reviewer fails", () => {
    expect(() =>
      publicEventSchema.parse(
        runCompleted("passed", [completedReviewer(failedResult)]),
      ),
    ).toThrow(/findings/i);
  });

  it("accepts passed status only for an all-completed clean-pass roster", () => {
    const event = publicEventSchema.parse(
      runCompleted("passed", [completedReviewer(cleanResult)]),
    );
    if (event.event !== "run.completed") {
      throw new Error("expected a run.completed event");
    }
    expect(event.data.status).toBe("passed");
  });

  it("accepts resolved suite and reviewer startup metadata", () => {
    const envelope = {
      schema_version: "2" as const,
      run_id: "run-1",
      request_id: "request-1",
      seq: 1,
      timestamp: "2026-08-30T00:00:00.000Z",
    };

    expect(
      publicEventSchema.parse({
        ...envelope,
        event: "suite.resolved",
        data: {
          total: 1,
          execution: {
            max_concurrency: 2,
            heartbeat_interval_ms: 15_000,
            shutdown_grace_period_ms: 5_000,
          },
          selection: {
            source: "project",
            matched_project_path: "/work/project",
          },
          reviewers: [
            {
              id: "reviewer-1",
              purpose: "Review correctness",
              adapter: "gateway",
              adapter_type: "openai_compatible",
              model: "test-model",
              effort: "high",
              isolation_policy: "prefer_enforced",
              timeout_ms: 900_000,
              instruction_sources: ["trusted", "project"],
            },
          ],
        },
      }).event,
    ).toBe("suite.resolved");

    expect(
      publicEventSchema.parse({
        ...envelope,
        event: "reviewer.started",
        reviewer_id: "reviewer-1",
        data: {
          purpose: "Review correctness",
          adapter: "gateway",
          model: "test-model",
          effort: "high",
          isolation_policy: "prefer_enforced",
          timeout_ms: 900_000,
        },
      }).event,
    ).toBe("reviewer.started");
  });
});
