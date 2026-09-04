import { mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readRunReport } from "../../src/diagnostics/run-report.js";
import { readRunStatus } from "../../src/diagnostics/run-status.js";
import type { ReviewerResultV3 } from "../../src/protocol/schemas.js";
import { reviewerResultDigest } from "../../src/results/digest.js";
import {
  readDashboardRun,
  readDashboardSnapshot,
} from "../../src/server/dashboard-data.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("large immutable run artifacts", () => {
  it("strictly reads every legal result after the artifact exceeds 64 MiB", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-mesh-large-artifact-"));
    roots.push(root);
    const runsDirectory = join(root, "runs");
    await mkdir(runsDirectory);
    const runId = "run-over-64-mib";
    const reviewers = Array.from(
      { length: 5 },
      (_, index) => `reviewer-${index + 1}`,
    );
    const handle = await open(join(runsDirectory, `${runId}.jsonl`), "w");
    try {
      await handle.appendFile(
        `${JSON.stringify({
          record: "resolution",
          run_id: runId,
          resolution: {
            execution: {
              max_concurrency: 1,
              heartbeat_interval_ms: 1_000,
              shutdown_grace_period_ms: 1_000,
              continuation_attempts: 2,
            },
            reviewers: reviewers.map((id) => ({ id, agent_id: id })),
          },
        })}\n`,
      );
      for (const [index, reviewerId] of reviewers.entries()) {
        const marker = `complete-review-${index + 1}`;
        const result: ReviewerResultV3 = {
          schema_version: "3",
          verdict: "pass",
          review_markdown: `# ${marker}\n\n${String(index).repeat(13 * 1024 * 1024)}`,
          summary: "No findings.",
          actionable_findings: [],
          informational_notes: [],
        };
        await handle.appendFile(
          `${JSON.stringify({
            record: "reviewer.result",
            run_id: runId,
            reviewer_id: reviewerId,
            digest: reviewerResultDigest(result),
            byte_count: Buffer.byteLength(JSON.stringify(result), "utf8"),
            result,
          })}\n`,
        );
      }
    } finally {
      await handle.close();
    }

    const status = await readRunStatus({ runsDirectory, runId });
    const statusReviewers = status.reviewers as Array<{
      complete_result: { review_markdown: string };
    }>;
    expect(statusReviewers).toHaveLength(5);
    expect(statusReviewers[4]!.complete_result.review_markdown).toContain(
      "complete-review-5",
    );

    const report = await readRunReport({ runsDirectory, runId });
    expect(report.reviewers).toHaveLength(5);
    const reportResult = report.reviewers[4]?.result;
    expect(
      reportResult !== undefined && "review_markdown" in reportResult
        ? reportResult.review_markdown
        : undefined,
    ).toContain("complete-review-5");

    const dashboard = await readDashboardRun({
      appPaths: {
        configFile: join(root, "config.toml"),
        reviewersDirectory: join(root, "reviewers"),
        runsDirectory,
      },
      runId,
    });
    const dashboardReviewers = dashboard.reviewers as Array<{
      result: { review_markdown: string };
    }>;
    expect(dashboardReviewers).toHaveLength(5);
    expect(dashboardReviewers[4]!.result.review_markdown).toContain(
      "complete-review-5",
    );

    await open(join(root, "config.toml"), "w").then((file) => file.close());
    const snapshot = await readDashboardSnapshot({
      appPaths: {
        configFile: join(root, "config.toml"),
        reviewersDirectory: join(root, "reviewers"),
        runsDirectory,
      },
      server: {
        host: "127.0.0.1",
        port: 1,
        startedAt: new Date().toISOString(),
      },
    });
    expect(JSON.stringify(snapshot)).not.toContain("complete-review-5");
  }, 60_000);
});
