import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createOpenAICompatibleAdapter } from "../../src/adapters/openai-compatible.js";
import { createChangeCoverageLedger } from "../../src/context/change-coverage.js";
import { buildReviewerPrompt } from "../../src/protocol/prompt.js";
import { reviewerResultJsonSchema } from "../../src/protocol/json-schema.js";
import {
  passResult,
  resolvedContext,
  resolvedReviewer,
  roundInput,
} from "../helpers/fixtures.js";
import { runV9Review } from "../../src/orchestrator/run-v9.js";
import { AdapterRegistry } from "../../src/adapters/registry.js";
import type {
  AdapterEvent,
  AdapterReviewInput,
  ReviewAdapter,
} from "../../src/adapters/types.js";

const registration = {
  type: "openai_compatible" as const,
  base_url_env: "BASE",
  api_key_env: "KEY",
};
const environment = {
  BASE: "https://synthetic.invalid/v1",
  KEY: "synthetic-secret-value",
};
const response = (message: object) =>
  new Response(
    JSON.stringify({ choices: [{ message, finish_reason: "stop" }] }),
    { headers: { "content-type": "application/json" } },
  );
const done = () =>
  response({
    role: "assistant",
    content: JSON.stringify(passResult("Evidence reviewed.")),
  });
const ready = () =>
  response({
    role: "assistant",
    content: "Analysis checkpoint: the source operation is consistent.",
  });
const read = (path: string, offset = 0, byte_count?: number) =>
  response({
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: `read-${offset}`,
        type: "function",
        function: {
          name: "read_file",
          arguments: JSON.stringify({
            path,
            offset,
            ...(byte_count === undefined ? {} : { byte_count }),
          }),
        },
      },
    ],
  });

