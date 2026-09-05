import { describe, expect, it } from "vitest";
import { publicEventV6Schema } from "../../src/protocol/v9.js";

const envelope = {
  schema_version: "6",
  run_id: "run-1",
  seq: 1,
  timestamp: "2026-09-05T00:00:00.000Z",
};
describe("v6 lifecycle payload contracts", () => {
  it("accepts typed reviewer progress while rejecting arbitrary fields", () => {
    const event = {
      ...envelope,
      reviewer_id: "reviewer-1",
      event: "reviewer.progress",
      data: {
        lens_id: "lens-1",
        mode: "full_review",
        phase: "retry_backoff",
        attempt: 1,
        maximum_attempts: 2,
      },
    };
    expect(publicEventV6Schema.safeParse(event).success).toBe(true);
    expect(
      publicEventV6Schema.safeParse({
        ...event,
        data: { ...event.data, provider_response: "private" },
      }).success,
    ).toBe(false);
  });
  it("exposes context and deadline resolution without raw diffs or instructions", () => {
    expect(
      publicEventV6Schema.safeParse({
        ...envelope,
        event: "context.resolved",
        data: {
          project_name: "demo",
          review_scope: "changes",
          changed_files_count: 5,
          diff_byte_count: 23285,
          truncated: false,
          detail_ref: "context",
        },
      }).success,
    ).toBe(true);
    expect(
      publicEventV6Schema.safeParse({
        ...envelope,
        event: "suite.resolved",
        data: {
          logical_lenses: 1,
          model_runs: 2,
          deadline: {
            mode: "adaptive",
            tier: "small",
            duration_ms: 1800000,
            started_at: envelope.timestamp,
            deadline_at: "2026-09-05T00:30:00.000Z",
            inputs: {
              review_scope: "changes",
              changed_file_count: 5,
              raw_diff_byte_count: 23285,
              changed_files_truncated: false,
              diff_truncated: false,
            },
          },
          warnings: [],
          detail_ref: "resolution",
        },
      }).success,
    ).toBe(true);
  });
});
