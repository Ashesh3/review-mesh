import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { createOpenAICompatibleAdapter } from "../../src/adapters/openai-compatible.js";
import { createResultPageCollector } from "../../src/results/result-pages.js";
import { reviewerResultJsonSchema } from "../../src/protocol/json-schema.js";
import { resolvedContext, resolvedReviewer } from "../helpers/fixtures.js";

it("repairs only an undersized final header and retains both host candidates", async () => {
  const candidate = (id: string) => ({
    id,
    severity: "high" as const,
    title: "Synthetic defect",
    description: "Synthetic.",
    evidence: [
      { path: "source.ts", start_line: 1, end_line: 1, detail: "Synthetic." },
    ],
    suggested_direction: "Fix it.",
    confidence: "high" as const,
    classification: "confirmed_defect" as const,
    external_assumptions: [],
    category: "correctness" as const,
    verification: "Test it.",
    claim: {
      trigger: "Input.",
      affected_behavior: "Value.",
      outcome: "Wrong.",
    },
  });
  const candidates = [candidate("F1"), candidate("F2")];
  const collector = createResultPageCollector({
    resultId: "header-repair",
    resultKind: "reviewer",
  });
  collector.preserveFindings(candidates);
  const envelope = {
    schema_version: "1",
    kind: "review-mesh.result-page",
    result_id: "header-repair",
    result_kind: "reviewer",
    result_schema_version: "4",
  };
  const header = (pages: number) =>
    JSON.stringify({
      ...envelope,
      page_index: 0,
      page_count: pages,
      page_kind: "header",
      previous_page_digest: null,
      payload: {
        verdict: "fail",
        summary: "Two candidates.",
        informational_notes: [],
        actionable_finding_count: 2,
        narrative_byte_count: 0,
        narrative_fragment_count: 0,
        coverage_attestation: null,
      },
    });
  const corrected = header(2);
  const responses = [
    "Inspection complete.",
    header(1),
    corrected,
    JSON.stringify({
      ...envelope,
      page_index: 1,
      page_count: 2,
      page_kind: "findings",
      previous_page_digest: createHash("sha256")
        .update(corrected)
        .digest("hex"),
      payload: { actionable_findings: candidates },
    }),
  ];
  const bodies: any[] = [],
    drafts: any[] = [];
  const registration = {
    type: "openai_compatible" as const,
    base_url_env: "URL",
    api_key_env: "KEY",
  };
  const adapter = createOpenAICompatibleAdapter(registration, {
    environment: { URL: "https://no-network.invalid/v1", KEY: "synthetic" },
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: responses.shift() ?? "unexpected",
              },
              finish_reason: "stop",
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });
  const events = [];
  for await (const event of adapter.run({
    runId: "header-repair",
    reviewer: resolvedReviewer({ adapter: registration }),
    context: resolvedContext({ workspace: process.cwd() }),
    prompt: {
      system: "Synthetic.",
      user: "Synthetic.",
      combined: "Synthetic.",
    },
    resultJsonSchema: reviewerResultJsonSchema,
    resultPages: collector,
    isolationPolicy: "prefer_enforced",
    signal: new AbortController().signal,
    recordDiagnostic: async (diagnostic) => {
      drafts.push(diagnostic);
    },
  }))
    events.push(event);
  const terminal = events.find(
    (event) => event.type === "result" || event.type === "failure",
  );
  try {
    expect(terminal).toMatchObject({
      type: "result",
      result: { verdict: "fail", actionable_findings: candidates },
    });
    expect(bodies).toHaveLength(4);
    expect(bodies.filter((body) => body.tools)).toHaveLength(1);
    expect(JSON.stringify(bodies[2].messages)).toContain(
      "page_count must be at least 2",
    );
    expect(JSON.stringify(bodies[2].messages)).toContain("F1");
    expect(JSON.stringify(bodies[2].messages)).toContain("F2");
    expect(
      drafts.some(
        (draft) =>
          draft.accepted_page_count === 0 &&
          draft.validation_issues?.some(
            (issue: any) => issue.path === "page_count",
          ),
      ),
    ).toBe(true);
  } finally {
    if (terminal?.type === "result") await terminal.resultStorage?.persisted();
  }
});
