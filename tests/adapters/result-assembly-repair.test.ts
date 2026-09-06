import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createOpenAICompatibleAdapter } from "../../src/adapters/openai-compatible.js";
import { resolvedContext, resolvedReviewer } from "../helpers/fixtures.js";
import { reviewerResultJsonSchema } from "../../src/protocol/json-schema.js";
import type {
  AdapterEvent,
  AdapterReviewInput,
} from "../../src/adapters/types.js";

const env = {
  schema_version: "1",
  kind: "review-mesh.result-page",
  result_id: "assembly",
  result_kind: "reviewer",
  result_schema_version: "4",
};
const candidate = (id: string) => ({
  id,
  severity: "high",
  title: "Candidate",
  description: "A defect.",
  evidence: [{ path: "a.ts", start_line: 1, end_line: 1, detail: "Evidence." }],
  suggested_direction: "Fix it.",
  confidence: "high",
  classification: "confirmed_defect",
  external_assumptions: [],
  category: "correctness",
  verification: "Test it.",
  claim: {
    trigger: "The path runs.",
    affected_behavior: "Value changes.",
    outcome: "Wrong result.",
  },
});
const header = JSON.stringify({
  ...env,
  page_index: 0,
  page_count: 2,
  previous_page_digest: null,
  page_kind: "header",
  payload: {
    verdict: "fail",
    summary: "Candidates.",
    informational_notes: [],
    actionable_finding_count: 2,
    narrative_fragment_count: 0,
    narrative_byte_count: 0,
  },
});
const findings = (ids: string[]) =>
  JSON.stringify({
    ...env,
    page_index: 1,
    page_count: 2,
    previous_page_digest: createHash("sha256").update(header).digest("hex"),
    page_kind: "findings",
    payload: { actionable_findings: ids.map(candidate) },
  });
const emptyPass = JSON.stringify({
  ...JSON.parse(header),
  page_count: 1,
  payload: {
    ...JSON.parse(header).payload,
    verdict: "pass",
    actionable_finding_count: 0,
  },
});

async function run(responses: string[]) {
  const requests: any[] = [];
  const drafts: any[] = [];
  const registration = {
    type: "openai_compatible" as const,
    base_url_env: "TEST_URL",
    api_key_env: "TEST_KEY",
  };
  const adapter = createOpenAICompatibleAdapter(registration, {
    environment: {
      TEST_URL: "https://no-network.invalid/v1",
      TEST_KEY: "synthetic",
    },
    fetch: (async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      const content = responses.shift() ?? emptyPass;
      return new Response(
        JSON.stringify({
          choices: [
            { message: { role: "assistant", content }, finish_reason: "stop" },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch,
  });
  const input: AdapterReviewInput = {
    runId: `assembly-regression-${Date.now()}`,
    reviewer: resolvedReviewer({
      adapterId: "synthetic",
      adapter: registration,
      model: "synthetic",
    }),
    context: resolvedContext({ workspace: process.cwd() }),
    prompt: {
      system: "Synthetic system.",
      user: "Inspect.",
      combined: "Synthetic system. Inspect.",
    },
    resultJsonSchema: reviewerResultJsonSchema,
    resultPages: { resultId: "assembly", resultKind: "reviewer" },
    isolationPolicy: "prefer_enforced",
    signal: new AbortController().signal,
    recordDiagnostic: async (draft) => {
      drafts.push(draft);
    },
  };
  const events: AdapterEvent[] = [];
  for await (const event of adapter.run(input)) events.push(event);
  const terminal = [...events]
    .reverse()
    .find((event) => event.type === "result" || event.type === "failure");
  if (terminal?.type === "result") await terminal.resultStorage?.persisted();
  return { requests, drafts, terminal, events };
}

describe("OpenAI result assembly repair", () => {
  it("repairs only the incomplete findings page with preserved candidates and header", async () => {
    const result = await run([
      "Inspection done.",
      header,
      findings(["f-1"]),
      findings(["f-1", "f-2"]),
    ]);
    expect(result.terminal).toMatchObject({
      type: "result",
      result: {
        verdict: "fail",
        actionable_findings: [{ id: "f-1" }, { id: "f-2" }],
      },
    });
    expect(result.requests).toHaveLength(4);
    expect(JSON.stringify(result.requests[3].messages)).toContain("f-1");
    expect(
      JSON.parse(result.requests[3].messages.at(-1).content),
    ).toMatchObject({
      page_index: 1,
      page_count: 2,
      expected_page_kind: "findings",
    });
    expect(result.drafts).toContainEqual(
      expect.objectContaining({
        kind: "unverified_result_draft",
        candidate: expect.objectContaining({ id: "f-1" }),
      }),
    );
  });

  it("cannot replace an incomplete failing assembly with an empty pass", async () => {
    const result = await run([
      "Inspection done.",
      header,
      findings(["f-1"]),
      emptyPass,
    ]);
    expect(result.terminal).toMatchObject({
      type: "failure",
      failure: {
        circuit_qualifying: false,
        diagnostics: { artifact_ref: "reviewer.draft" },
      },
    });
    expect(result.drafts.some((draft) => draft.candidate?.id === "f-1")).toBe(
      true,
    );
    expect(result.requests.length).toBeLessThanOrEqual(6);
  });
});
