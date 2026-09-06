import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { createChangeCoverageLedger } from "../../src/context/change-coverage.js";
import { resolvedContext, resolvedReviewer } from "../helpers/fixtures.js";
import {
  ContextBudget,
  resolveModelBudget,
} from "../../src/adapters/context-budget.js";
import { SegmentedReview } from "../../src/adapters/segmented-review.js";
import { buildReviewerPrompt } from "../../src/protocol/prompt.js";
import type {
  AdapterDiagnostic,
  AdapterReviewInput,
} from "../../src/adapters/types.js";

const checkpoint = {
  summary: "Retain partial evidence, not a pass.",
  findings: [],
  unresolved_questions: [],
  resolved_question_ids: [],
  follow_up_reads: [],
  scenario_checks: [
    {
      path: "source.ts",
      start_line: 1,
      end_line: 1,
      input: 0,
      expected: 1,
      observed: 0,
      reasoning: "Synthetic static hypothesis, not execution.",
    },
  ],
};
async function fixture(
  metadata = "Supplied work item W-123",
  source = "const value = 0;\n".repeat(15000),
) {
  const root = await mkdtemp(join(tmpdir(), "mesh-followup-"));
  await writeFile(join(root, "source.ts"), source);
  const diff =
    "diff --git a/source.ts b/source.ts\n" +
    "+const value = 0;\n".repeat(15000);
  const context = resolvedContext({
    workspace: root,
    caller_context: { marker: metadata },
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
  const coverage = await createChangeCoverageLedger({
    context,
    policy: {
      relevantPaths: ["**"],
      minimumInspection: "full_file",
      proof: "observed",
    },
  });
  const diagnostics: AdapterDiagnostic[] = [];
  const input: AdapterReviewInput = {
    runId: "test",
    reviewer: resolvedReviewer(),
    context,
    coverage,
    prompt: {
      system: "Synthetic review",
      user: "Synthetic request",
      combined: "",
    },
    resultJsonSchema: {},
    isolationPolicy: "prefer_enforced",
    signal: new AbortController().signal,
    recordDiagnostic: async (d) => {
      diagnostics.push(d);
    },
  };
  return {
    state: new SegmentedReview(
      input,
      new ContextBudget(
        resolveModelBudget(undefined, { context_window_tokens: 1000000 }),
      ),
    ),
    diagnostics,
    coverage,
    cleanup: async () => {
      await coverage.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

it("delivers caller metadata and changed-file inventory before partial diff review", async () => {
  const f = await fixture();
  let first: any;
  try {
    await f.state.run(async (body) => {
      const payload = JSON.parse((body.messages as any[]).at(-1).content);
      first ??= payload;
      return {
        message: { content: JSON.stringify(checkpoint) },
        diagnostics: {},
      };
    });
    expect(first.source_ranges[0].kind).toBe("context");
    expect(first.source_ranges[0].content).toContain("W-123");
    expect(first.source_ranges[0].content).toContain(
      '"changed_files":["source.ts"]',
    );
    expect(first.input_manifest.caller_context.status).toBe("delivered");
    expect(first.input_manifest.change_diff.status).toBe("partially_delivered");
    expect(f.coverage.summary().status).toBe("complete");
  } finally {
    await f.cleanup();
  }
});

it("preserves arbitrary follow-up bytes starting inside a UTF-8 code point", async () => {
  const f = await fixture("meta", "é".repeat(100));
  let requested = false;
  let delivered = false;
  try {
    await f.state.run(async (body) => {
      const payload = JSON.parse((body.messages as any[]).at(-1).content);
      const follow = !requested && payload.phase === "synthesis";
      if (follow) requested = true;
      for (const range of payload.source_ranges)
        if (range.path === "source.ts" && range.offset === 1) {
          expect(range.content).toBe(
            "base64:" +
              Buffer.from("é".repeat(100)).subarray(1, 21).toString("base64"),
          );
          expect(range.byte_count).toBe(20);
          delivered = true;
        }
      return {
        message: {
          content: JSON.stringify({
            ...checkpoint,
            follow_up_reads: follow
              ? [{ path: "source.ts", offset: 1, byte_count: 20 }]
              : [],
          }),
        },
        diagnostics: {},
      };
    });
    expect(delivered).toBe(true);
    expect(f.coverage.summary().status).toBe("complete");
  } finally {
    await f.cleanup();
  }
});

it("keeps checkpoints and mandatory ranges across mixed optional read errors and correction", async () => {
  const f = await fixture();
  const payloads: any[] = [];
  try {
    await f.state.run(async (body) => {
      const payload = JSON.parse((body.messages as any[]).at(-1).content);
      payloads.push(payload);
      return {
        message: {
          content: JSON.stringify({
            ...checkpoint,
            unresolved_questions:
              payloads.length === 1
                ? [
                    {
                      id: "cross-file",
                      question: "Inspect the continuation before concluding.",
                    },
                  ]
                : [],
            resolved_question_ids: [
              ...(payload.phase === "synthesis" ? ["cross-file"] : []),
              ...(payload.follow_up_results ?? [])
                .filter((r: any) => r.status === "rejected")
                .map((r: any) => r.error_id),
            ],
            follow_up_reads:
              payloads.length === 1
                ? [
                    { path: "<change-diff>", offset: 131072, byte_count: 8192 },
                    { kind: "context", offset: 0, byte_count: 8192 },
                    { path: "./source.ts", offset: 0, byte_count: 8192 },
                    { path: "missing.ts", offset: 0, byte_count: 8192 },
                    { path: "source.ts", offset: 99999999, byte_count: 8192 },
                    { path: "../outside.ts", offset: 0, byte_count: 8192 },
                  ]
                : payloads.length === 2
                  ? [{ path: "source.ts", offset: 8192, byte_count: 8192 }]
                  : [],
          }),
        },
        diagnostics: {},
      };
    });
    expect(payloads[1].follow_up_results.map((r: any) => r.status)).toEqual([
      "queued",
      "queued",
      "queued",
      "rejected",
      "rejected",
      "rejected",
    ]);
    expect(
      payloads[1].follow_up_results.map((r: any) => r.reason).filter(Boolean),
    ).toEqual(["not_in_snapshot", "invalid_range", "invalid_path"]);
    expect(payloads[1].checkpoint.completed_segments).toHaveLength(1);
    expect(payloads[1].checkpoint.unresolved_questions).toHaveLength(4);
    expect(payloads.at(-1).phase).toBe("synthesis");
    expect(f.coverage.summary().status).toBe("complete");
    const segment: any = f.diagnostics.find((d) => d.kind === "review_segment");
    expect(segment.data.follow_up_reads).toHaveLength(6);
    expect(segment.data.follow_up_results).toHaveLength(6);
  } finally {
    await f.cleanup();
  }
});

it("returns an invalid synthesis read to the model rather than silently finalizing", async () => {
  const f = await fixture();
  let syntheses = 0;
  try {
    await f.state.run(async (body) => {
      const payload = JSON.parse((body.messages as any[]).at(-1).content);
      if (payload.phase === "synthesis") syntheses++;
      if (syntheses === 2)
        expect(payload.follow_up_results[0].reason).toBe("not_in_snapshot");
      return {
        message: {
          content: JSON.stringify({
            ...checkpoint,
            resolved_question_ids: (payload.follow_up_results ?? [])
              .filter((r: any) => r.status === "rejected")
              .map((r: any) => r.error_id),
            follow_up_reads:
              payload.phase === "synthesis" && syntheses === 1
                ? [{ path: "missing.ts" }]
                : [],
          }),
        },
        diagnostics: {},
      };
    });
    expect(syntheses).toBe(2);
  } finally {
    await f.cleanup();
  }
});

it("does not silently erase a rejected read obligation on an empty next checkpoint", async () => {
  const f = await fixture();
  let requested = false;
  try {
    await expect(
      f.state.run(async (body) => {
        const payload = JSON.parse((body.messages as any[]).at(-1).content);
        const follow = !requested && payload.phase === "synthesis";
        if (follow) requested = true;
        return {
          message: {
            content: JSON.stringify({
              ...checkpoint,
              follow_up_reads: follow ? [{ path: "missing.ts" }] : [],
            }),
          },
          diagnostics: {},
        };
      }),
    ).rejects.toThrow("unresolved review obligations");
  } finally {
    await f.cleanup();
  }
});

it("uses host manifest coverage instead of requiring an unavailable coverage_status tool", async () => {
  const f = await fixture();
  try {
    f.state.input.reviewer.policy = {
      ...f.state.input.reviewer.policy,
      changeCoverage: {
        proof: "observed",
        minimumInspection: "full_file",
        relevantPaths: ["**"],
      },
    } as any;
    const prompt = buildReviewerPrompt({
      reviewer: f.state.input.reviewer,
      context: f.state.input.context,
      coverage: {
        scopeDigest: f.coverage.scopeDigest,
        relevantPaths: ["source.ts"],
      },
    });
    const state = new SegmentedReview(
      { ...f.state.input, prompt },
      new ContextBudget(
        resolveModelBudget(undefined, { context_window_tokens: 1000000 }),
      ),
    );
    const result = await state.run(async (body) => {
      expect(body.tools).toBeUndefined();
      expect((body.messages as any[])[0].content).toContain(
        "No callable tools are exposed in this segmented workflow",
      );
      expect((body.messages as any[])[0].content).not.toContain(
        "Call coverage_status before finalizing",
      );
      const payload = JSON.parse((body.messages as any[]).at(-1).content);
      if (payload.phase === "synthesis")
        expect(payload.input_manifest.snapshot.status).toBe("delivered");
      return {
        message: { content: JSON.stringify(checkpoint) },
        diagnostics: {},
      };
    });
    expect(
      JSON.parse((result.messages.at(-1) as any).content).input_manifest
        .snapshot.status,
    ).toBe("delivered");
  } finally {
    await f.cleanup();
  }
});

it("marks large metadata partial and keeps diff queued until all metadata is in view", async () => {
  const f = await fixture("meta".repeat(40000));
  let calls = 0;
  try {
    await f.state.run(async (body) => {
      const payload = JSON.parse((body.messages as any[]).at(-1).content);
      if (++calls === 1) {
        expect(
          payload.source_ranges.every((r: any) => r.kind === "context"),
        ).toBe(true);
        expect(payload.input_manifest.caller_context.status).toBe(
          "partially_delivered",
        );
        expect(payload.input_manifest.change_diff.status).toBe("queued");
        expect(payload.instruction).toContain("not absent");
      }
      return {
        message: { content: JSON.stringify(checkpoint) },
        diagnostics: {},
      };
    });
  } finally {
    await f.cleanup();
  }
});
