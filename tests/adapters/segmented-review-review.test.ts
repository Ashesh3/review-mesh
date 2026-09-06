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
import type {
  AdapterEvent,
  AdapterReviewInput,
} from "../../src/adapters/types.js";
import { createOpenAICompatibleAdapter } from "../../src/adapters/openai-compatible.js";
import { createResultPageCollector } from "../../src/results/result-pages.js";
import { passResult } from "../helpers/fixtures.js";

async function fixture(contents: string) {
  const root = await mkdtemp(join(tmpdir(), "mesh-segment-review-"));
  await writeFile(join(root, "source.ts"), contents);
  const diff = "diff --git a/source.ts b/source.ts\n+changed\n";
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
  const coverage = await createChangeCoverageLedger({
    context,
    policy: {
      relevantPaths: ["**"],
      minimumInspection: "full_file",
      proof: "observed",
    },
  });
  const input: AdapterReviewInput = {
    runId: "review",
    reviewer: resolvedReviewer(),
    context,
    coverage,
    prompt: {
      system: "Synthetic review.",
      user: "Synthetic request.",
      combined: "",
    },
    resultJsonSchema: {},
    isolationPolicy: "prefer_enforced",
    signal: new AbortController().signal,
  };
  const state = new SegmentedReview(
    input,
    new ContextBudget(
      resolveModelBudget(undefined, { context_window_tokens: 128000 }),
    ),
  );
  return {
    state,
    coverage,
    input,
    async cleanup() {
      await coverage.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
const finding = {
  id: "kept-candidate",
  severity: "high",
  title: "Synthetic defect",
  description: "Wrong result.",
  evidence: [
    {
      path: "source.ts",
      start_line: 1,
      end_line: 1,
      detail: "Synthetic evidence.",
    },
  ],
  suggested_direction: "Fix it.",
  confidence: "high",
  classification: "confirmed_defect",
  external_assumptions: [],
  category: "correctness",
  verification: "Test it.",
  claim: {
    trigger: "The path runs.",
    affected_behavior: "A value changes.",
    outcome: "Wrong output.",
  },
};
const checkpoint = {
  summary: "Synthetic summary.",
  findings: [],
  unresolved_questions: [],
  resolved_question_ids: [],
  follow_up_reads: [],
  scenario_checks: [
    {
      path: "source.ts",
      start_line: 1,
      end_line: 1,
      input: 1,
      expected: 1,
      observed: 1,
      reasoning: "Synthetic reasoning.",
    },
  ],
};

it("preserves a valid finding from a malformed segment checkpoint through format repair", async () => {
  const f = await fixture("value = 1;\n");
  let calls = 0;
  try {
    const result = await f.state.run(async (body) => {
      calls++;
      const request = JSON.parse((body.messages as any[]).at(-1).content);
      if (calls > 1)
        expect(
          request.checkpoint.candidate_findings.map((item: any) => item.id),
        ).toContain("kept-candidate");
      return {
        message: {
          content: JSON.stringify({
            ...checkpoint,
            findings: [finding],
            ...(calls === 1 ? { scenario_checks: [] } : {}),
          }),
        },
        diagnostics: {},
      };
    });
    expect(result.findings.map((item) => item.id)).toContain("kept-candidate");
  } finally {
    await f.cleanup();
  }
});

it("retains unresolved questions from a malformed checkpoint until explicit resolution", async () => {
  const f = await fixture("value = 1;\n");
  let calls = 0;
  let repairedWithQuestion = false;
  let synthesizedWithQuestion = false;
  try {
    await f.state.run(async (body) => {
      const request = JSON.parse((body.messages as any[]).at(-1).content);
      calls++;
      if (calls > 1) {
        expect(
          request.checkpoint.unresolved_questions.map(
            (q: { id: string }) => q.id,
          ),
        ).toContain("state-question");
        if (request.phase === "synthesis") synthesizedWithQuestion = true;
        else repairedWithQuestion = true;
      }
      return {
        message: {
          content: JSON.stringify(
            calls === 1
              ? {
                  ...checkpoint,
                  scenario_checks: [],
                  unresolved_questions: [
                    {
                      id: "state-question",
                      question:
                        "Does the selected value remain durable for empty collections?",
                    },
                  ],
                }
              : {
                  ...checkpoint,
                  resolved_question_ids:
                    request.phase === "synthesis" ? ["state-question"] : [],
                },
          ),
        },
        diagnostics: {},
      };
    });
    expect(repairedWithQuestion).toBe(true);
    expect(synthesizedWithQuestion).toBe(true);
  } finally {
    await f.cleanup();
  }
});

it("reduces context after a rejected request without crediting or skipping rejected receipts", async () => {
  const source = "x".repeat(240000);
  const f = await fixture(source);
  const requests: any[] = [];
  const admitted: any[] = [];
  const initialLimit = f.state.budget.inputLimit;
  try {
    await f.state.run(async (body) => {
      const request = JSON.parse((body.messages as any[]).at(-1).content);
      requests.push(request);
      if (requests.length <= 2)
        expect(f.coverage.status().entries[0]!.delivered_byte_ranges).toEqual(
          [],
        );
      if (requests.length === 1) {
        const error = new Error("Synthetic context rejection") as Error & {
          failure: object;
        };
        error.failure = {
          reason: "adapter_unavailable",
          message: "Synthetic context rejection",
          retryable: false,
          diagnostics: {
            context_error_class: "context_too_large",
            input_tokens: 200000,
            limit_tokens: 150000,
          },
        };
        throw error;
      }
      expect(f.state.budget.fits(body)).toBe(true);
      admitted.push(
        ...request.source_ranges.filter(
          (range: any) => range.kind === "snapshot",
        ),
      );
      return {
        message: { content: JSON.stringify(checkpoint) },
        diagnostics: {},
      };
    });
    expect(f.state.budget.inputLimit).toBeLessThan(initialLimit);
    expect(f.state.budget.diagnostics().budget_source).toBe(
      "provider_feedback",
    );
    expect(requests[1].segment_id).toBe(requests[0].segment_id);
    expect(requests[1].source_ranges[0].offset).toBe(
      requests[0].source_ranges[0].offset,
    );
    let offset = 0;
    for (const receipt of admitted) {
      expect(receipt.offset).toBe(offset);
      expect(receipt.sha256).toBe(
        createHash("sha256").update(receipt.content).digest("hex"),
      );
      offset += receipt.byte_count;
    }
    expect(offset).toBe(Buffer.byteLength(source));
    expect(f.coverage.summary().status).toBe("complete");
  } finally {
    await f.cleanup();
  }
});

it("resumes completed segments after a transient failure with a fresh abort signal", async () => {
  const f = await fixture("x".repeat(240000));
  const firstController = new AbortController();
  f.state.input = { ...f.input, signal: firstController.signal };
  let calls = 0;
  let acceptedBytes = 0;
  const failed = new Error("Synthetic transport interruption");
  try {
    await expect(
      f.state.run(async (body) => {
        const request = JSON.parse((body.messages as any[]).at(-1).content);
        if (++calls === 2) throw failed;
        acceptedBytes += request.source_ranges
          .filter((range: any) => range.kind === "snapshot")
          .reduce((sum: number, range: any) => sum + range.byte_count, 0);
        return {
          message: {
            content: JSON.stringify({ ...checkpoint, findings: [finding] }),
          },
          diagnostics: {},
        };
      }),
    ).rejects.toBe(failed);
    expect(acceptedBytes).toBeGreaterThan(0);
    expect(f.coverage.status().entries[0]!.delivered_byte_ranges).toEqual([
      { offset: 0, byte_count: acceptedBytes },
    ]);
    firstController.abort();
    f.state.input = { ...f.input, signal: new AbortController().signal };
    let firstResumed = true;
    const result = await f.state.run(async (body) => {
      const request = JSON.parse((body.messages as any[]).at(-1).content);
      if (firstResumed) {
        expect(request.source_ranges[0].offset).toBe(acceptedBytes);
        expect(request.checkpoint.completed_segments).toHaveLength(1);
        expect(
          request.checkpoint.candidate_findings.map((item: any) => item.id),
        ).toContain(finding.id);
        firstResumed = false;
      }
      return {
        message: { content: JSON.stringify(checkpoint) },
        diagnostics: {},
      };
    });
    expect(result.findings.map((item) => item.id)).toContain(finding.id);
    expect(f.coverage.summary().status).toBe("complete");
  } finally {
    await f.cleanup();
  }
});

it.each(["nonpaged", "collector-instance"])(
  "%s finalization cannot omit a segmented finding",
  async (mode) => {
    const f = await fixture("x".repeat(100000));
    const registration = {
      type: "openai_compatible" as const,
      base_url_env: "BASE",
      api_key_env: "KEY",
      context_window_tokens: 65536,
      max_output_tokens: 2048,
    };
    const input: AdapterReviewInput = {
      ...f.input,
      reviewer: resolvedReviewer({ adapter: registration, model: "synthetic" }),
      ...(mode === "collector-instance"
        ? {
            resultPages: createResultPageCollector({
              resultId: "final",
              resultKind: "reviewer",
            }),
          }
        : {}),
    };
    let finalCalls = 0;
    const adapter = createOpenAICompatibleAdapter(registration, {
      environment: { BASE: "https://no-network.invalid/v1", KEY: "synthetic" },
      maxTurns: 32,
      finalizationAttempts: 1,
      fetch: (async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        let result: unknown;
        if (body.response_format?.json_schema?.name === "review_segment")
          result = { ...checkpoint, findings: [finding] };
        else {
          finalCalls++;
          if (mode === "nonpaged") result = passResult("Synthetic empty pass.");
          else {
            const last = body.messages.at(-1).content;
            const assignment = last.startsWith("{")
              ? JSON.parse(last)
              : {
                  result_id: "final",
                  page_index: 0,
                  previous_page_digest: null,
                };
            result = {
              schema_version: "1",
              kind: "review-mesh.result-page",
              result_id: assignment.result_id,
              result_kind: "reviewer",
              result_schema_version: "4",
              page_index: 0,
              page_count: 1,
              page_kind: "header",
              previous_page_digest: null,
              payload: {
                verdict: "pass",
                summary: "Synthetic empty pass.",
                informational_notes: [],
                actionable_finding_count: 0,
                narrative_fragment_count: 0,
                narrative_byte_count: 0,
              },
            };
          }
        }
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: { role: "assistant", content: JSON.stringify(result) },
                finish_reason: "stop",
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    });
    const events: AdapterEvent[] = [];
    try {
      for await (const event of adapter.run(input)) events.push(event);
      const terminal = [...events]
        .reverse()
        .find((event) => event.type === "failure" || event.type === "result");
      expect(finalCalls).toBeGreaterThan(0);
      expect(terminal).toMatchObject({
        type: "failure",
        failure: { circuit_qualifying: false },
      });
      expect(f.coverage.summary().status).toBe("complete");
      if (mode === "collector-instance")
        expect(
          (
            input.resultPages as ReturnType<typeof createResultPageCollector>
          ).draft().candidateIds,
        ).toContain(finding.id);
    } finally {
      await f.cleanup();
    }
  },
);

it("refuses a repair that drops a malformed candidate identity", async () => {
  const f = await fixture("value = 1;\n");
  let calls = 0;
  try {
    await expect(
      f.state.run(async () => ({
        message: {
          content: JSON.stringify({
            ...checkpoint,
            findings: [
              ++calls === 1
                ? { ...finding, severity: "invalid" }
                : { ...finding, id: "replacement" },
            ],
          }),
        },
        diagnostics: {},
      })),
    ).rejects.toMatchObject({
      failure: { reason: "change_coverage_incomplete" },
    });
  } finally {
    await f.cleanup();
  }
});

it("keeps malformed candidate obligations when context reduction retries the same checkpoint", async () => {
  const f = await fixture("x".repeat(100000));
  let calls = 0;
  try {
    await expect(
      f.state.run(async () => {
        calls++;
        if (calls === 2) {
          const error = new Error("Synthetic context rejection") as Error & {
            failure: object;
          };
          error.failure = {
            reason: "adapter_unavailable",
            message: "Synthetic context rejection",
            retryable: false,
            diagnostics: {
              context_error_class: "context_too_large",
              input_tokens: 200000,
              limit_tokens: 150000,
            },
          };
          throw error;
        }
        return {
          message: {
            content: JSON.stringify(
              calls === 1
                ? {
                    ...checkpoint,
                    findings: [{ ...finding, severity: "invalid" }],
                  }
                : checkpoint,
            ),
          },
          diagnostics: {},
        };
      }),
    ).rejects.toBeDefined();
  } finally {
    await f.cleanup();
  }
});

it("delivers UTF-8 source across a fixed range boundary without a false acquisition failure", async () => {
  const f = await fixture("a".repeat(16383) + "é" + "b".repeat(17000));
  try {
    await expect(
      f.state.run(async () => ({
        message: { content: JSON.stringify(checkpoint) },
        diagnostics: {},
      })),
    ).resolves.toBeDefined();
    expect(f.coverage.summary().status).toBe("complete");
  } finally {
    await f.cleanup();
  }
});

it("records the actual follow-up receipt length when a model asks beyond EOF", async () => {
  const f = await fixture("abc");
  const requests: any[] = [];
  let requestedFollowUp = false;
  try {
    await f.state.run(async (body) => {
      const payload = JSON.parse((body.messages as any[]).at(-1).content);
      requests.push(payload);
      const follow = payload.phase === "synthesis" && !requestedFollowUp;
      if (follow) requestedFollowUp = true;
      return {
        message: {
          content: JSON.stringify({
            ...checkpoint,
            follow_up_reads: follow
              ? [{ path: "source.ts", offset: 0, byte_count: 8192 }]
              : [],
          }),
        },
        diagnostics: {},
      };
    });
    for (const receipt of requests
      .flatMap((request) => request.source_ranges)
      .filter((range: any) => range.kind === "snapshot"))
      expect(receipt.byte_count).toBe(Buffer.byteLength(receipt.content));
  } finally {
    await f.cleanup();
  }
});
