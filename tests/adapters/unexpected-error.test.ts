import { describe, expect, it } from "vitest";
import { unexpectedAdapterFailure } from "../../src/adapters/unexpected-error.js";
import { sanitizeAdapterFailure } from "../../src/adapters/errors.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createOpenAICompatibleAdapter } from "../../src/adapters/openai-compatible.js";
import { createChangeCoverageLedger } from "../../src/context/change-coverage.js";
import { resolvedContext, resolvedReviewer } from "../helpers/fixtures.js";
import { reviewerResultJsonSchema } from "../../src/protocol/json-schema.js";

describe("unexpected adapter diagnostics", () => {
  it.each([true, false])(
    "retains a real adapter tool exception with durable diagnostics=%s",
    async (durable) => {
      const root = await mkdtemp(join(tmpdir(), "mesh-unexpected-tool-"));
      await writeFile(join(root, "worker.ts"), "synthetic source\n");
      const context = resolvedContext({
        workspace: root,
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
      const original = ledger.snapshotFiles;
      ledger.snapshotFiles = () => {
        throw new TypeError(
          "Cannot read properties of undefined (reading 'hidden-query') at C:\\private\\source.ts Authorization: Bearer hidden-token",
        );
      };
      const registration = {
        type: "openai_compatible" as const,
        base_url_env: "URL",
        api_key_env: "KEY",
        context_window_tokens: 4_000_000,
      };
      const diagnostics: unknown[] = [];
      const adapter = createOpenAICompatibleAdapter(registration, {
        environment: {
          URL: "https://no-network.invalid/v1",
          KEY: "synthetic-only",
        },
        fetch: async () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "query",
                        type: "function",
                        function: {
                          name: "search_text",
                          arguments: '{"query":"hidden-query","path":"."}',
                        },
                      },
                    ],
                  },
                  finish_reason: "stop",
                },
              ],
            }),
            { headers: { "content-type": "application/json" } },
          ),
      });
      try {
        const events = [];
        for await (const event of adapter.run({
          runId: "unexpected",
          reviewer: resolvedReviewer({
            adapter: registration,
            model: "synthetic",
          }),
          context,
          coverage: ledger,
          prompt: {
            system: "synthetic",
            user: "synthetic",
            combined: "synthetic",
          },
          resultJsonSchema: reviewerResultJsonSchema,
          isolationPolicy: "prefer_enforced",
          signal: new AbortController().signal,
          ...(durable
            ? {
                recordDiagnostic: async (value: unknown) => {
                  diagnostics.push(value);
                },
              }
            : {}),
        }))
          events.push(event);
        const terminal = events.find((event) => event.type === "failure");
        expect(terminal).toMatchObject({
          type: "failure",
          failure: {
            reason: "unknown",
            circuit_qualifying: false,
            diagnostics: {
              exception_name: "TypeError",
              exception_message: "Cannot read properties of undefined.",
              last_operation: "search_text",
              inspection_turn: 1,
              stack_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
            },
          },
        });
        if (durable) {
          expect(terminal?.failure.diagnostics?.artifact_ref).toBe(
            "reviewer.exception",
          );
          expect(diagnostics).toEqual([
            expect.objectContaining({
              kind: "adapter_exception",
              diagnostics: expect.objectContaining({
                last_operation: "search_text",
                exception_name: "TypeError",
              }),
            }),
          ]);
        } else {
          expect(terminal?.failure.diagnostics).not.toHaveProperty(
            "artifact_ref",
          );
          expect(diagnostics).toEqual([]);
        }
        expect(JSON.stringify({ terminal, diagnostics })).not.toMatch(
          /hidden-query|hidden-token|C:\\\\private|source\.ts/,
        );
      } finally {
        ledger.snapshotFiles = original;
        await ledger.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
  it("preserves exception identity and operation without source, query, paths or raw stack", () => {
    const error = new TypeError(
      "Cannot read properties of undefined (reading 'privateTenant'); query=hidden-query at C:\\private\\source.ts Authorization: Bearer secret-value",
    );
    error.stack =
      "TypeError: hidden-query\n    at runTool (C:\\private\\source.ts:42:5)\n    at Object.run (C:\\private\\other.ts:2:1)";
    const failure = unexpectedAdapterFailure(error, {
      model: "synthetic",
      operation: "search_text",
      phase: "inspection",
      turn: 7,
      redactValues: ["privateTenant", "hidden-query", "secret-value"],
    });
    expect(failure).toMatchObject({
      reason: "unknown",
      retryable: false,
      fallback_eligible: true,
      circuit_qualifying: false,
      diagnostics: {
        failure_code: "unexpected_adapter_exception",
        scope: "adapter",
        exception_name: "TypeError",
        exception_message: "Cannot read properties of undefined.",
        model: "synthetic",
        operation_phase: "inspection",
        last_operation: "search_text",
        inspection_turn: 7,
        stack_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        artifact_ref: "reviewer.exception",
      },
    });
    for (const secret of [
      "privateTenant",
      "hidden-query",
      "secret-value",
      "C:\\private",
      "runTool (",
    ])
      expect(JSON.stringify(failure)).not.toContain(secret);
  });
  it("uses a bounded template for arbitrary exceptions and non-error values", () => {
    for (const value of [
      new Error("SELECT secretSource FROM privateTable"),
      { name: "TenantSecret", message: "private query" },
      "raw-source-fragment",
      null,
    ]) {
      const failure = unexpectedAdapterFailure(value, {
        model: "synthetic",
        operation: "unknown_tool_with_private_name",
        phase: "inspection",
        turn: 3,
      });
      expect(failure.diagnostics?.exception_name).toBe("Error");
      expect(failure.diagnostics?.exception_message).toBe(
        "Unexpected internal adapter exception.",
      );
      expect(failure.diagnostics?.last_operation).toBe("inspection");
      expect(JSON.stringify(failure)).not.toMatch(
        /secretSource|privateTable|TenantSecret|private query|raw-source-fragment|private_name/,
      );
    }
  });
  it("is stable for repeated exception stacks and distinguishes exception sites", () => {
    const first = new Error("private-one"),
      second = new Error("private-two");
    first.stack = "Error: private-one\n    at sourceA (C:\\private\\a.ts:1:1)";
    second.stack = "Error: private-two\n    at sourceB (C:\\private\\b.ts:1:1)";
    const context = {
      model: "synthetic",
      operation: "read_file",
      phase: "inspection",
      turn: 1,
    };
    expect(
      unexpectedAdapterFailure(first, context).diagnostics?.stack_fingerprint,
    ).toBe(
      unexpectedAdapterFailure(first, context).diagnostics?.stack_fingerprint,
    );
    expect(
      unexpectedAdapterFailure(first, context).diagnostics?.stack_fingerprint,
    ).not.toBe(
      unexpectedAdapterFailure(second, context).diagnostics?.stack_fingerprint,
    );
  });
  it("preserves only well-bounded exception and numeric context diagnostics", () => {
    const failure = sanitizeAdapterFailure("unknown", "safe", false, {
      diagnostics: {
        exception_name: "TypeError",
        exception_message: "Authorization: Bearer hidden",
        last_operation: "read_file",
        stack_fingerprint: "a".repeat(64),
        context_error_class: "context_too_large",
        input_tokens: 2000,
        limit_tokens: 1000,
      },
    });
    expect(failure.diagnostics).toMatchObject({
      exception_message: "[redacted]",
      input_tokens: 2000,
      limit_tokens: 1000,
      stack_fingerprint: "a".repeat(64),
    });
    expect(JSON.stringify(failure)).not.toContain("hidden");
  });
});
