import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, readFile, access, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import { CopilotClient } from "@github/copilot-sdk";
import { expect, it } from "vitest";
import { createNativeCopilotAdapter } from "../../src/adapters/native-copilot.js";
import { resolvedContext, resolvedReviewer } from "../helpers/fixtures.js";
import { nativeResultJsonSchema } from "../../src/protocol/native-review.js";

it("runs native read-only Git commands and refuses write redirection in the packaged Copilot runtime", async () => {
  const root = await mkdtemp(join(import.meta.dirname, "copilot-git-fixture-"));
  const workspace = join(root, "workspace");
  await execa("git", ["init", "--initial-branch=main", workspace]);
  await execa("git", ["config", "user.name", "Read Only Fixture"], {
    cwd: workspace,
  });
  await execa("git", ["config", "user.email", "fixture@example.test"], {
    cwd: workspace,
  });
  await writeFile(join(workspace, "source.txt"), "GIT_BASE_MARKER\n");
  await execa("git", ["add", "source.txt"], { cwd: workspace });
  await execa("git", ["commit", "-m", "Git read-only fixture"], {
    cwd: workspace,
  });
  await writeFile(join(workspace, "source.txt"), "GIT_HEAD_MARKER\n");
  const controller = new AbortController();
  const commands = [
    "git status --short",
    "git diff -- source.txt",
    "git log -1 --format=%s",
    "git show HEAD:source.txt",
    "echo CHANGED > blocked-write.txt",
  ];
  const outputs: string[] = [];
  const permissions: unknown[] = [];
  let calls = 0;
  let shell = "";
  let fixtureFailure: string | undefined;
  const expected = {
    schema_version: "4",
    verdict: "pass",
    review_markdown: "Native Git fixture review",
    summary: "Inspected the change",
    actionable_findings: [],
    informational_notes: [],
    native_scope_attestation: {
      complete: true,
      reviewed_paths: ["source.txt"],
      limitations: [],
    },
  };
  const respond = (response: ServerResponse, name: string, args: unknown) => {
    const tool = {
      id: `call-${calls}`,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    };
    const envelope = {
      id: `message-${calls}`,
      object: "chat.completion.chunk",
      created: 1,
      model: "kimi-k3",
    };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(
      `data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, ...tool }] }, finish_reason: null }] })}\n\n`,
    );
    response.end(
      `data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`,
    );
  };
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      try {
        calls++;
        if (calls > 6) throw new Error("Unexpected additional native Git turn");
        const body = JSON.parse(Buffer.concat(chunks).toString());
        if (calls === 1) {
          shell = process.platform === "win32" ? "powershell" : "bash";
          if (!body.tools.some((tool: any) => tool.function.name === shell))
            throw new Error("Native shell tool is missing");
        } else {
          const tool = body.messages.findLast(
            (message: any) => message.role === "tool",
          );
          outputs.push(
            typeof tool?.content === "string"
              ? tool.content
              : JSON.stringify(tool?.content),
          );
        }
        if (calls <= commands.length)
          respond(response, shell, {
            command: commands[calls - 1],
            description: "Inspect Git fixture",
            initial_wait: 1000,
          });
        else respond(response, "submit_review", expected);
      } catch (error) {
        fixtureFailure =
          error instanceof Error ? error.message : "Fixture failed";
        response.writeHead(500);
        response.end();
        controller.abort();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const adapter = createNativeCopilotAdapter(
    { type: "copilot", base_url_env: "URL", api_key_env: "KEY" },
    {
      applicationDataDirectory: join(root, "application"),
      environment: {
        ...process.env,
        URL: `http://127.0.0.1:${port}/v1`,
        KEY: "FIXTURE",
      },
      createClient: (options) => {
        const client = new CopilotClient(options);
        const create = client.createSession.bind(client);
        client.createSession = (config) => {
          const decide = config!.onPermissionRequest!;
          return create({
            ...config!,
            onPermissionRequest: (request, invocation) => {
              permissions.push(
                request.kind === "shell"
                  ? {
                      kind: request.kind,
                      commands: request.commands,
                      redirect: request.hasWriteFileRedirection,
                      urls: request.possibleUrls,
                      bypass: request.requestSandboxBypass,
                      managed: request.managedApprovalRequired,
                    }
                  : { kind: request.kind },
              );
              return decide(request, invocation);
            },
          });
        };
        return client;
      },
    },
  );
  const reviewer = resolvedReviewer({
    model: "kimi-k3",
    adapter: { type: "copilot" },
    timeoutMs: 20000,
  });
  try {
    const events = [];
    for await (const event of adapter.run({
      runId: "native-git",
      reviewer,
      context: resolvedContext({
        workspace,
        review_scope: { mode: "full", source: "request" },
      }),
      prompt: {
        system: "Review using read-only tools and Git. Do not edit files.",
        user: "Review the change.",
        combined: "Review the change.",
      },
      resultJsonSchema: nativeResultJsonSchema(reviewer),
      isolationPolicy: "prefer_enforced",
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(25000)]),
    }))
      events.push(event);
    expect(
      fixtureFailure,
      JSON.stringify({ outputs, permissions }),
    ).toBeUndefined();
    expect(outputs).toHaveLength(5);
    expect(outputs[0]).toContain("source.txt");
    expect(outputs[1]).toContain("+GIT_HEAD_MARKER");
    expect(outputs[2]).toContain("Git read-only fixture");
    expect(outputs[3]).toContain("GIT_BASE_MARKER");
    expect(outputs[4]).toMatch(/denied|rejected|not allowed|Read-only review/i);
    expect(await readFile(join(workspace, "source.txt"), "utf8")).toBe(
      "GIT_HEAD_MARKER\n",
    );
    await expect(
      access(join(workspace, "blocked-write.txt")),
    ).rejects.toThrow();
    expect(events.at(-1)).toMatchObject({ type: "result", result: expected });
  } finally {
    controller.abort();
    await adapter.forceCleanup?.();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
}, 30000);
