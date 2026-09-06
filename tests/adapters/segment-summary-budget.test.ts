import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SegmentedReview } from "../../src/adapters/segmented-review.js";
import {
  ContextBudget,
  resolveModelBudget,
} from "../../src/adapters/context-budget.js";
import { createChangeCoverageLedger } from "../../src/context/change-coverage.js";
import { resolvedContext, resolvedReviewer } from "../helpers/fixtures.js";

it("completes 35 large files in a 64K context without losing candidates or open questions when summaries are omitted", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-summary-budget-"));
  const paths = Array.from({ length: 35 }, (_, i) => `source-${i}.txt`);
  for (const [index, path] of paths.entries())
    await writeFile(
      join(root, path),
      `source ${index}: λ deterministic evidence\n`.repeat(
        index === 0 ? 6000 : 1250,
      ),
    );
  const diff = paths
    .map((path) => `diff --git a/${path} b/${path}\n+changed\n`)
    .join("");
  const context = resolvedContext({
    workspace: root,
    git: {
      is_repository: true,
      root,
      branch: "main",
      head: "a".repeat(40),
      merge_base: "b".repeat(40),
      status_entries: [],
      changed_files: paths,
      changed_paths: paths.map((path) => ({ path, kind: "tracked" as const })),
      diff_stat: "",
      diff,
      raw_diff: {
        byte_count: Buffer.byteLength(diff),
        sha256: createHash("sha256").update(diff).digest("hex"),
      },
      truncated: {
        status_entries: false,
        changed_files: false,
        diff_stat: false,
        diff: false,
      },
    },
  });
  const coverage = await createChangeCoverageLedger({
    context,
    policy: {
      relevantPaths: ["**"],
      minimumInspection: "full_file",
      proof: "observed",
    },
  });
  const candidate = {
    id: "kept",
    severity: "high",
    title: "Synthetic candidate",
    description: "Retain all substantive findings.",
    evidence: [
      { path: paths[0]!, start_line: 1, end_line: 1, detail: "Synthetic." },
    ],
    suggested_direction: "Correct it.",
    confidence: "high",
    classification: "confirmed_defect",
    external_assumptions: [],
    category: "correctness",
    verification: "Test it.",
    claim: {
      trigger: "Input.",
      affected_behavior: "Value.",
      outcome: "Wrong.",
    },
  };
  let calls = 0,
    sawOmission = false,
    synthesis = false;
  const recorded: any[] = [];
  const state = new SegmentedReview(
    {
      runId: "summary-budget",
      reviewer: resolvedReviewer(),
      context,
      coverage,
      prompt: {
        system: "Synthetic bounded review.",
        user: "Synthetic.",
        combined: "Synthetic.",
      },
      resultJsonSchema: {},
      isolationPolicy: "prefer_enforced",
      signal: new AbortController().signal,
      recordDiagnostic: async (record) => {
        recorded.push(record);
      },
    },
    new ContextBudget(
      resolveModelBudget({
        capabilities: {
          limits: { max_context_window_tokens: 64000, max_output_tokens: 8192 },
        },
      }),
    ),
  );
  try {
    const result = await state.run(async (body) => {
      calls++;
      const payload = JSON.parse((body.messages as any[]).at(-1).content);
      if (payload.checkpoint.omitted_completed_segments > 0) {
        sawOmission = true;
        expect(payload.checkpoint.candidate_findings).toEqual([candidate]);
        expect(payload.checkpoint.unresolved_questions).toContainEqual({
          id: "cross-file",
          question: "Retain the unresolved cross-file question.",
        });
        expect(
          payload.checkpoint.completed_segments.length,
        ).toBeLessThanOrEqual(16);
        expect(
          Buffer.byteLength(
            JSON.stringify(payload.checkpoint.completed_segments),
          ),
        ).toBeLessThanOrEqual(8192);
      }
      if (payload.phase === "synthesis") synthesis = true;
      return {
        message: {
          content: JSON.stringify({
            summary:
              "Synthetic bounded-source checkpoint; quality not evaluated.",
            findings: calls === 1 ? [candidate] : [],
            unresolved_questions:
              calls === 1
                ? [
                    {
                      id: "cross-file",
                      question: "Retain the unresolved cross-file question.",
                    },
                  ]
                : [],
            resolved_question_ids:
              payload.phase === "synthesis" ? ["cross-file"] : [],
            follow_up_reads: [],
            scenario_checks: [
              {
                path:
                  payload.source_ranges.find((r: any) => r.kind === "snapshot")
                    ?.path ?? paths[0],
                start_line: 1,
                end_line: 1,
                input: 1,
                expected: 1,
                observed: 1,
                reasoning: "Synthetic infrastructure fixture only.",
              },
            ],
          }),
        },
        diagnostics: { finish_reason: "stop" },
      };
    });
    expect(sawOmission).toBe(true);
    expect(synthesis).toBe(true);
    expect(coverage.summary()).toMatchObject({
      status: "complete",
      inspected_count: 35,
    });
    expect(result.findings).toEqual([candidate]);
    expect(
      recorded.filter((record) => record.kind === "review_segment"),
    ).toHaveLength(calls);
    const final = JSON.parse(String(result.messages.at(-1)?.content));
    expect(final.checkpoint.total_completed_segments).toBe(calls);
    expect(final.checkpoint.omitted_completed_segments).toBeGreaterThan(0);
  } finally {
    await coverage.close();
    await rm(root, { recursive: true, force: true });
  }
});
