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
import { SegmentEvidenceMemory } from "../../src/adapters/segment-evidence-memory.js";

const checkpoint = {
  summary: "Trace retained evidence.",
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
      reasoning: "The zero case remains a model hypothesis.",
    },
  ],
};
async function fixture(metadata = "W-97: preserve stable state") {
  const root = await mkdtemp(join(tmpdir(), "mesh-memory-"));
  await writeFile(
    join(root, "source.ts"),
    "export const value = 0;\n".repeat(14000),
  );
  const diff = "diff --git a/source.ts b/source.ts\n+change\n";
  const context = resolvedContext({
    workspace: root,
    caller_context: { work_item: metadata },
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
  const diagnostics: any[] = [];
  const state = new SegmentedReview(
    {
      runId: "memory",
      reviewer: resolvedReviewer(),
      context,
      coverage,
      prompt: {
        system: "Return JSON. Synthetic review.",
        user: "Synthetic",
        combined: "Synthetic",
      },
      resultJsonSchema: {},
      isolationPolicy: "prefer_enforced",
      signal: new AbortController().signal,
      recordDiagnostic: async (d) => {
        diagnostics.push(d);
      },
    },
    new ContextBudget(
      resolveModelBudget(undefined, { context_window_tokens: 128000 }),
    ),
  );
  return {
    state,
    coverage,
    diagnostics,
    cleanup: async () => {
      await coverage.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

it("carries exact bounded metadata and checkpoint-linked model facts into later evidence and final output", async () => {
  const f = await fixture();
  let calls = 0;
  try {
    const result = await f.state.run(async (body) => {
      const payload = JSON.parse((body.messages as any[]).at(-1).content);
      calls++;
      expect(payload.evidence_memory.metadata).toMatchObject({
        status: "retained",
        content: {
          caller_context: { work_item: "W-97: preserve stable state" },
        },
      });
      if (calls > 1) {
        const memory = payload.evidence_memory;
        expect(memory.delivered_ranges).toContainEqual(
          expect.objectContaining({
            kind: "context",
            path: "<caller-context>",
            complete: true,
          }),
        );
        expect(memory.scenario_facts[0]).toMatchObject({
          provenance: "model_reasoning",
          runtime_validation: "not_executed",
          check: checkpoint.scenario_checks[0],
        });
        expect(memory.scenario_facts[0].segment_id).toBeDefined();
        expect(memory.scenario_facts[0].source_link_validation).toBe(
          "path_or_diff_context_only",
        );
        expect(memory.scenario_facts[0].source_ranges).toContainEqual(
          expect.objectContaining({
            path: "source.ts",
            sha256: expect.any(String),
          }),
        );
      }
      return {
        message: { content: JSON.stringify(checkpoint) },
        diagnostics: {},
      };
    });
    expect(calls).toBeGreaterThan(3);
    const final = JSON.parse((result.messages.at(-1) as any).content);
    expect(
      final.evidence_memory.metadata.content.caller_context.work_item,
    ).toContain("W-97");
    expect(f.coverage.summary().status).toBe("complete");
  } finally {
    await f.cleanup();
  }
});

it("retains a delayed reread purpose while mandatory source progresses before it", async () => {
  const f = await fixture();
  let calls = 0,
    sawQueued = false,
    sawDelivered = false;
  try {
    await f.state.run(async (body) => {
      const p = JSON.parse((body.messages as any[]).at(-1).content);
      calls++;
      if (calls > 1 && p.phase === "evidence") {
        const request = p.evidence_memory.pending_read_obligations.find(
          (r: any) => r.question_id === "verify-meta",
        );
        expect(request).toMatchObject({
          kind: "context",
          purpose: "Reconcile metadata after source review.",
        });
        sawQueued = true;
        if (p.source_ranges.some((r: any) => r.kind === "context"))
          sawDelivered = true;
      }
      return {
        message: {
          content: JSON.stringify({
            ...checkpoint,
            unresolved_questions:
              calls === 1
                ? [{ id: "verify-meta", question: "Reconcile metadata." }]
                : [],
            follow_up_reads:
              calls === 1
                ? [
                    {
                      kind: "context",
                      offset: 0,
                      byte_count: 64,
                      question_id: "verify-meta",
                      purpose: "Reconcile metadata after source review.",
                    },
                  ]
                : [],
            resolved_question_ids: sawDelivered ? ["verify-meta"] : [],
          }),
        },
        diagnostics: {},
      };
    });
    expect(sawQueued && sawDelivered).toBe(true);
  } finally {
    await f.cleanup();
  }
});

it("links diff-only reasoning as context without claiming the cited line span was verified", () => {
  const memory = new SegmentEvidenceMemory({}, []);
  memory.remember("diff-segment", checkpoint.scenario_checks, [
    {
      kind: "diff",
      path: "<change-diff>",
      offset: 0,
      byte_count: 80,
      sha256: "a".repeat(64),
    },
  ]);
  const view = memory.view(new Map());
  expect(view.scenario_facts[0]).toMatchObject({
    source_link_validation: "path_or_diff_context_only",
    source_ranges: [{ kind: "diff", path: "<change-diff>" }],
  });
});

it("labels a fulfilled repeated range while preserving the read and its question association", async () => {
  const f = await fixture();
  let requested = false,
    sawRepeated = false;
  try {
    await f.state.run(async (body) => {
      const payload = JSON.parse((body.messages as any[]).at(-1).content);
      const follow = payload.phase === "synthesis" && !requested;
      if (follow) requested = true;
      if (payload.follow_up_results.length) {
        expect(payload.follow_up_results[0]).toMatchObject({
          already_delivered: true,
          request: {
            question_id: "check-zero",
            purpose: "Confirm the zero branch before resolving.",
          },
        });
        expect(
          payload.source_ranges.some(
            (r: any) => r.path === "source.ts" && r.offset === 0,
          ),
        ).toBe(true);
        sawRepeated = true;
      }
      return {
        message: {
          content: JSON.stringify({
            ...checkpoint,
            unresolved_questions: follow
              ? [{ id: "check-zero", question: "Confirm the zero branch." }]
              : [],
            resolved_question_ids: sawRepeated ? ["check-zero"] : [],
            follow_up_reads: follow
              ? [
                  {
                    kind: "snapshot",
                    path: "source.ts",
                    offset: 0,
                    byte_count: 80,
                    question_id: "check-zero",
                    purpose: "Confirm the zero branch before resolving.",
                  },
                ]
              : [],
          }),
        },
        diagnostics: {},
      };
    });
    expect(sawRepeated).toBe(true);
    expect(
      f.diagnostics.some(
        (d) => d.data?.follow_up_results?.[0]?.already_delivered === true,
      ),
    ).toBe(true);
  } finally {
    await f.cleanup();
  }
});

it("keeps oversized metadata explicitly available for a context read instead of truncating it into a fact", async () => {
  const f = await fixture("x".repeat(20000));
  try {
    await f.state.run(async (body) => {
      const payload = JSON.parse((body.messages as any[]).at(-1).content);
      expect(payload.evidence_memory.metadata).toMatchObject({
        status: "requires_context_read",
        path: "<caller-context>",
      });
      expect(payload.evidence_memory.metadata.content).toBeUndefined();
      expect(
        Buffer.byteLength(JSON.stringify(payload.evidence_memory)),
      ).toBeLessThanOrEqual(32768);
      return {
        message: { content: JSON.stringify(checkpoint) },
        diagnostics: {},
      };
    });
  } finally {
    await f.cleanup();
  }
});

it("bounds facts and delivery inventory with explicit omission rather than false absent claims", () => {
  const memory = new SegmentEvidenceMemory(
    { caller_context: { note: "available" } },
    [],
  );
  const delivered = new Map<string, Array<[number, number]>>();
  for (let i = 0; i < 100; i++) {
    const path = `file-${i}.ts`;
    memory.register("snapshot", path, 100);
    delivered.set(
      `snapshot:${path}`,
      Array.from({ length: 10 }, (_, j): [number, number] => [
        j * 10,
        j * 10 + 5,
      ]),
    );
    memory.remember(
      `segment-${i}`,
      [{ path, ...checkpoint.scenario_checks[0], reasoning: "a".repeat(600) }],
      [],
    );
  }
  const view = memory.view(delivered);
  expect(view.delivered_ranges).toHaveLength(64);
  expect(view.omitted_paths).toBe(36);
  expect(
    view.delivered_ranges.every((r) => r.intervals_truncated && !r.complete),
  ).toBe(true);
  expect(view.scenario_facts.length).toBeLessThanOrEqual(16);
  expect(view.omitted_scenario_facts).toBeGreaterThan(0);
  expect(Buffer.byteLength(JSON.stringify(view))).toBeLessThanOrEqual(32768);
  const tiny = memory.view(delivered, [], 1024);
  expect(Buffer.byteLength(JSON.stringify(tiny))).toBeLessThanOrEqual(1024);
  expect(tiny.omitted_paths).toBeGreaterThan(view.omitted_paths);
});
