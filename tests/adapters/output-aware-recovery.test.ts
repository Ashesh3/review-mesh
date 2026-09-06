import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ContextBudget,
  resolveModelBudget,
} from "../../src/adapters/context-budget.js";
import { SegmentedReview } from "../../src/adapters/segmented-review.js";
import {
  checkpointIssues,
  parseCheckpointResponse,
} from "../../src/adapters/checkpoint-response.js";
import { createChangeCoverageLedger } from "../../src/context/change-coverage.js";
import { createOpenAICompatibleAdapter } from "../../src/adapters/openai-compatible.js";
import {
  resolvedContext,
  resolvedReviewer,
  passResult,
} from "../helpers/fixtures.js";
import { reviewerResultJsonSchema } from "../../src/protocol/json-schema.js";
import type { AdapterReviewInput } from "../../src/adapters/types.js";

const checkpoint = {
  summary: "Synthetic checkpoint.",
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
      expected: 0,
      observed: 0,
      reasoning: "Synthetic static reasoning.",
    },
  ],
};
const candidate = {
  id: "kept",
  severity: "high",
  title: "Synthetic defect",
  description: "Retained original.",
  evidence: [
    { path: "source.ts", start_line: 1, end_line: 1, detail: "Synthetic." },
  ],
  suggested_direction: "Correct it.",
  confidence: "high",
  classification: "confirmed_defect",
  external_assumptions: [],
  category: "correctness",
  verification: "Test it.",
  claim: { trigger: "Input.", affected_behavior: "Value.", outcome: "Wrong." },
};
async function fixture(maximum = 32768, size = 160000) {
  const root = await mkdtemp(join(tmpdir(), "mesh-output-adaptive-"));
  await writeFile(join(root, "source.ts"), "x".repeat(size));
  const diff = "diff --git a/source.ts b/source.ts\n+x\n";
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
  const records: any[] = [];
  const input: AdapterReviewInput = {
    runId: "adaptive",
    reviewer: resolvedReviewer({ effort: "high" }),
    context,
    coverage,
    prompt: { system: "Synthetic", user: "Synthetic", combined: "Synthetic" },
    resultJsonSchema: reviewerResultJsonSchema,
    isolationPolicy: "prefer_enforced",
    signal: new AbortController().signal,
    recordDiagnostic: async (record) => {
      records.push(record);
    },
  };
  const budget = new ContextBudget(
    resolveModelBudget({
      capabilities: {
        limits: {
          max_context_window_tokens: 128000,
          max_output_tokens: maximum,
        },
      },
    }),
  );
  return {
    input,
    coverage,
    budget,
    records,
    state: new SegmentedReview(input, budget),
    async cleanup() {
      await coverage.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
describe("output-aware checkpoint recovery", () => {
  it("retains an adapted output cap across an outer retry through nonpaged finalization", async () => {
    const f = await fixture();
    const sentCaps: number[] = [];
    let segmentCalls = 0;
    let finalCap = 0;
    const registration = {
      type: "openai_compatible" as const,
      base_url_env: "URL",
      api_key_env: "KEY",
    };
    f.input.reviewer = resolvedReviewer({
      adapter: registration,
      model: "synthetic",
      effort: "high",
    });
    const adapter = createOpenAICompatibleAdapter(registration, {
      environment: { URL: "https://no-network.invalid/v1", KEY: "synthetic" },
      fetch: async (url, init) => {
        if (String(url).endsWith("/models"))
          return new Response(
            JSON.stringify({
              data: [
                {
                  id: "synthetic",
                  capabilities: {
                    limits: {
                      max_context_window_tokens: 128000,
                      max_output_tokens: 32768,
                    },
                  },
                },
              ],
            }),
            { headers: { "content-type": "application/json" } },
          );
        const body = JSON.parse(String(init?.body));
        const segment =
          body.response_format?.json_schema?.name === "review_segment";
        if (segment) {
          segmentCalls++;
          sentCaps.push(body.max_tokens);
        } else finalCap = body.max_tokens;
        if (segmentCalls === 2)
          return new Response("Synthetic temporary error", { status: 503 });
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content:
                    segment && segmentCalls === 1
                      ? '{"summary":"truncated'
                      : JSON.stringify(segment ? checkpoint : passResult()),
                },
                finish_reason:
                  segment && segmentCalls === 1 ? "length" : "stop",
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });
    try {
      await adapter.probe(f.input.reviewer, f.input.signal);
      const first = [];
      for await (const event of adapter.run(f.input)) first.push(event);
      expect(first.some((event) => event.type === "failure")).toBe(true);
      const second = [];
      for await (const event of adapter.run({
        ...f.input,
        signal: new AbortController().signal,
      }))
        second.push(event);
      expect(second.some((event) => event.type === "result")).toBe(true);
      expect(sentCaps.slice(0, 3)).toEqual([8192, 16384, 16384]);
      expect(finalCap).toBe(16384);
      expect(f.coverage.summary().status).toBe("complete");
    } finally {
      await f.cleanup();
    }
  });
  it("adapts the actual adapter request cap using model metadata and preserves safe usage", async () => {
    const f = await fixture();
    const caps: number[] = [];
    let checkpointCalls = 0;
    const registration = {
      type: "openai_compatible" as const,
      base_url_env: "URL",
      api_key_env: "KEY",
    };
    f.input.reviewer = resolvedReviewer({
      adapter: registration,
      model: "synthetic",
      effort: "high",
    });
    const adapter = createOpenAICompatibleAdapter(registration, {
      environment: { URL: "https://no-network.invalid/v1", KEY: "synthetic" },
      fetch: async (url, init) => {
        if (String(url).endsWith("/models"))
          return new Response(
            JSON.stringify({
              data: [
                {
                  id: "synthetic",
                  capabilities: {
                    limits: {
                      max_context_window_tokens: 128000,
                      max_output_tokens: 32768,
                    },
                  },
                },
              ],
            }),
            { headers: { "content-type": "application/json" } },
          );
        const body = JSON.parse(String(init?.body));
        const segment =
          body.response_format?.json_schema?.name === "review_segment";
        if (segment) {
          checkpointCalls++;
          caps.push(body.max_tokens);
          expect(body.reasoning_effort).toBe("high");
        }
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content:
                    segment && checkpointCalls === 1
                      ? '{"summary":"incomplete'
                      : JSON.stringify(segment ? checkpoint : passResult()),
                },
                finish_reason:
                  segment && checkpointCalls === 1 ? "length" : "stop",
              },
            ],
            usage: {
              prompt_tokens: 100,
              completion_tokens: segment && checkpointCalls === 1 ? 8192 : 1000,
              completion_tokens_details: { reasoning_tokens: 8000 },
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });
    try {
      await adapter.probe(f.input.reviewer, f.input.signal);
      const events = [];
      for await (const event of adapter.run(f.input)) events.push(event);
      expect(events.some((event) => event.type === "result")).toBe(true);
      expect(caps.slice(0, 2)).toEqual([8192, 16384]);
      expect(
        f.records.find((r) => r.kind === "unverified_result_draft").diagnostics,
      ).toMatchObject({
        completion_tokens: 8192,
        reasoning_tokens: 8000,
        request_output_tokens: 8192,
        model_output_truncated: true,
        output_recovery_action: "increase_output",
      });
      expect(f.coverage.summary().status).toBe("complete");
    } finally {
      await f.cleanup();
    }
  });
  it("grows output within metadata while retaining candidates, questions and rejected receipts", async () => {
    const f = await fixture();
    const caps: number[] = [];
    let calls = 0;
    try {
      const result = await f.state.run(async (body) => {
        calls++;
        caps.push(Number(body.max_tokens));
        const p = JSON.parse((body.messages as any[]).at(-1).content);
        if (calls <= 2)
          expect(
            f.coverage.status().entries[0]!.snapshot_content_delivered,
          ).toBe(false);
        if (calls > 1)
          expect(
            p.checkpoint.candidate_findings.map((x: any) => x.id),
          ).toContain("kept");
        return {
          message: {
            content: JSON.stringify({
              ...checkpoint,
              findings: calls === 1 ? [candidate] : [],
              unresolved_questions:
                calls === 1
                  ? [{ id: "q", question: "Retain this question." }]
                  : [],
              resolved_question_ids: p.phase === "synthesis" ? ["q"] : [],
            }),
          },
          diagnostics: { finish_reason: calls <= 2 ? "length" : "stop" },
        };
      });
      expect(caps.slice(0, 3)).toEqual([8192, 16384, 32768]);
      expect(result.findings).toEqual([candidate]);
      expect(f.coverage.summary().status).toBe("complete");
      expect(
        f.records.filter((r) => r.kind === "unverified_result_draft")[1]
          .diagnostics,
      ).toMatchObject({
        model_output_truncated: true,
        repair_outcome: "pending",
      });
    } finally {
      await f.cleanup();
    }
  });
  it("shrinks evidence when output is already at its ceiling and later completes all bytes", async () => {
    const f = await fixture(8192);
    const sizes: number[] = [];
    let calls = 0;
    try {
      await f.state.run(async (body) => {
        calls++;
        const p = JSON.parse((body.messages as any[]).at(-1).content);
        sizes.push(
          p.source_ranges.reduce((n: number, r: any) => n + r.byte_count, 0),
        );
        return {
          message: {
            content:
              calls <= 2
                ? '{"summary":"incomplete'
                : JSON.stringify(checkpoint),
          },
          diagnostics: { finish_reason: calls <= 2 ? "length" : "stop" },
        };
      });
      expect(sizes[1]).toBeLessThan(sizes[0]!);
      expect(sizes[2]).toBeLessThan(sizes[1]!);
      expect(f.coverage.summary().status).toBe("complete");
      expect(f.budget.model.outputTokens).toBe(8192);
    } finally {
      await f.cleanup();
    }
  });
  it("stops repeated output failures within a finite checkpoint budget without credit", async () => {
    const f = await fixture(65536);
    let calls = 0;
    const bodies: any[] = [];
    try {
      await expect(
        f.state.run(async (body) => {
          calls++;
          bodies.push(body);
          return {
            message: { content: '{"summary":"incomplete' },
            diagnostics: { finish_reason: "length" },
          };
        }),
      ).rejects.toMatchObject({
        failure: { reason: "output_truncated", circuit_qualifying: false },
      });
      expect(calls).toBeGreaterThan(3);
      expect(calls).toBeLessThanOrEqual(7);
      expect(f.coverage.summary().status).toBe("incomplete");
      expect(bodies.every((body) => body.reasoning_effort === "high")).toBe(
        true,
      );
    } finally {
      await f.cleanup();
    }
  });
  it("tries bounded compact synthesis at the ceiling without dropping pending questions", async () => {
    const f = await fixture(8192, 20);
    let syntheses = 0;
    const synthesisBodies: any[] = [];
    try {
      await expect(
        f.state.run(async (body) => {
          const p = JSON.parse((body.messages as any[]).at(-1).content);
          if (p.phase === "synthesis") {
            syntheses++;
            synthesisBodies.push(p);
            return {
              message: { content: '{"summary":"incomplete' },
              diagnostics: { finish_reason: "length" },
            };
          }
          return {
            message: {
              content: JSON.stringify({
                ...checkpoint,
                unresolved_questions: [{ id: "q", question: "Keep open." }],
              }),
            },
            diagnostics: { finish_reason: "stop" },
          };
        }),
      ).rejects.toMatchObject({ failure: { reason: "output_truncated" } });
      expect(syntheses).toBe(2);
      expect(synthesisBodies[1].repair).toContain("one concise scenario");
      expect(synthesisBodies[1].checkpoint.unresolved_questions).toContainEqual(
        { id: "q", question: "Keep open." },
      );
    } finally {
      await f.cleanup();
    }
  });
  it("does not discard invalid declared candidate obligations during adaptive output recovery", async () => {
    const f = await fixture();
    let calls = 0;
    try {
      await expect(
        f.state.run(async () => {
          calls++;
          return {
            message: {
              content: JSON.stringify({
                ...checkpoint,
                findings:
                  calls === 1 ? [candidate, { id: "invalid-kept" }] : [],
              }),
            },
            diagnostics: { finish_reason: calls === 1 ? "length" : "stop" },
          };
        }),
      ).rejects.toMatchObject({
        failure: {
          reason: "provider_response_invalid",
          diagnostics: { failure_stage: "checkpoint_obligations" },
        },
      });
      expect(f.records.some((r) => r.candidate?.id === "kept")).toBe(true);
      expect(f.coverage.summary().status).toBe("incomplete");
    } finally {
      await f.cleanup();
    }
  });
  it("reports model-output truncation independently from transport-body completeness", () => {
    expect(
      parseCheckpointResponse("{", {
        finish_reason: "length",
        truncated: false,
      }).failure?.diagnostics,
    ).toMatchObject({ model_output_truncated: true, truncated: false });
    const parsed = z
      .object({ start_line: z.number().int().positive() })
      .safeParse({ start_line: 0 });
    if (parsed.success) throw new Error("expected schema error");
    expect(checkpointIssues(parsed.error)[0]?.message).toContain("more than 0");
  });
  it("does not repeat identical minimal evidence when the output ceiling cannot grow", async () => {
    const f = await fixture(8192, 20);
    const fingerprints: string[] = [];
    try {
      await expect(
        f.state.run(async (body) => {
          const p = JSON.parse((body.messages as any[]).at(-1).content);
          fingerprints.push(JSON.stringify(p.source_ranges));
          return {
            message: { content: "{" },
            diagnostics: { finish_reason: "length" },
          };
        }),
      ).rejects.toMatchObject({ failure: { reason: "output_truncated" } });
      expect(new Set(fingerprints).size).toBe(fingerprints.length);
    } finally {
      await f.cleanup();
    }
  });
});
