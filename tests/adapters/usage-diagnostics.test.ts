import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRunArtifact,
  readRunArtifact,
} from "../../src/diagnostics/run-artifact.js";
import { createOpenAICompatibleAdapter } from "../../src/adapters/openai-compatible.js";
import { resolvedContext, resolvedReviewer } from "../helpers/fixtures.js";
import type { AdapterEvent } from "../../src/adapters/types.js";
import { sanitizeRunMetadata } from "../../src/results/sanitize.js";
import { createResultPageCollector } from "../../src/results/result-pages.js";
import { passResult } from "../helpers/fixtures.js";
import { readNormalizedRun } from "../../src/diagnostics/normalize-run.js";
import {
  v9Status,
  v9Report,
  v9DashboardRun,
} from "../../src/diagnostics/v9-views.js";

it("retains safe numeric usage on empty envelopes without retaining raw reasoning", async () => {
  const registration = {
    type: "openai_compatible" as const,
    base_url_env: "BASE",
    api_key_env: "KEY",
  };
  let responses = 0;
  const adapter = createOpenAICompatibleAdapter(registration, {
    environment: { BASE: "https://synthetic.invalid/v1", KEY: "test" },
    fetch: async () =>
      Response.json({
        choices: [],
        usage: {
          prompt_tokens: ++responses === 1 ? 400 : 500,
          completion_tokens: 8192,
          total_tokens: 8692,
          completion_tokens_details: {
            reasoning_tokens: 8000,
            raw: "private-reasoning",
          },
          prompt_tokens_details: { cached_tokens: 100 },
          extra: "private-usage",
          reasoning_text: "private-reasoning",
        },
        reasoning_opaque: "private-opaque",
      }),
  });
  const root = await mkdtemp(join(tmpdir(), "mesh-usage-"));
  const path = join(root, "usage.jsonl.active");
  const writer = await createRunArtifact({
    path,
    runId: "usage",
    toolVersion: "9.7.0",
  });
  const events: AdapterEvent[] = [];
  try {
    for await (const event of adapter.run({
      runId: "usage",
      reviewer: resolvedReviewer({ adapter: registration }),
      context: resolvedContext({ workspace: process.cwd() }),
      prompt: { system: "Review", user: "Review", combined: "Review" },
      resultJsonSchema: {},
      isolationPolicy: "prefer_enforced",
      signal: new AbortController().signal,
      recordDiagnostic: async (record) => {
        if (record.kind === "provider_response")
          await writer.record({
            record: "reviewer.response",
            reviewer_id: "usage",
            data: { attempt: 1, diagnostics: record.diagnostics },
          });
      },
    }))
      events.push(event);
    const failure = events.find((event) => event.type === "failure");
    expect(failure).toMatchObject({
      type: "failure",
      failure: {
        diagnostics: {
          prompt_tokens: 500,
          completion_tokens: 8192,
          total_tokens: 8692,
          reasoning_tokens: 8000,
          cached_tokens: 100,
          request_output_tokens: 8192,
          output_cap_source: "default",
          response_body_truncated: false,
        },
      },
    });
    expect(JSON.stringify(events)).not.toContain("private-reasoning");
    expect(JSON.stringify(events)).not.toContain("private-opaque");
    const artifact = await readRunArtifact(path, { allowActive: true });
    expect(
      artifact.records
        .filter((r) => r.record === "reviewer.response")
        .map((r) => (r.data as any).diagnostics.prompt_tokens),
    ).toEqual([400, 500]);
    expect(JSON.stringify(artifact.records)).not.toContain("private-reasoning");
    await writer.record({
      record: "reviewer.terminal",
      reviewer_id: "usage",
      data: {
        lens_id: "usage",
        status: "incomplete",
        reason: "protocol_violation",
      },
    });
    const normalized = await readNormalizedRun(path, { allowActive: true });
    for (const view of [
      v9Report(normalized),
      v9Status(normalized, undefined, true),
      v9Status(normalized, "usage"),
      v9Status(normalized, "usage", true),
      v9DashboardRun(normalized),
    ]) {
      expect((view as any).response_summary).toMatchObject({
        responses: 2,
        reported_usage_totals: { prompt_tokens: 900, reasoning_tokens: 16000 },
      });
      expect(
        (view as any).response_summary.reported_usage_totals,
      ).not.toHaveProperty("cache_creation_tokens");
    }
    const details = v9Status(normalized, "usage", true) as any;
    expect(
      details.responses.map((r: any) => r.data.diagnostics.prompt_tokens),
    ).toEqual([400, 500]);
    expect(
      details.responses.map((r: any) => r.data.diagnostics.response_sequence),
    ).toEqual([1, 2]);
  } finally {
    await writer.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("preserves only finite safe numeric usage fields through redaction", () => {
  expect(
    sanitizeRunMetadata({
      prompt_tokens: 500,
      completion_tokens: 100,
      total_tokens: 600,
      reasoning_tokens: 80,
      cached_tokens: 20,
      cache_creation_tokens: 5,
      cache_read_tokens: 20,
      request_output_tokens: 8192,
      output_ceiling_tokens: 32768,
      access_token: "private",
      completion_tokens_details: { token: "private" },
    }),
  ).toMatchObject({
    prompt_tokens: 500,
    completion_tokens: 100,
    total_tokens: 600,
    reasoning_tokens: 80,
    cached_tokens: 20,
    cache_creation_tokens: 5,
    cache_read_tokens: 20,
    request_output_tokens: 8192,
    output_ceiling_tokens: 32768,
    access_token: "[redacted]",
    completion_tokens_details: "[redacted]",
  });
});

it.each([false, true])(
  "honors the trusted output allowance for inspection and finalization (paged: %s)",
  async (paged) => {
    const registration = {
      type: "openai_compatible" as const,
      base_url_env: "BASE",
      api_key_env: "KEY",
      max_output_tokens: 32768,
    };
    const bodies: any[] = [],
      records: any[] = [];
    const adapter = createOpenAICompatibleAdapter(registration, {
      environment: { BASE: "https://synthetic.invalid/v1", KEY: "test" },
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        bodies.push(body);
        const result = body.tools
          ? "Reviewed."
          : paged
            ? {
                schema_version: "1",
                kind: "review-mesh.result-page",
                result_id: "output-cap",
                result_kind: "reviewer",
                result_schema_version: "4",
                page_index: 0,
                page_count: 1,
                previous_page_digest: null,
                page_kind: "header",
                payload: {
                  verdict: "pass",
                  summary: "Complete",
                  informational_notes: [],
                  actionable_finding_count: 0,
                  narrative_fragment_count: 0,
                  narrative_byte_count: 0,
                },
              }
            : passResult("Complete");
        return Response.json({
          choices: [
            {
              message: {
                role: "assistant",
                content:
                  typeof result === "string" ? result : JSON.stringify(result),
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        });
      },
    });
    const events: AdapterEvent[] = [];
    for await (const event of adapter.run({
      runId: "output-cap",
      reviewer: resolvedReviewer({ adapter: registration }),
      context: resolvedContext({ workspace: process.cwd() }),
      prompt: { system: "Review", user: "Review", combined: "Review" },
      resultJsonSchema: {},
      isolationPolicy: "prefer_enforced",
      signal: new AbortController().signal,
      ...(paged
        ? {
            resultPages: createResultPageCollector({
              resultId: "output-cap",
              resultKind: "reviewer",
            }),
          }
        : {}),
      recordDiagnostic: async (r) => {
        records.push(r);
      },
    }))
      events.push(event);
    expect(events.find((event) => event.type === "result")).toBeDefined();
    expect(bodies).toHaveLength(2);
    expect(bodies.map((body) => body.max_tokens)).toEqual([32768, 32768]);
    expect(
      records
        .filter((r) => r.kind === "provider_response")
        .every(
          (r) =>
            r.diagnostics.request_output_tokens === 32768 &&
            r.diagnostics.output_cap_source === "configured",
        ),
    ).toBe(true);
    const result = events.find((event) => event.type === "result");
    if (result?.type === "result") await result.resultStorage?.persisted();
  },
);