async function fixture(
  contents = "synthetic source evidence\n",
  missing = false,
) {
  const root = await mkdtemp(join(tmpdir(), "mesh-inspection-regression-"));
  if (!missing) await writeFile(join(root, "changed.txt"), contents);
  const diff = "diff --git a/changed.txt b/changed.txt\n+changed\n";
  const context = resolvedContext({
    workspace: root,
    review_scope: { mode: "changes", source: "request" },
    git: {
      is_repository: true,
      root,
      branch: "main",
      head: "a".repeat(40),
      merge_base: "b".repeat(40),
      status_entries: [" M changed.txt"],
      changed_files: ["changed.txt"],
      changed_paths: [{ path: "changed.txt", kind: "tracked" }],
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
  const reviewer = resolvedReviewer({
    adapter: registration,
    adapterId: "synthetic",
    model: "test-model",
  });
  const input: AdapterReviewInput = {
    runId: "inspection-regression",
    reviewer,
    context,
    coverage,
    prompt: buildReviewerPrompt({ context, reviewer }),
    resultJsonSchema: reviewerResultJsonSchema,
    isolationPolicy: "prefer_enforced",
    signal: new AbortController().signal,
  };
  return {
    root,
    input,
    coverage,
    async cleanup() {
      await coverage.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
async function collect(adapter: ReviewAdapter, input: AdapterReviewInput) {
  const events: AdapterEvent[] = [];
  for await (const event of adapter.run(input)) events.push(event);
  return {
    events,
    terminal: events.find(
      (event) => event.type === "result" || event.type === "failure",
    )!,
  };
}

describe("inspection recovery", () => {
  it("does not treat the local result-production deadline as provider health", async () => {
    const f = await fixture();
    let time = 0;
    let clockCalls = 0;
    const adapter = createOpenAICompatibleAdapter(registration, {
      environment,
      requestTimeoutMs: 1,
      now: () => (++clockCalls <= 3 ? time : (time += 100)),
      fetch: async (_url, init) =>
        JSON.parse(String(init?.body)).response_format ? done() : ready(),
    });
    try {
      const result = await collect(adapter, f.input);
      expect(result.terminal).toMatchObject({
        type: "failure",
        failure: {
          reason: "invalid_result",
          circuit_qualifying: false,
          diagnostics: {
            failure_stage: "structured_result_deadline",
            scope: "model",
          },
        },
      });
    } finally {
      await f.cleanup();
    }
  });
  it("retains the real scheduler retry conversation and accepts its observed coverage", async () => {
    const f = await fixture();
    const base = roundInput();
    const reviewer = {
      ...f.input.reviewer,
      id: "retry",
      agentId: "retry",
      providerGroup: "synthetic",
      timeoutMs: 10_000,
      policy: {
        applicability: { mode: "always" as const },
        requiredCallerContext: [],
        passQuorum: 1,
        minimumProviderGroups: 1,
        adjudication: "off" as const,
        gateMinimumSeverity: "medium" as const,
        gateMinimumConfidence: "medium" as const,
        lensDeadlineMs: 10_000,
        changeCoverage: {
          relevantPaths: ["**"],
          minimumInspection: "full_file" as const,
          proof: "observed" as const,
        },
      },
    };
    base.config.reviewers = [reviewer];
    Object.assign(base.config.execution, {
      deadline_mode: "fixed",
      run_deadline_ms: 10_000,
      retry_attempts: 2,
      retry_backoff_ms: 1,
    });
    const bodies: any[] = [];
    const sessions: string[] = [];
    const records: any[] = [];
    const results: any[] = [];
    const registry = new AdapterRegistry();
    registry.register("openai_compatible", (registration) =>
      createOpenAICompatibleAdapter(registration, {
        environment,
        fetch: async (url, init) => {
          if (String(url).endsWith("/models"))
            return new Response(
              JSON.stringify({ data: [{ id: "test-model" }] }),
              { headers: { "content-type": "application/json" } },
            );
          const body = JSON.parse(String(init?.body));
          bodies.push(body);
          sessions.push(new Headers(init?.headers).get("X-Client-Session-Id")!);
          if (bodies.length === 1)
            return response({
              role: "assistant",
              content: "Retained analysis marker 839afc",
              tool_calls: [
                {
                  id: "read",
                  type: "function",
                  function: {
                    name: "read_file",
                    arguments: '{"path":"changed.txt"}',
                  },
                },
              ],
            });
          if (bodies.length === 2)
            return new Response("Upstream timeout", { status: 524 });
          if (body.tools) return ready();
          const assignment = JSON.parse(body.messages.at(-1).content);
          return response({
            role: "assistant",
            content: JSON.stringify({
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
                summary: "Observed evidence reviewed.",
                informational_notes: [],
                narrative_byte_count: 0,
                narrative_fragment_count: 0,
                actionable_finding_count: 0,
                coverage_attestation: null,
              },
            }),
          });
        },
      }),
    );
    try {
      await runV9Review({
        runId: "scheduler-inspection-retry",
        config: base.config,
        context: f.input.context,
        registry,
        signal: new AbortController().signal,
        writer: {
          emit: async () => undefined,
          finish: async () => ({
            path: "/synthetic",
            sha256: "a".repeat(64),
            byte_count: 1,
            completed_results: 1,
          }),
          close: async () => undefined,
          outputFailed: () => false,
        },
        record: async (record) => {
          records.push(record);
        },
        recordResult: async (_id, result) => {
          results.push(result);
        },
      });
      expect(
        records.filter((record) => record.record === "reviewer.attempt"),
      ).toHaveLength(2);
      expect(new Set(sessions).size).toBe(1);
      expect(JSON.stringify(bodies[2].messages)).toContain(
        "Retained analysis marker 839afc",
      );
      expect(JSON.stringify(bodies[2].messages)).toContain(
        "synthetic source evidence",
      );
      expect(results).toHaveLength(1);
      expect(results[0].change_coverage.status).toBe("complete");
      expect(
        records.some(
          (record) =>
            record.record === "reviewer.terminal" &&
            record.data.status === "completed",
        ),
      ).toBe(true);
    } finally {
      await f.cleanup();
    }
  });

  it("delivers and acknowledges an empty changed file", async () => {
    const f = await fixture("");
    const adapter = createOpenAICompatibleAdapter(registration, {
      environment,
      fetch: async (_url, init) =>
        JSON.parse(String(init?.body)).response_format ? done() : ready(),
    });
    try {
      expect((await collect(adapter, f.input)).terminal.type).toBe("result");
      expect(f.coverage.summary().status).toBe("complete");
    } finally {
      await f.cleanup();
    }
  });
  it("finalizes after the last permitted read completes coverage", async () => {
    const f = await fixture("x".repeat(150 * 1024));
    let toolTurns = 0;
    let finalizations = 0;
    const adapter = createOpenAICompatibleAdapter(registration, {
      environment,
      maxTurns: 2,
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        if (body.response_format) {
          finalizations++;
          return done();
        }
        toolTurns++;
        return read(
          "changed.txt",
          toolTurns === 1 ? 0 : 128 * 1024,
          toolTurns === 1 ? 128 * 1024 : 22 * 1024,
        );
      },
    });
    try {
      const result = await collect(adapter, f.input);
      expect(result.terminal.type).toBe("result");
      expect(finalizations).toBe(1);
      expect(f.coverage.summary().status).toBe("complete");
    } finally {
      await f.cleanup();
    }
  });

  it("delivers readable exact ranges when a model never requests files", async () => {
    const source = "Readable café 東京 source line\n".repeat(12_000);
    const f = await fixture(source);
    const bodies: any[] = [];
    const adapter = createOpenAICompatibleAdapter(registration, {
      environment,
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        bodies.push(body);
        return body.response_format ? done() : ready();
      },
    });
    try {
      const result = await collect(adapter, f.input);
      expect(result.terminal.type).toBe("result");
      expect(f.coverage.summary().status).toBe("complete");
      expect(JSON.stringify(bodies.at(-1).messages)).toContain(
        "Readable café 東京 source line",
      );
      expect(
        result.events.some(
          (event) =>
            event.type === "progress" &&
            (event as any).inspection?.inspected_count === 1,
        ),
      ).toBe(true);
    } finally {
      await f.cleanup();
    }
  });

  it("fails impossible acquisition before contacting the provider", async () => {
    const f = await fixture("", true);
    let requests = 0;
    const adapter = createOpenAICompatibleAdapter(registration, {
      environment,
      fetch: async () => {
        requests++;
        return ready();
      },
    });
    try {
      const result = await collect(adapter, f.input);
      expect(result.terminal).toMatchObject({
        type: "failure",
        failure: {
          reason: "change_coverage_incomplete",
          circuit_qualifying: false,
          diagnostics: { failure_code: "inspection_acquisition_failed" },
        },
      });
      expect(requests).toBe(0);
    } finally {
      await f.cleanup();
    }
  });

  it("classifies insufficient inspection capacity as local and never circuit qualifying", async () => {
    const f = await fixture("source".repeat(50_000));
    const adapter = createOpenAICompatibleAdapter(registration, {
      environment,
      maxConversationBytes: 12_000,
      maxTurns: 1,
      fetch: async () => ready(),
    });
    try {
      const result = await collect(adapter, f.input);
      expect(result.terminal).toMatchObject({
        type: "failure",
        failure: {
          reason: "change_coverage_incomplete",
          retryable: false,
          circuit_qualifying: false,
          diagnostics: {
            failure_code: "inspection_budget_exhausted",
            maximum_inspection_turns: 1,
          },
        },
      });
      expect(f.coverage.summary().status).toBe("incomplete");
    } finally {
      await f.cleanup();
    }
  });

  it("resumes the evidence and analysis conversation after a recoverable request failure", async () => {
    const f = await fixture();
    const bodies: any[] = [];
    let fail = true;
    const adapter = createOpenAICompatibleAdapter(registration, {
      environment,
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        bodies.push(body);
        if (bodies.length === 1) return read("changed.txt");
        if (fail) {
          fail = false;
          return new Response("Gateway timeout", { status: 524 });
        }
        return body.response_format ? done() : ready();
      },
    });
    try {
      expect((await collect(adapter, f.input)).terminal.type).toBe("failure");
      expect((await collect(adapter, f.input)).terminal.type).toBe("result");
      expect(
        bodies[2].messages.some((message: any) => message.role === "tool"),
      ).toBe(true);
      expect(JSON.stringify(bodies[2].messages)).toContain(
        "synthetic source evidence",
      );
      expect(f.coverage.summary().status).toBe("complete");
    } finally {
      await f.cleanup();
    }
  });

  it("replays credited evidence when a fresh adapter receives an existing ledger", async () => {
    const f = await fixture();
    const observed = await f.coverage.readFile({ path: "changed.txt" });
    if (!observed.ok) throw new Error("fixture snapshot missing");
    observed.acknowledgeDelivered();
    const bodies: any[] = [];
    const adapter = createOpenAICompatibleAdapter(registration, {
      environment,
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        bodies.push(body);
        return body.response_format ? done() : ready();
      },
    });
    try {
      expect((await collect(adapter, f.input)).terminal.type).toBe("result");
      expect(JSON.stringify(bodies.at(-1).messages)).toContain(
        "synthetic source evidence",
      );
      expect(f.coverage.summary().status).toBe("complete");
    } finally {
      await f.cleanup();
    }
  });

  it("does not credit a tool response rejected at its provider boundary", async () => {
    const f = await fixture();
    let requests = 0;
    const adapter = createOpenAICompatibleAdapter(registration, {
      environment,
      fetch: async () =>
        ++requests === 1
          ? read("changed.txt")
          : new Response("Bad request", { status: 400 }),
    });
    try {
      expect((await collect(adapter, f.input)).terminal.type).toBe("failure");
      expect(f.coverage.status().entries[0]?.snapshot_content_delivered).toBe(
        false,
      );
    } finally {
      await f.cleanup();
    }
  });
});

describe("provider error explanations", () => {
  it("redacts short exact request values and decoded source echoes", async () => {
    const f = await fixture();
    f.input.prompt.user = "privateMode";
    const adapter = createOpenAICompatibleAdapter(registration, {
      environment,
      fetch: async () =>
        new Response(
          JSON.stringify({
            error: { message: "Unsupported value: privateMode" },
          }),
          { status: 400 },
        ),
    });
    try {
      const result = await collect(adapter, f.input);
      expect(JSON.stringify(result.terminal)).not.toContain("privateMode");
    } finally {
      await f.cleanup();
    }
  });
  it("retains a sanitized JSON provider error with request context and correlation", async () => {
    const f = await fixture();
    const source = "PRIVATE_ECHOED_SOURCE_9fad5e06";
    f.input.prompt.user += `\n${source}`;
    const adapter = createOpenAICompatibleAdapter(registration, {
      environment,
      fetch: async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "context_length_exceeded",
              message: `Context limit exceeded. ${source} Authorization: Bearer ${environment.KEY}`,
            },
          }),
          {
            status: 400,
            headers: {
              "content-type": "application/json",
              "x-request-id": "request-123",
            },
          },
        ),
    });
    try {
      const result = await collect(adapter, f.input);
      expect(result.terminal).toMatchObject({
        type: "failure",
        failure: {
          diagnostics: {
            http_status: 400,
            provider_request_id: "request-123",
            provider_error_code: "context_length_exceeded",
            model: "test-model",
            operation_phase: "inspection",
            inspection_turn: 1,
            request_bytes: expect.any(Number),
          },
        },
      });
      expect(JSON.stringify(result.terminal)).toContain(
        "Context limit exceeded",
      );
      expect(JSON.stringify(result.terminal)).not.toContain(source);
      expect(JSON.stringify(result.terminal)).not.toContain(environment.KEY);
    } finally {
      await f.cleanup();
    }
  });

  it("keeps HTTP evidence when an error body never completes", async () => {
    const f = await fixture();
    let cancelled = false;
    const adapter = createOpenAICompatibleAdapter(registration, {
      environment,
      requestTimeoutMs: 20,
      fetch: async () =>
        new Response(
          new ReadableStream({
            pull() {
              return new Promise(() => {});
            },
            cancel() {
              cancelled = true;
            },
          }),
          {
            status: 524,
            headers: { "content-type": "text/html", "cf-ray": "ray-123" },
          },
        ),
    });
    try {
      const result = await collect(adapter, f.input);
      expect(result.terminal).toMatchObject({
        type: "failure",
        failure: {
          diagnostics: {
            http_status: 524,
            error_body_unavailable: true,
            correlation_headers: { "cf-ray": "ray-123" },
          },
        },
      });
      expect(cancelled).toBe(true);
    } finally {
      await f.cleanup();
    }
  });

  it.each([
    [
      "text/plain",
      "Request exceeds the context window",
      "Request exceeds the context window",
    ],
    [
      "text/html",
      "<html><title>524: upstream timeout</title><script>private-server-state</script></html>",
      "524: upstream timeout",
    ],
    [
      "text/plain",
      "Request too large. " + "x".repeat(50_000),
      "Request too large.",
    ],
  ])(
    "bounds %s provider messages without persisting full bodies",
    async (type, body, expected) => {
      const f = await fixture();
      const adapter = createOpenAICompatibleAdapter(registration, {
        environment,
        fetch: async () =>
          new Response(body, {
            status: 400,
            headers: { "content-type": type },
          }),
      });
      try {
        const result = await collect(adapter, f.input);
        if (result.terminal.type !== "failure")
          throw new Error("failure expected");
        expect(
          result.terminal.failure.diagnostics?.provider_error_message,
        ).toContain(expected);
        expect(
          result.terminal.failure.diagnostics?.provider_error_message?.length,
        ).toBeLessThanOrEqual(512);
        expect(JSON.stringify(result.terminal)).not.toContain(
          "private-server-state",
        );
        if (body.length > 16 * 1024)
          expect(
            result.terminal.failure.diagnostics?.error_body_truncated,
          ).toBe(true);
      } finally {
        await f.cleanup();
      }
    },
  );
});
