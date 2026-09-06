import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createOpenAICompatibleAdapter } from "../../src/adapters/openai-compatible.js";
import { resolvedContext, resolvedReviewer } from "../helpers/fixtures.js";
import { resultPageJsonSchema } from "../../src/protocol/json-schema.js";
import type {
  AdapterEvent,
  AdapterReviewInput,
} from "../../src/adapters/types.js";

const ids = ["candidate-a", "candidate-b"];
const envelope = {
  schema_version: "1",
  kind: "review-mesh.result-page",
  result_id: "adjudication",
  result_kind: "adjudication",
  result_schema_version: "2",
};
const header = JSON.stringify({
  ...envelope,
  page_index: 0,
  page_count: 1,
  previous_page_digest: null,
  page_kind: "header",
  payload: {
    verdict: "fail",
    summary: "Synthetic adjudication.",
    review_markdown: "Synthetic.",
    informational_notes: [],
    candidate_count: 0,
    candidate_ids_digest: "0".repeat(64),
  },
});
const decision = (id: string) => ({
  source_finding_id: id,
  decision: "confirmed",
  rationale: "Synthetic evidence.",
  cited_evidence: [],
  unverified_assumptions: [],
});
const page = (items: unknown[]) =>
  JSON.stringify({
    ...envelope,
    page_index: 1,
    page_count: 1,
    previous_page_digest: createHash("sha256").update(header).digest("hex"),
    page_kind: "decisions",
    payload: { decisions: items },
  });
async function run(items: string[]) {
  const requests: any[] = [],
    drafts: any[] = [];
  const registration = {
    type: "openai_compatible" as const,
    base_url_env: "URL",
    api_key_env: "KEY",
  };
  const adapter = createOpenAICompatibleAdapter(registration, {
    environment: { URL: "https://no-network.invalid/v1", KEY: "synthetic" },
    finalizationAttempts: 1,
    fetch: (async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      if (items.length === 0) throw new Error("Unexpected synthetic request");
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: { role: "assistant", content: items.shift() },
              finish_reason: "stop",
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch,
  });
  const input: AdapterReviewInput = {
    runId: `adjudication-${Date.now()}`,
    reviewer: resolvedReviewer({ adapter: registration, model: "synthetic" }),
    context: resolvedContext({ workspace: process.cwd() }),
    prompt: {
      system: "Synthetic.",
      user: "Inspect synthetic source.",
      combined: "Synthetic.",
    },
    resultJsonSchema: resultPageJsonSchema,
    resultPages: {
      resultId: envelope.result_id,
      resultKind: "adjudication",
      candidateIds: ids,
    },
    isolationPolicy: "prefer_enforced",
    signal: new AbortController().signal,
    recordDiagnostic: async (value) => {
      drafts.push(value);
    },
  };
  const events: AdapterEvent[] = [];
  for await (const event of adapter.run(input)) events.push(event);
  const terminal = [...events]
    .reverse()
    .find((event) => event.type === "result" || event.type === "failure");
  const stored: Array<{ raw: string; sha256: string }> = [];
  if (terminal?.type === "result") {
    for await (const p of terminal.resultStorage?.pages?.() ?? [])
      stored.push(p);
    await terminal.resultStorage?.persisted();
  }
  return { requests, drafts, terminal, stored };
}
describe("adjudication adapter recovery", () => {
  it("continues a header-only declaration to required decisions and retains exact wire pages", async () => {
    const complete = page(ids.map(decision));
    const result = await run(["Inspected.", header, complete]);
    expect(result.terminal).toMatchObject({
      type: "result",
      result: {
        decisions: [
          { source_finding_id: ids[0] },
          { source_finding_id: ids[1] },
        ],
      },
    });
    expect(result.requests).toHaveLength(3);
    const assignment = JSON.parse(result.requests[2].messages.at(-1).content);
    expect(assignment).toMatchObject({
      page_index: 1,
      page_count: 2,
      candidate_count: 2,
      candidate_ids: ids,
    });
    expect(result.stored.map((item) => item.raw)).toEqual([header, complete]);
  });

  it("repairs an invalid decision sibling without repeating the accepted header", async () => {
    const result = await run([
      "Inspected.",
      header,
      page([decision(ids[0]!), { ...decision(ids[1]!), decision: "invalid" }]),
      page(ids.map(decision)),
    ]);
    expect(result.terminal?.type).toBe("result");
    expect(result.requests).toHaveLength(4);
    expect(JSON.stringify(result.requests[3].messages)).toContain(
      "candidate-a",
    );
    expect(result.drafts).toContainEqual(
      expect.objectContaining({
        result_kind: "adjudication",
        decision: expect.objectContaining({ source_finding_id: "candidate-a" }),
      }),
    );
    expect(result.drafts).toContainEqual(
      expect.objectContaining({
        assigned_candidate_ids: ids,
        missing_decision_ids: ids,
      }),
    );
  });
});
