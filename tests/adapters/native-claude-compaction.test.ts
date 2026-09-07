import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createNativeClaudeAdapter } from "../../src/adapters/native-claude.js";
import {
  buildNativeReviewPrompt,
  nativeResultJsonSchema,
} from "../../src/protocol/native-review.js";
import { resolvedContext, resolvedReviewer } from "../helpers/fixtures.js";

it.runIf(process.env.REVIEW_MESH_VERIFY_SDK_RUNTIME === "1")(
  "compacts inside the native SDK at the selected model window before provider overflow",
  async () => {
    const workspace = await mkdtemp(join(tmpdir(), "mesh-claude-compaction-"));
    await writeFile(join(workspace, "source.txt"), "controlled fixture\n");
    let calls = 0;
    let compactions = 0;
    let schemaSeen = false;
    let summaryToolsDisabled = false;
    const summary =
      "<summary>Required source.txt remains reviewed. Preserve all findings and finish with the final schema.</summary>";
    const providerResult = {
      schema_version: "4",
      verdict: "pass",
      review_markdown: "Complete native compaction fixture review.",
      summary: "No findings.",
      actionable_findings: [],
      informational_notes: [],
      native_scope_attestation: {
        reviewed_paths: ["source.txt"],
        complete: true,
        limitations: [],
      },
    };
    const send = (
      response: ServerResponse,
      block: Record<string, unknown>,
      inputTokens: number,
    ) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const event = (name: string, data: unknown) =>
        response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
      event("message_start", {
        type: "message_start",
        message: {
          id: `fixture-${calls}`,
          type: "message",
          role: "assistant",
          model: "claude-opus-5",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: inputTokens,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        },
      });
      event("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      });
      for (let index = 0; index < 2; index++)
        event("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "", estimated_tokens: 32 },
        });
      event("content_block_stop", { type: "content_block_stop", index: 0 });
      event("content_block_start", {
        type: "content_block_start",
        index: 1,
        content_block:
          block.type === "text"
            ? { type: "text", text: "" }
            : { type: "tool_use", id: block.id, name: block.name, input: {} },
      });
      event("content_block_delta", {
        type: "content_block_delta",
        index: 1,
        delta:
          block.type === "text"
            ? { type: "text_delta", text: block.text }
            : {
                type: "input_json_delta",
                partial_json: JSON.stringify(block.input),
              },
      });
      event("content_block_stop", { type: "content_block_stop", index: 1 });
      event("message_delta", {
        type: "message_delta",
        delta: {
          stop_reason: block.type === "text" ? "end_turn" : "tool_use",
          stop_sequence: null,
        },
        usage: { output_tokens: 25 },
      });
      event("message_stop", { type: "message_stop" });
      response.end();
    };
    const server = createServer((request, response) => {
      let raw = "";
      request.on("data", (chunk) => {
        raw += chunk;
      });
      request.on("end", () => {
        if (request.url?.includes("count_tokens")) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end('{"input_tokens":100}');
          return;
        }
        if (!request.url?.includes("/messages")) {
          response.writeHead(404);
          response.end();
          return;
        }
        calls++;
        const body = JSON.parse(raw);
        schemaSeen ||=
          body.tools?.some(
            (tool: { name: string }) => tool.name === "StructuredOutput",
          ) === true;
        const compact = JSON.stringify(body.messages).includes(
          "CRITICAL: Respond with TEXT ONLY.",
        );
        if (compact) {
          compactions++;
          summaryToolsDisabled = body.tool_choice?.type === "none";
          send(response, { type: "text", text: summary }, 100);
        } else if (calls <= 3) {
          send(
            response,
            {
              type: "tool_use",
              id: `read-${calls}`,
              name: "Read",
              input: {
                file_path: join(workspace, "source.txt"),
                offset: 1,
                limit: 1,
              },
            },
            140000 + calls * 10000,
          );
        } else {
          send(
            response,
            {
              type: "tool_use",
              id: `final-${calls}`,
              name: "StructuredOutput",
              input: providerResult,
            },
            100,
          );
        }
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing fixture port");
    const adapter = createNativeClaudeAdapter(
      {
        type: "claude",
        api_key_env: "KEY",
        base_url_env: "URL",
        env_allowlist: ["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"],
      },
      {
        environment: {
          ...process.env,
          KEY: "local-fixture",
          URL: `http://127.0.0.1:${address.port}`,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        },
      },
    );
    const reviewer = resolvedReviewer({
      adapter: { type: "claude" },
      model: "claude-opus-5",
      effort: "max",
    });
    const context = resolvedContext({
      workspace,
      review_scope: { mode: "full", source: "request" },
    });
    try {
      const events = [];
      for await (const event of adapter.run({
        runId: "compaction-fixture",
        reviewer,
        context,
        prompt: buildNativeReviewPrompt(reviewer, context),
        resultJsonSchema: nativeResultJsonSchema(reviewer),
        isolationPolicy: "prefer_enforced",
        signal: AbortSignal.timeout(25000),
      }))
        events.push(event);
      expect(
        schemaSeen,
        JSON.stringify(events.filter((event) => event.type === "failure")),
      ).toBe(true);
      expect(compactions).toBe(1);
      expect(summaryToolsDisabled).toBe(true);
      expect(calls).toBe(5);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "activity",
          identity: expect.stringMatching(/^claude:compaction-complete:/),
        }),
      );
      expect(events.at(-1)).toMatchObject({
        type: "result",
        result: providerResult,
      });
      const activity = events.filter((event) => event.type === "activity");
      expect(
        activity.filter((event) =>
          event.identity?.startsWith("claude:thinking:"),
        ),
      ).toHaveLength(8);
      expect(
        activity.some(
          (event) =>
            event.identity?.startsWith("claude:output:") &&
            (event.byteCount ?? 0) > 0,
        ),
      ).toBe(true);
      expect(JSON.stringify(events)).not.toContain(summary);
    } finally {
      await adapter.forceCleanup?.();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(workspace, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      });
    }
  },
  30000,
);
