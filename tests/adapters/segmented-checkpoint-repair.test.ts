import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { SegmentedReview } from "../../src/adapters/segmented-review.js";
import {
  ContextBudget,
  resolveModelBudget,
} from "../../src/adapters/context-budget.js";
import { createChangeCoverageLedger } from "../../src/context/change-coverage.js";
import { createOpenAICompatibleAdapter } from "../../src/adapters/openai-compatible.js";
import { reviewerResultJsonSchema } from "../../src/protocol/json-schema.js";
import type { AdapterReviewInput } from "../../src/adapters/types.js";
import {
  resolvedContext,
  resolvedReviewer,
  passResult,
} from "../helpers/fixtures.js";

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
      input: 1,
      expected: 1,
      observed: 1,
      reasoning: "Synthetic reasoning.",
    },
  ],
};
const candidate = {
  id: "candidate-a",
  severity: "high",
  title: "Synthetic defect",
  description: "Original candidate description.",
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
    trigger: "Path runs.",
    affected_behavior: "Value changes.",
    outcome: "Wrong output.",
  },
};
async function fixture(large = false) {
  const root = await mkdtemp(join(tmpdir(), "mesh-checkpoint-repair-"));
  await writeFile(
    join(root, "source.ts"),
    "value = 1;\n".repeat(large ? 5000 : 1),
  );
  const diff = "diff --git a/source.ts b/source.ts\n+synthetic\n";
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
  const diagnostics: any[] = [];
  const input: AdapterReviewInput = {
    runId: "checkpoint",
    reviewer: resolvedReviewer(),
    context,
    coverage,
    prompt: {
      system: "Synthetic.",
      user: "Synthetic.",
      combined: "Synthetic.",
    },
    resultJsonSchema: reviewerResultJsonSchema,
    isolationPolicy: "prefer_enforced",
    signal: new AbortController().signal,
    recordDiagnostic: async (value) => {
      diagnostics.push(value);
    },
  };
  const state = new SegmentedReview(
    input,
    new ContextBudget(
      resolveModelBudget(undefined, { context_window_tokens: 128000 }),
    ),
  );
  return {
    input,
    state,
    coverage,
    diagnostics,
    async cleanup() {
      await coverage.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe("segmented checkpoint repair", () => {
  it.each(["parts", "fenced"])(
    "accepts supported %s checkpoint content through the real adapter",
    async (mode) => {
      const f = await fixture(true);
      const registration = {
        type: "openai_compatible" as const,
        base_url_env: "URL",
        api_key_env: "KEY",
        context_window_tokens: 32768,
      };
      f.input.reviewer = resolvedReviewer({ adapter: registration });
      const adapter = createOpenAICompatibleAdapter(registration, {
        environment: { URL: "https://no-network.invalid/v1", KEY: "synthetic" },
        fetch: async (_url, init) => {
          const body = JSON.parse(String(init?.body));
          const text = JSON.stringify(
            body.response_format.json_schema.name === "review_segment"
              ? checkpoint
              : passResult(),
          );
          const content =
            mode === "parts"
              ? [
                  { type: "text", text: text.slice(0, 20) },
                  { type: "text", text: text.slice(20) },
                ]
              : body.response_format.json_schema.name !== "review_segment"
                ? text
                : `\`\`\`json\n${text}\n\`\`\``;
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: { role: "assistant", content },
                  finish_reason: "stop",
                },
              ],
            }),
            { headers: { "content-type": "application/json" } },
          );
        },
      });
      try {
        const events = [];
        for await (const event of adapter.run(f.input)) events.push(event);
        expect(events.some((event) => event.type === "result")).toBe(true);
        expect(f.coverage.summary().status).toBe("complete");
      } finally {
        await f.cleanup();
      }
    },
  );

  it.each([
    {
      name: "null",
      content: null,
      finish: "stop",
      stage: "checkpoint_content",
      code: "provider_response_invalid",
    },
    {
      name: "json",
      content: '{"summary":"private-fragment',
      finish: "stop",
      stage: "checkpoint_json",
      code: "provider_response_invalid",
    },
    {
      name: "truncated",
      content: '{"summary":"private-fragment',
      finish: "length",
      stage: "checkpoint_truncation",
      code: "output_truncated",
    },
    {
      name: "schema",
      content: JSON.stringify({ ...checkpoint, scenario_checks: [] }),
      finish: "stop",
      stage: "checkpoint_schema",
      code: "provider_response_invalid",
    },
    {
      name: "null-truncated",
      content: null,
      finish: "length",
      stage: "checkpoint_truncation",
      code: "output_truncated",
    },
    {
      name: "empty-truncated",
      content: "",
      finish: "length",
      stage: "checkpoint_truncation",
      code: "output_truncated",
    },
  ])(
    "retains precise diagnostics for every rejected $name response",
    async ({ content, finish, stage, code }) => {
      const f = await fixture();
      let calls = 0;
      const requests: any[] = [];
      try {
        await expect(
          f.state.run(async (body) => {
            calls++;
            requests.push(body);
            return {
              message: { content },
              diagnostics: { finish_reason: finish, http_status: 200 },
            };
          }),
        ).rejects.toMatchObject({
          failure: {
            reason: code,
            circuit_qualifying: false,
            diagnostics: {
              failure_stage: stage,
              failure_code: code,
              attempt_count: 3,
              finish_reason: finish,
              response_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
              response_bytes: expect.any(Number),
            },
          },
        });
        const drafts = f.diagnostics.filter(
          (value) => value.kind === "unverified_result_draft",
        );
        expect(calls).toBe(3);
        expect(drafts).toHaveLength(3);
        for (const draft of drafts)
          expect(draft.diagnostics).toMatchObject({
            failure_stage: stage,
            finish_reason: finish,
            response_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
          });
        if (stage === "checkpoint_schema") {
          expect(drafts[0].validation_issues).toContainEqual(
            expect.objectContaining({
              path: "$.scenario_checks",
              code: "too_small",
            }),
          );
          expect(JSON.stringify(requests[1])).toContain("$.scenario_checks");
        }
        expect(JSON.stringify(f.diagnostics)).not.toContain("private-fragment");
        expect(f.coverage.summary().status).toBe("incomplete");
      } finally {
        await f.cleanup();
      }
    },
  );

  it("does not retry a filtered checkpoint as if it were a budget failure", async () => {
    const f = await fixture();
    let calls = 0;
    try {
      await expect(
        f.state.run(async () => {
          calls++;
          return {
            message: { content: null },
            diagnostics: { finish_reason: "content_filter" },
          };
        }),
      ).rejects.toMatchObject({
        failure: {
          reason: "provider_response_invalid",
          circuit_qualifying: false,
          diagnostics: {
            failure_stage: "checkpoint_filter",
            finish_reason: "content_filter",
          },
        },
      });
      expect(calls).toBe(1);
      expect(f.diagnostics).toHaveLength(1);
    } finally {
      await f.cleanup();
    }
  });

  it("preserves host-owned valid candidates through wording changes and omission during repair", async () => {
    const f = await fixture();
    let calls = 0;
    try {
      const result = await f.state.run(async () => {
        calls++;
        return {
          message: {
            content: JSON.stringify({
              ...checkpoint,
              findings:
                calls === 1
                  ? [candidate]
                  : calls === 2
                    ? [
                        {
                          ...candidate,
                          description:
                            "Reworded candidate that must not replace the original.",
                        },
                      ]
                    : [],
              ...(calls === 1 ? { scenario_checks: [] } : {}),
            }),
          },
          diagnostics: { finish_reason: "stop" },
        };
      });
      expect(result.findings).toEqual([candidate]);
      expect(
        f.diagnostics.some(
          (value) =>
            value.candidate_mutations?.[0]?.candidate_id === candidate.id,
        ),
      ).toBe(true);
    } finally {
      await f.cleanup();
    }
  });

  it("does not erase an invalid declared candidate when repair returns an empty list", async () => {
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
                findings: calls === 1 ? [candidate, { id: "unrepaired" }] : [],
              }),
            },
            diagnostics: {},
          };
        }),
      ).rejects.toMatchObject({
        failure: {
          reason: "provider_response_invalid",
          diagnostics: { failure_stage: "checkpoint_obligations" },
        },
      });
      expect(
        f.diagnostics.some((value) => value.candidate?.id === candidate.id),
      ).toBe(true);
      expect(f.coverage.summary().status).toBe("incomplete");
    } finally {
      await f.cleanup();
    }
  });

  it("retains a parseable candidate even when the provider marks the response length-limited", async () => {
    const f = await fixture();
    let calls = 0;
    try {
      const result = await f.state.run(async () => {
        calls++;
        return {
          message: {
            content: JSON.stringify({
              ...checkpoint,
              findings: calls === 1 ? [candidate] : [],
            }),
          },
          diagnostics: { finish_reason: calls === 1 ? "length" : "stop" },
        };
      });
      expect(result.findings).toEqual([candidate]);
      expect(
        f.diagnostics.some((value) => value.candidate?.id === candidate.id),
      ).toBe(true);
    } finally {
      await f.cleanup();
    }
  });

  it("repairs the actual invalid field while retaining completed evidence", async () => {
    const f = await fixture();
    let calls = 0;
    const requests: any[] = [];
    try {
      const result = await f.state.run(async (body) => {
        requests.push(body);
        calls++;
        return {
          message: {
            content: JSON.stringify({
              ...checkpoint,
              ...(calls === 1
                ? {
                    summary: "private-summary-text ".repeat(30),
                    scenario_checks: [],
                  }
                : {}),
            }),
          },
          diagnostics: { finish_reason: "stop" },
        };
      });
      expect(JSON.stringify(requests[1])).toContain("$.scenario_checks");
      const repair = JSON.parse(requests[1].messages.at(-1).content).repair;
      expect(repair).toContain(
        "$.summary: Must contain at most 512 characters.",
      );
      expect(repair).toContain(
        "$.scenario_checks: Must contain at least 1 item.",
      );
      expect(repair).not.toContain("private-summary-text");
      expect(result.findings).toEqual([]);
      expect(f.coverage.summary().status).toBe("complete");
    } finally {
      await f.cleanup();
    }
  });
});
