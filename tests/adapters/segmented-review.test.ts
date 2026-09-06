import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { createChangeCoverageLedger } from "../../src/context/change-coverage.js";
import { resolvedContext, resolvedReviewer } from "../helpers/fixtures.js";
import {
  ContextBudget,
  resolveModelBudget,
} from "../../src/adapters/context-budget.js";
import { SegmentedReview } from "../../src/adapters/segmented-review.js";
import type { AdapterReviewInput } from "../../src/adapters/types.js";

it("reviews evidence larger than one context through bounded checkpoints and final synthesis", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-segments-"));
  const data = "value = 1;\n".repeat(12000);
  await writeFile(join(root, "source.ts"), data);
  const diff = "diff --git a/source.ts b/source.ts\n+value = 1;\n";
  const context = resolvedContext({
    workspace: root,
    git: {
      is_repository: true,
      root,
      branch: "main",
      head: "a".repeat(40),
      merge_base: "b".repeat(40),
      status_entries: [],
      changed_files: ["source.ts"],
      changed_paths: [{ path: "source.ts", kind: "tracked" }],
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
  const ledger = await createChangeCoverageLedger({
    context,
    policy: {
      relevantPaths: ["**"],
      minimumInspection: "full_file",
      proof: "observed",
    },
  });
  const records: unknown[] = [];
  const input: AdapterReviewInput = {
    runId: "segments",
    reviewer: resolvedReviewer(),
    context,
    prompt: {
      system: "Inspect concrete behavior.",
      user: "Review changes.",
      combined: "",
    },
    coverage: ledger,
    resultJsonSchema: {},
    isolationPolicy: "prefer_enforced",
    signal: new AbortController().signal,
    recordDiagnostic: async (d) => {
      records.push(d);
    },
  };
  const budget = new ContextBudget(
    resolveModelBudget(undefined, {
      context_window_tokens: 32768,
      max_output_tokens: 2048,
    }),
  );
  const state = new SegmentedReview(input, budget);
  let calls = 0;
  const bodies: unknown[] = [];
  try {
    const result = await state.run(async (body) => {
      calls++;
      bodies.push(body);
      expect(budget.fits(body)).toBe(true);
      return {
        message: {
          content: JSON.stringify({
            summary: "Reviewed the given source range.",
            findings: [],
            unresolved_questions: [],
            resolved_question_ids: [],
            follow_up_reads: [],
            scenario_checks: [
              {
                path: "source.ts",
                start_line: 1,
                end_line: 1,
                input: { value: 1 },
                expected: 1,
                observed: 1,
                reasoning: "The provided assignment retains value one.",
              },
            ],
          }),
        },
        diagnostics: {},
      };
    });
    expect(calls).toBeGreaterThan(3);
    expect(result.messages.length).toBeGreaterThan(0);
    expect(ledger.summary().status).toBe("complete");
    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "review_segment", phase: "synthesis" }),
      ]),
    );
    expect(JSON.stringify(bodies.at(-1))).not.toContain(data);
  } finally {
    await ledger.close();
    await rm(root, { recursive: true, force: true });
  }
});
