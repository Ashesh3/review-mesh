import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createNativeClaudeAdapter } from "../../src/adapters/native-claude.js";
import { nativeResultJsonSchema } from "../../src/protocol/native-review.js";
import { resolvedContext, resolvedReviewer } from "../helpers/fixtures.js";

it.runIf(process.env.REVIEW_MESH_VERIFY_SDK_RUNTIME === "1")(
  "follows native page metadata through the entire large file without losing source lines",
  async () => {
    // Use the project directory: the vendor protects files under profile/AppData.
    const workspace = await mkdtemp(
      join(import.meta.dirname, "paging-fixture-"),
    );
    const lines = Array.from(
      { length: 1200 },
      (_, index) =>
        `${String(index + 1).padStart(4, "0")} controlled source ${"text ".repeat(26)}`,
    );
    const content = lines.join("\n") + "\n";
    await writeFile(join(workspace, "source.txt"), content);
    let calls = 0;
    let readCalls = 0;
    let pagedHints = 0;
    let finalMarker = false;
    let contextReadable = false;
    let diffPath: string | undefined;
    let diffReadable = false;
    let contextPath: string | undefined;
    const originalDiff =
      "diff --git a/source.txt b/source.txt\n--- a/source.txt\n+++ b/source.txt\n@@ -1 +1 @@\n-ORIGINAL_DIFF_FIRST_MARKER\n+ORIGINAL_DIFF_LAST_MARKER\n";
    let fixtureFailure: string | undefined;
    const observed = new Map<number, string>();
    const pageBytes: number[] = [];
    const expected = {
      schema_version: "4",
      verdict: "pass",
      review_markdown: "Complete paged fixture review.",
      summary: "Every fixture line inspected.",
      actionable_findings: [],
      informational_notes: [],
      native_scope_attestation: {
        reviewed_paths: ["source.txt"],
        complete: true,
        limitations: [],
      },
    };
    const stream = (response: ServerResponse, name: string, input: unknown) => {
      const event = (type: string, data: unknown) =>
        response.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      response.writeHead(200, { "content-type": "text/event-stream" });
      event("message_start", {
        type: "message_start",
        message: {
          id: `paging-${calls}`,
          type: "message",
          role: "assistant",
          model: "claude-opus-5",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 100, output_tokens: 1 },
        },
      });
      event("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: `call-${calls}`,
          name,
          input: {},
        },
      });
      event("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify(input),
        },
      });
      event("content_block_stop", { type: "content_block_stop", index: 0 });
      event("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 20 },
      });
      event("message_stop", { type: "message_stop" });
      response.end();
    };
    const controller = new AbortController();
    const server = createServer((request, response) => {
      let raw = "";
      request.on("data", (chunk) => {
        raw += chunk;
      });
      request.on("end", () => {
        if (request.url?.includes("count_tokens")) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              input_tokens: Math.ceil(Buffer.byteLength(raw) / 4),
            }),
          );
          return;
        }
        if (!request.url?.includes("/messages")) {
          response.writeHead(404);
          response.end();
          return;
        }
        try {
          calls++;
          if (calls > 15)
            throw new Error("Fixture exceeded its bounded page count");
          const body = JSON.parse(raw);
          if (calls === 1) {
            const system = Array.isArray(body.system)
              ? body.system
                  .map((entry: { text?: string }) => entry.text ?? "")
                  .join("\n")
              : String(body.system);
            const retained =
              /complete original review context is retained in (.+?) \(SHA-256/.exec(
                system,
              );
            if (!retained) throw new Error("Missing retained context pointer");
            contextPath = JSON.parse(retained[1]!);
            const diff = /original plain-text diff in (.+?) \(SHA-256/.exec(
              system,
            );
            if (!diff) throw new Error("Missing retained diff pointer");
            diffPath = JSON.parse(diff[1]!);
            stream(response, "Read", {
              file_path: contextPath,
              offset: 1,
              limit: 120,
            });
            return;
          }
          if (calls === 2) {
            const blocks = body.messages.flatMap(
              (message: { content: unknown }) =>
                Array.isArray(message.content) ? message.content : [],
            );
            const result = blocks.findLast(
              (block: { type: string }) => block.type === "tool_result",
            );
            contextReadable =
              result?.is_error !== true &&
              JSON.stringify(result?.content).includes(
                "review-mesh.native-context",
              );
            if (!contextReadable)
              throw new Error(
                "Native Read could not read the retained context file",
              );
            stream(response, "Read", {
              file_path: diffPath,
              offset: 1,
              limit: 120,
            });
            return;
          }
          if (calls === 3) {
            const blocks = body.messages.flatMap(
              (message: { content: unknown }) =>
                Array.isArray(message.content) ? message.content : [],
            );
            const result = blocks.findLast(
              (block: { type: string }) => block.type === "tool_result",
            );
            const text = JSON.stringify(result?.content);
            diffReadable =
              result?.is_error !== true &&
              text.includes("ORIGINAL_DIFF_FIRST_MARKER") &&
              text.includes("ORIGINAL_DIFF_LAST_MARKER");
            if (!diffReadable)
              throw new Error(
                "Native Read could not read the retained diff companion",
              );
            readCalls++;
            stream(response, "Read", {
              file_path: join(workspace, "source.txt"),
            });
            return;
          }
          const blocks = body.messages.flatMap(
            (message: { content: unknown }) =>
              Array.isArray(message.content) ? message.content : [],
          );
          const result = blocks.findLast(
            (block: { type: string }) => block.type === "tool_result",
          );
          if (!result || result.is_error)
            throw new Error("Native read did not succeed");
          const text =
            typeof result.content === "string"
              ? result.content
              : JSON.stringify(result.content);
          pageBytes.push(Buffer.byteLength(text));
          for (const line of text.split("\n")) {
            const match = /^\d+\t(\d{4} controlled source .*)$/.exec(line);
            if (match) observed.set(Number(match[1]!.slice(0, 4)), match[1]!);
          }
          finalMarker ||= text.includes(lines.at(-1)!);
          const hint = blocks.findLast(
            (block: { type: string; text?: string }) =>
              block.type === "text" &&
              block.text?.includes("Native Read returned lines"),
          )?.text;
          if (!hint)
            throw new Error("Native partial page lacked a paging obligation");
          const next = /offset=(\d+) and limit=(\d+)/.exec(hint);
          if (next) {
            pagedHints++;
            readCalls++;
            stream(response, "Read", {
              file_path: join(workspace, "source.txt"),
              offset: Number(next[1]),
              limit: Number(next[2]),
            });
          } else {
            if (!hint.includes("end of file"))
              throw new Error("Missing explicit end-of-file guidance");
            stream(response, "StructuredOutput", expected);
          }
        } catch (error) {
          fixtureFailure =
            error instanceof Error ? error.message : "Fixture failed";
          response.writeHead(500);
          response.end();
          controller.abort();
        }
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing fixture address");
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
          KEY: "fixture",
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
    try {
      const events = [];
      for await (const event of adapter.run({
        runId: "paging-fixture",
        reviewer,
        context: resolvedContext({
          workspace,
          git: {
            is_repository: true,
            root: workspace,
            branch: "fixture",
            head: "a".repeat(40),
            merge_base: "b".repeat(40),
            status_entries: [],
            changed_files: ["source.txt"],
            diff_stat: "",
            diff: originalDiff,
            truncated: {
              status_entries: false,
              changed_files: false,
              diff_stat: false,
              diff: false,
            },
          },
        }),
        prompt: {
          system:
            "Read the entire file in consecutive native pages and preserve findings.",
          user: "Read source.txt fully.",
          combined: "Read fully.",
        },
        resultJsonSchema: nativeResultJsonSchema(reviewer),
        isolationPolicy: "prefer_enforced",
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(25000),
        ]),
      }))
        events.push(event);
      expect(fixtureFailure).toBeUndefined();
      expect(contextReadable).toBe(true);
      expect(diffReadable).toBe(true);
      expect(readCalls).toBeGreaterThan(3);
      expect(pagedHints).toBe(readCalls - 1);
      expect(Math.max(...pageBytes)).toBeLessThan(40 * 1024);
      expect(observed.size).toBe(lines.length);
      expect([...observed.values()]).toEqual(lines);
      expect(finalMarker).toBe(true);
      expect(events.at(-1)).toMatchObject({ type: "result", result: expected });
    } finally {
      controller.abort();
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
