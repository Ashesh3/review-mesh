import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { createOpenAICompatibleAdapter } from "../../src/adapters/openai-compatible.js";
import { createChangeCoverageLedger } from "../../src/context/change-coverage.js";
import { resolvedContext, resolvedReviewer } from "../helpers/fixtures.js";
import type { AdapterEvent } from "../../src/adapters/types.js";

it.each(["evidence", "synthesis", "finalization"] as const)(
  "identifies a %s HTTP failure from the actual request phase",
  async (phase) => {
    const workspace = await mkdtemp(join(tmpdir(), "mesh-segment-phase-"));
    await writeFile(join(workspace, "source.ts"), "value = 1;\n");
    const context = resolvedContext({
      workspace,
      review_scope: { mode: "full", source: "request" },
    });
    const ledger = await createChangeCoverageLedger({
      context,
      policy: {
        relevantPaths: ["**"],
        minimumInspection: "full_file",
        proof: "observed",
      },
    });
    const registration = {
      type: "openai_compatible" as const,
      base_url_env: "BASE",
      api_key_env: "KEY",
      semantic_checkpoints: true,
      context_window_tokens: 32768,
    };
    const requested: string[] = [];
    const adapter = createOpenAICompatibleAdapter(registration, {
      environment: { BASE: "https://synthetic.invalid/v1", KEY: "synthetic" },
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        const current =
          body.response_format?.json_schema?.name === "review_segment"
            ? JSON.parse(body.messages.at(-1).content).phase
            : "finalization";
        requested.push(current);
        if (current === phase)
          return Response.json(
            { error: { message: "Synthetic service failure" } },
            { status: 503 },
          );
        return Response.json({
          choices: [
            {
              message: {
                role: "assistant",
                content: JSON.stringify({
                  summary: "The given assignment retains its value.",
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
                      reasoning: "The assignment stores the number one.",
                    },
                  ],
                }),
              },
              finish_reason: "stop",
            },
          ],
        });
      },
    });
    try {
      const events: AdapterEvent[] = [];
      for await (const event of adapter.run({
        runId: "phase",
        reviewer: resolvedReviewer({ adapter: registration }),
        context,
        coverage: ledger,
        prompt: { system: "Review", user: "Review", combined: "Review" },
        resultJsonSchema: {},
        isolationPolicy: "prefer_enforced",
        signal: new AbortController().signal,
      }))
        events.push(event);
      expect(requested).toContain(phase);
      expect(events.at(-1)).toMatchObject({
        type: "failure",
        failure: {
          reason: "adapter_unavailable",
          diagnostics: { http_status: 503, operation_phase: phase },
        },
      });
      const segments = events.filter(
        (event): event is Extract<AdapterEvent, { type: "progress" }> =>
          event.type === "progress" && event.segment !== undefined,
      );
      expect(segments.length).toBeGreaterThan(0);
      if (phase === "finalization")
        expect(segments.at(-1)?.segment).toMatchObject({
          phase: "synthesis",
          completed_segments: 2,
          delivered_bytes: expect.any(Number),
          remaining_bytes: 0,
          unresolved_questions: 0,
          last_completed_checkpoint: expect.any(String),
        });
    } finally {
      await ledger.close();
      await rm(workspace, { recursive: true, force: true });
    }
  },
);
