import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";
import { createNativeContextFile } from "../../src/runtime/native-context.js";
import { resolveSdkRuntime } from "../../src/runtime/sdk-runtime.js";
import { buildAllowlistedEnvironment } from "../../src/adapters/types.js";
import { sendCopilotReviewAndWait } from "../../src/runtime/copilot-completion.js";
import { resolvedContext } from "../helpers/fixtures.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

it("recovers the first and last original diff lines through packaged native view ranges", async () => {
  const root = await mkdtemp(join(tmpdir(), "mesh-context-readability-"));
  roots.push(root);
  const work = join(root, "workspace");
  await mkdir(work);
  const diff =
    [
      "diff --git a/source.ts b/source.ts",
      "+FIRST_ORIGINAL_DIFF_MARKER",
      ...Array.from(
        { length: 2100 },
        (_, index) => `+line_${index} ${"context".repeat(9)}`,
      ),
      "+LAST_ORIGINAL_DIFF_MARKER",
    ].join("\n") + "\n";
  expect(Buffer.byteLength(diff)).toBeGreaterThan(147000);
  const context = resolvedContext({
    workspace: work,
    git: {
      is_repository: true,
      root: work,
      branch: "fixture",
      head: "a".repeat(40),
      merge_base: "b".repeat(40),
      changed_files: ["source.ts"],
      status_entries: [],
      diff_stat: "1file",
      diff,
      truncated: {
        status_entries: false,
        changed_files: false,
        diff_stat: false,
        diff: false,
      },
    },
  });
  const file = await createNativeContextFile(root, context);
  expect(file.diffPath).toBeDefined();
  const readablePath = file.diffPath ?? file.path;
  const diffLineCount = diff.trimEnd().split("\n").length;
  expect(await readFile(readablePath, "utf8")).toBe(diff);
  const replies: string[] = [];
  let requests = 0;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      requests++;
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const toolMessages = body.messages.filter((m: any) => m.role === "tool");
      if (toolMessages.length)
        replies.push(String(toolMessages.at(-1).content));
      const call =
        requests <= 2
          ? {
              id: "read-first",
              type: "function",
              function: {
                name: "view",
                arguments: JSON.stringify({
                  path: readablePath,
                  view_range:
                    requests === 1
                      ? [1, 10]
                      : [diffLineCount - 9, diffLineCount],
                }),
              },
            }
          : requests === 3
            ? {
                id: "done",
                type: "function",
                function: { name: "finish", arguments: "{}" },
              }
            : undefined;
      if (body.stream) {
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write(
          `data: ${JSON.stringify({ id: `r${requests}`, object: "chat.completion.chunk", model: "kimi-k3", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, ...call }] }, finish_reason: null }] })}\n\n`,
        );
        response.end(
          `data: ${JSON.stringify({ id: `r${requests}`, object: "chat.completion.chunk", model: "kimi-k3", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`,
        );
      } else {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            id: `r${requests}`,
            object: "chat.completion",
            model: "kimi-k3",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [call],
                },
                finish_reason: "tool_calls",
              },
            ],
          }),
        );
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = new CopilotClient({
    mode: "empty",
    connection: RuntimeConnection.forStdio({
      path: resolveSdkRuntime("copilot").executablePath,
    }),
    baseDirectory: root,
    workingDirectory: work,
    useLoggedInUser: false,
    logLevel: "error",
    env: buildAllowlistedEnvironment([], process.env),
  });
  try {
    await client.start();
    const session = await client.createSession({
      model: "kimi-k3",
      workingDirectory: work,
      configDirectory: root,
      streaming: true,
      enableConfigDiscovery: false,
      enableSkills: false,
      enableSessionStore: false,
      enableHostGitOperations: false,
      availableTools: ["builtin:view", "custom:finish"],
      onPermissionRequest: () => ({ kind: "approve-once" }),
      provider: {
        type: "openai",
        baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
        wireApi: "completions",
        apiKey: "PUBLIC_LOOPBACK_FIXTURE",
      },
      tools: [
        {
          name: "finish",
          description: "Finish",
          parameters: { type: "object", properties: {} },
          isTerminal: true,
          skipPermission: true,
          handler: () => ({ resultType: "success", textResultForLlm: "Done" }),
        },
      ],
    });
    await sendCopilotReviewAndWait(
      session,
      { prompt: "Read the supplied context using view then finish." },
      15000,
      AbortSignal.timeout(17000),
    );
    await session.disconnect();
    expect(replies).toHaveLength(2);
    expect(replies[0]).toContain("FIRST_ORIGINAL_DIFF_MARKER");
    expect(
      replies[1],
      `Native view tail returned ${Buffer.byteLength(replies[1] ?? "")} bytes for a ${Buffer.byteLength(diff)}-byte original diff`,
    ).toContain("LAST_ORIGINAL_DIFF_MARKER");
  } finally {
    const errors = await client.stop();
    if (errors.length) await client.forceStop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 25000);
