import { afterEach, describe, expect, it } from "vitest";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { parse as parseToml } from "smol-toml";
import { resolvedContext, resolvedReviewer } from "../helpers/fixtures.js";
import { nativeResultJsonSchema } from "../../src/protocol/native-review.js";
import type {
  AdapterEvent,
  AdapterReviewInput,
} from "../../src/adapters/types.js";
import type { CodexOptions, ThreadEvent } from "@openai/codex-sdk";
import { resolveSdkRuntime } from "../../src/runtime/sdk-runtime.js";

const directories: string[] = [];
afterEach(async () => {
  for (const path of directories.splice(0))
    await rm(path, { recursive: true, force: true });
});
async function temporary() {
  const path = await mkdtemp(join(tmpdir(), "mesh-native-codex-"));
  directories.push(path);
  return path;
}
const result = () => ({
  schema_version: "4",
  verdict: "pass",
  review_markdown: "# Review\nNo findings.",
  summary: "No findings.",
  actionable_findings: [],
  informational_notes: [],
  native_scope_attestation: {
    reviewed_paths: ["source.txt"],
    complete: true,
    limitations: [],
  },
});
async function input(
  workspace: string,
  registration: {
    type: "codex";
    api_key_env?: string;
    base_url_env?: string;
    env_allowlist?: string[];
  } = { type: "codex", env_allowlist: ["CODEX_API_KEY"] },
): Promise<AdapterReviewInput> {
  const reviewer = resolvedReviewer({
    model: "gpt-5.1-codex-mini",
    adapter: registration,
  });
  return {
    runId: "native-codex",
    reviewer,
    context: resolvedContext({ workspace }),
    prompt: {
      system: "TRUSTED_REVIEW_POLICY",
      user: "Review the workspace.",
      combined: "Review the workspace.",
    },
    resultJsonSchema: nativeResultJsonSchema(reviewer),
    isolationPolicy: "prefer_enforced",
    signal: new AbortController().signal,
  };
}
async function collect(stream: AsyncIterable<AdapterEvent>) {
  const values: AdapterEvent[] = [];
  for await (const value of stream) values.push(value);
  return values;
}

async function progressFor(events: readonly ThreadEvent[]) {
  const { createNativeCodexAdapter } =
    await import("../../src/adapters/native-codex.js");
  const root = await temporary();
  const adapter = createNativeCodexAdapter(
    { type: "codex", api_key_env: "KEY" },
    {
      applicationDataDirectory: join(root, "app"),
      environment: { KEY: "fixture" },
      createClient: () =>
        ({
          startThread: () => ({
            runStreamed: async () => ({
              events: (async function* () {
                yield* events;
                yield {
                  type: "item.completed",
                  item: {
                    id: "result",
                    type: "agent_message",
                    text: JSON.stringify(result()),
                  },
                };
                yield {
                  type: "turn.completed",
                  usage: {
                    input_tokens: 1,
                    cached_input_tokens: 0,
                    output_tokens: 1,
                  },
                };
              })(),
            }),
          }),
        }) as never,
    },
  );
  const output = await collect(adapter.run(await input(root)));
  expect(output.at(-1)?.type).toBe("result");
  return output.filter(
    (event): event is Extract<AdapterEvent, { type: "activity" }> =>
      event.type === "activity",
  );
}

function assertStrictSchema(schema: Record<string, any>): void {
  expect(schema).not.toHaveProperty("$schema");
  expect(schema).not.toHaveProperty("const");
  expect(Object.keys(schema).some((key) => key.startsWith("x-"))).toBe(false);
  if (schema.type === "object") {
    expect(schema.additionalProperties).toBe(false);
    expect(new Set(schema.required)).toEqual(
      new Set(Object.keys(schema.properties)),
    );
    Object.values(schema.properties).forEach((child) =>
      assertStrictSchema(child as Record<string, any>),
    );
  }
  if (schema.type === "array") {
    expect(Array.isArray(schema.items)).toBe(false);
    assertStrictSchema(schema.items);
  }
  for (const branch of schema.anyOf ?? []) assertStrictSchema(branch);
}

describe("native Codex isolation", () => {
  it("canonicalizes equivalent MCP arguments for repeated inspection progress", async () => {
    const args = [
      { path: "PRIVATE_PATH", range: { end: 10, start: 1 } },
      { range: { start: 1, end: 10 }, path: "PRIVATE_PATH" },
      { path: "PRIVATE_PATH", range: { start: 11, end: 20 } },
    ];
    const progress = await progressFor(
      args.map((arguments_, index) => ({
        type: "item.completed",
        item: {
          id: `tool-${index}`,
          type: "mcp_tool_call",
          server: "fixture",
          tool: "read",
          arguments: arguments_,
          status: "completed",
          result: { content: [], structured_content: "PRIVATE_OUTPUT" },
        },
      })),
    );
    expect(progress[0]?.identity).toMatch(/^codex:/);
    expect(progress[1]?.identity).toBe(progress[0]?.identity);
    expect(progress[2]?.identity).not.toBe(progress[0]?.identity);
    expect(JSON.stringify(progress)).not.toMatch(/PRIVATE_PATH|PRIVATE_OUTPUT/);
  });

  it("credits distinct successful empty commands once without crediting failed or pending commands", async () => {
    const definitions = [
      { command: "read empty-first", status: "completed", exit_code: 0 },
      { command: "read empty-first", status: "completed", exit_code: 0 },
      { command: "read empty-second", status: "completed", exit_code: 0 },
      { command: "read failed", status: "failed", exit_code: 1 },
      { command: "read pending", status: "in_progress" },
    ] as const;
    const progress = await progressFor(
      definitions.map((definition, index) => ({
        type:
          definition.status === "in_progress"
            ? "item.started"
            : "item.completed",
        item: {
          id: `command-${index}`,
          type: "command_execution",
          aggregated_output: "",
          ...definition,
        },
      })),
    );
    const { createNativeProgressWatchdog } =
      await import("../../src/orchestrator/native-progress.js");
    const watchdog = createNativeProgressWatchdog({
      timeoutMs: 10000,
      signal: new AbortController().signal,
      onTimeout: () => {},
    });
    try {
      expect(progress.map((event) => watchdog.record(event))).toEqual([
        true,
        false,
        true,
        false,
        false,
      ]);
      expect(progress[0]?.byteCount).toBeUndefined();
      expect(progress[0]?.identity).toContain(":complete:");
    } finally {
      watchdog.close();
    }
  });

  it("credits successful empty MCP completions but does not credit failed MCP responses", async () => {
    const progress = await progressFor([
      {
        type: "item.completed",
        item: {
          id: "ok",
          type: "mcp_tool_call",
          server: "fixture",
          tool: "read",
          arguments: { path: "empty" },
          status: "completed",
        },
      },
      {
        type: "item.completed",
        item: {
          id: "bad",
          type: "mcp_tool_call",
          server: "fixture",
          tool: "read",
          arguments: { path: "denied" },
          status: "failed",
          error: { message: "PRIVATE_ERROR" },
        },
      },
    ]);
    expect(progress[0]?.identity).toContain(":complete:");
    expect(progress[0]?.byteCount).toBeUndefined();
    expect(progress[1]?.identity).toBeUndefined();
    expect(JSON.stringify(progress)).not.toContain("PRIVATE_ERROR");
  });

  it("keeps malformed or oversized MCP identities diagnostic-only", async () => {
    const cycle: Record<string, unknown> = {};
    cycle.next = cycle;
    const progress = await progressFor(
      [cycle, { path: "x".repeat(1024 * 1024 + 1) }].map(
        (arguments_, index) => ({
          type: "item.completed",
          item: {
            id: `tool-${index}`,
            type: "mcp_tool_call",
            server: "fixture",
            tool: "read",
            arguments: arguments_,
            status: "completed",
            result: { content: [], structured_content: "fixture" },
          },
        }),
      ),
    );
    expect(progress).toHaveLength(2);
    expect(progress.every((event) => event.identity === undefined)).toBe(true);
  });

  it("tracks semantic inspection progress without exposing command output or reasoning text", async () => {
    const { createNativeCodexAdapter } =
      await import("../../src/adapters/native-codex.js");
    const root = await temporary();
    const command = "Get-Content PRIVATE_FILE";
    const adapter = createNativeCodexAdapter(
      { type: "codex", api_key_env: "KEY" },
      {
        applicationDataDirectory: join(root, "app"),
        environment: { KEY: "fixture" },
        createClient: () =>
          ({
            startThread: () => ({
              runStreamed: async () => ({
                events: (async function* () {
                  for (const id of ["first", "repeat"])
                    yield {
                      type: "item.completed",
                      item: {
                        id,
                        type: "command_execution",
                        command,
                        aggregated_output: "PRIVATE_BYTES",
                        exit_code: 0,
                        status: "completed",
                      },
                    };
                  yield {
                    type: "item.updated",
                    item: {
                      id: "reason",
                      type: "reasoning",
                      text: "PRIVATE_THOUGHT",
                    },
                  };
                  yield {
                    type: "item.completed",
                    item: {
                      id: "message",
                      type: "agent_message",
                      text: JSON.stringify(result()),
                    },
                  };
                  yield {
                    type: "turn.completed",
                    usage: {
                      input_tokens: 1,
                      cached_input_tokens: 0,
                      output_tokens: 1,
                    },
                  };
                })(),
              }),
            }),
          }) as never,
      },
    );
    const output = await collect(adapter.run(await input(root)));
    const activity = output.filter((event) => event.type === "activity");
    expect(activity[0]).toMatchObject({
      identity: expect.stringMatching(/^codex:/),
      byteCount: 13,
    });
    expect(activity[1]).toMatchObject({
      identity: activity[0]!.identity,
      byteCount: 13,
    });
    expect(activity[2]).toMatchObject({
      identity: expect.stringMatching(/^codex:/),
      byteCount: 15,
    });
    expect(JSON.stringify(activity)).not.toMatch(
      /PRIVATE_FILE|PRIVATE_BYTES|PRIVATE_THOUGHT/,
    );
    expect(output.at(-1)?.type).toBe("result");
  });
  it("projects both native result schemas to strict required objects and normalizes only optional nulls", async () => {
    const { codexOutputBoundary } =
      await import("../../src/adapters/codex-output.js");
    const source = nativeResultJsonSchema(resolvedReviewer());
    const before = JSON.stringify(source);
    const boundary = codexOutputBoundary(source);
    assertStrictSchema(boundary.schema);
    expect(boundary.schema.properties).not.toHaveProperty(
      "coverage_attestation",
    );
    expect(JSON.stringify(source)).toBe(before);
    const findingSchema = (boundary.schema.properties as Record<string, any>)
      .actionable_findings.items;
    expect(findingSchema.properties.root_issue_id.anyOf).toContainEqual({
      type: "null",
    });
    expect(
      findingSchema.properties.evidence.items.properties.start_line.anyOf[0],
    ).toMatchObject({ type: "integer", exclusiveMinimum: 0 });
    expect(
      boundary.normalize({
        actionable_findings: [
          {
            root_issue_id: null,
            duplicate_of: null,
            change_impact: null,
            evidence: [
              { path: null, start_line: null, end_line: null, detail: null },
            ],
          },
        ],
        native_scope_attestation: null,
      }),
    ).toEqual({
      actionable_findings: [{ evidence: [{ detail: null }] }],
      native_scope_attestation: null,
    });
    const adjudicator = resolvedReviewer({
      policy: {
        mode: "adjudication",
        candidateFindings: [{ id: "candidate" }],
      } as never,
    });
    const adjudication = codexOutputBoundary(
      nativeResultJsonSchema(adjudicator),
    );
    assertStrictSchema(adjudication.schema);
    expect(
      (adjudication.schema.properties as Record<string, any>)
        .actionable_findings,
    ).toMatchObject({
      type: "array",
      maxItems: 0,
      items: { type: "null" },
    });
    expect(
      adjudication.normalize({
        decisions: [
          {
            source_finding_id: "candidate",
            adjusted_finding: null,
            ordered_execution_proof: null,
            base_head_comparison: null,
            duplicate_of: null,
          },
        ],
      }),
    ).toEqual({ decisions: [{ source_finding_id: "candidate" }] });
  });

  it("keeps a validated result available when isolated runtime cleanup fails", async () => {
    const { createNativeCodexAdapter } =
      await import("../../src/adapters/native-codex.js");
    const { createCodexIsolationHome } =
      await import("../../src/runtime/codex-isolation.js");
    const root = await temporary();
    const adapter = createNativeCodexAdapter(
      { type: "codex", api_key_env: "KEY" },
      {
        applicationDataDirectory: join(root, "app"),
        environment: { KEY: "fixture" },
        createIsolation: async (...args) => {
          const home = await createCodexIsolationHome(...args);
          return {
            ...home,
            cleanup: async () => {
              throw new Error("PRIVATE_CLEANUP_REASON");
            },
          };
        },
        createClient: () =>
          ({
            startThread: () => ({
              runStreamed: async () => ({
                events: (async function* () {
                  yield {
                    type: "item.completed",
                    item: {
                      id: "message",
                      type: "agent_message",
                      text: JSON.stringify(result()),
                    },
                  };
                  yield {
                    type: "turn.completed",
                    usage: {
                      input_tokens: 1,
                      cached_input_tokens: 0,
                      output_tokens: 1,
                    },
                  };
                })(),
              }),
            }),
          }) as never,
      },
    );
    const iterator = adapter.run(await input(root))[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({
      type: "result",
      result: result(),
    });
    await expect(iterator.next()).rejects.toThrow(
      "Codex runtime cleanup failed after producing a valid result",
    );
  });
  it("preserves the completed result when the SDK fails while draining its process output", async () => {
    const { createNativeCodexAdapter } =
      await import("../../src/adapters/native-codex.js");
    const root = await temporary();
    const adapter = createNativeCodexAdapter(
      { type: "codex", api_key_env: "KEY" },
      {
        applicationDataDirectory: join(root, "app"),
        environment: { KEY: "fixture" },
        createClient: () =>
          ({
            startThread: () => ({
              runStreamed: async () => ({
                events: (async function* () {
                  yield {
                    type: "item.completed",
                    item: {
                      id: "message",
                      type: "agent_message",
                      text: JSON.stringify(result()),
                    },
                  };
                  yield {
                    type: "turn.completed",
                    usage: {
                      input_tokens: 1,
                      cached_input_tokens: 0,
                      output_tokens: 1,
                    },
                  };
                  throw new Error("PRIVATE_PROCESS_EXIT_FAILURE");
                })(),
              }),
            }),
          }) as never,
      },
    );
    const iterator = adapter.run(await input(root))[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({
      type: "result",
      result: result(),
    });
    await expect(iterator.next()).rejects.toThrow(
      "Codex runtime failed after producing a valid result",
    );
  });
  it("preserves the completed result when cancellation arrives during SDK shutdown", async () => {
    const { createNativeCodexAdapter } =
      await import("../../src/adapters/native-codex.js");
    const root = await temporary();
    const controller = new AbortController();
    const adapter = createNativeCodexAdapter(
      { type: "codex", api_key_env: "KEY" },
      {
        applicationDataDirectory: join(root, "app"),
        environment: { KEY: "fixture" },
        createClient: () =>
          ({
            startThread: () => ({
              runStreamed: async () => ({
                events: (async function* () {
                  yield {
                    type: "item.completed",
                    item: {
                      id: "message",
                      type: "agent_message",
                      text: JSON.stringify(result()),
                    },
                  };
                  yield {
                    type: "turn.completed",
                    usage: {
                      input_tokens: 1,
                      cached_input_tokens: 0,
                      output_tokens: 1,
                    },
                  };
                  controller.abort();
                })(),
              }),
            }),
          }) as never,
      },
    );
    const review = await input(root);
    review.signal = controller.signal;
    const iterator = adapter.run(review)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({
      type: "result",
      result: result(),
    });
    await expect(iterator.next()).rejects.toThrow(
      "Codex runtime was cancelled after producing a valid result",
    );
  });
  it("reports separate packaged SDK and runtime version metadata", async () => {
    const { createNativeCodexAdapter } =
      await import("../../src/adapters/native-codex.js");
    const adapter = createNativeCodexAdapter(
      { type: "codex", api_key_env: "KEY" },
      { environment: { KEY: "fixture" } },
    );
    const runtime = resolveSdkRuntime("codex");
    expect(
      await adapter.probe(resolvedReviewer(), new AbortController().signal),
    ).toMatchObject({
      available: true,
      sdk_version: runtime.sdkVersion,
      runtime_version: runtime.runtimeVersion,
    });
  });
  it("disables canonical symlinked skills without looping and fails a bounded incomplete scan", async () => {
    const { enumerateCodexSkillDisables } =
      await import("../../src/runtime/codex-isolation.js");
    const root = await temporary();
    const skills = join(root, "skills");
    const target = join(root, "target");
    await mkdir(skills);
    await mkdir(target);
    await writeFile(join(target, "SKILL.md"), "fixture");
    await symlink(
      target,
      join(skills, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await symlink(
      skills,
      join(target, "cycle"),
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(await enumerateCodexSkillDisables([skills])).toEqual([
      { path: await realpath(join(target, "SKILL.md")), enabled: false },
    ]);
    await expect(
      enumerateCodexSkillDisables([skills], { maximumEntries: 1 }),
    ).rejects.toThrow(/limit/i);
  });

  it("requires explicitly selected credentials and does not claim independently enforced isolation", async () => {
    const { createNativeCodexAdapter } =
      await import("../../src/adapters/native-codex.js");
    const registration = { type: "codex" as const };
    const adapter = createNativeCodexAdapter(registration, {
      environment: { CODEX_API_KEY: "PRIVATE_AMBIENT_KEY" },
    });
    const reviewer = resolvedReviewer({ adapter: registration });
    expect(
      await adapter.probe(reviewer, new AbortController().signal),
    ).toMatchObject({ available: false, authenticated: "unknown" });
    const configured = createNativeCodexAdapter(
      { type: "codex", api_key_env: "TEST_KEY" },
      { environment: { TEST_KEY: "fixture" } },
    );
    const probe = await configured.probe(
      { ...reviewer, isolationPolicy: "require_enforced" },
      new AbortController().signal,
    );
    expect(probe.available).toBe(false);
    expect(probe.message).toMatch(/independently enforced/i);
  });

  it.each([
    {
      name: "invalid JSON",
      events: [
        {
          type: "item.completed",
          item: { id: "message", type: "agent_message", text: "malformed" },
        },
        {
          type: "turn.completed",
          usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
        },
      ],
      reason: "invalid_result",
    },
    {
      name: "missing terminal event",
      events: [
        {
          type: "item.completed",
          item: {
            id: "message",
            type: "agent_message",
            text: JSON.stringify(result()),
          },
        },
      ],
      reason: "protocol_violation",
    },
    {
      name: "file mutation",
      events: [
        {
          type: "item.completed",
          item: {
            id: "file",
            type: "file_change",
            changes: [{ path: "source.txt", kind: "update" }],
            status: "completed",
          },
        },
      ],
      reason: "protocol_violation",
    },
    {
      name: "terminal provider failure",
      events: [
        {
          type: "turn.failed",
          error: { message: "Bearer PRIVATE_PROVIDER_SECRET" },
        },
      ],
      reason: "process_crashed",
    },
  ])(
    "fails closed for $name without disclosing provider content",
    async ({ events, reason }) => {
      const { createNativeCodexAdapter } =
        await import("../../src/adapters/native-codex.js");
      const root = await temporary();
      const adapter = createNativeCodexAdapter(
        { type: "codex", api_key_env: "TEST_KEY" },
        {
          applicationDataDirectory: join(root, "application"),
          environment: { TEST_KEY: "fixture" },
          createClient: () =>
            ({
              startThread: () => ({
                runStreamed: async () => ({
                  events: (async function* () {
                    for (const event of events) yield event as ThreadEvent;
                  })(),
                }),
              }),
            }) as never,
        },
      );
      const output = await collect(adapter.run(await input(root)));
      expect(output.at(-1)).toMatchObject({
        type: "failure",
        failure: { reason },
      });
      expect(JSON.stringify(output)).not.toContain("PRIVATE_PROVIDER_SECRET");
      expect(
        await readdir(join(root, "application", "runtime", "codex")),
      ).toEqual([]);
    },
  );

  it("lets the SDK recover transport interruptions and drains it before releasing the result", async () => {
    const { createNativeCodexAdapter } =
      await import("../../src/adapters/native-codex.js");
    const root = await temporary();
    let drained = false;
    let captured: CodexOptions | undefined;
    const adapter = createNativeCodexAdapter(
      { type: "codex", api_key_env: "TEST_KEY" },
      {
        applicationDataDirectory: join(root, "application"),
        environment: { TEST_KEY: "fixture" },
        createClient: (options) => {
          captured = options;
          return {
            startThread: () => ({
              runStreamed: async () => ({
                events: (async function* () {
                  yield { type: "error", message: "PRIVATE_RETRY_DETAIL" };
                  yield {
                    type: "item.completed",
                    item: {
                      id: "message",
                      type: "agent_message",
                      text: JSON.stringify(result()),
                    },
                  };
                  yield {
                    type: "turn.completed",
                    usage: {
                      input_tokens: 1,
                      cached_input_tokens: 0,
                      output_tokens: 1,
                    },
                  };
                  drained = true;
                })(),
              }),
            }),
          } as never;
        },
      },
    );
    const output = await collect(adapter.run(await input(root)));
    expect(output.at(-1)).toMatchObject({ type: "result", result: result() });
    expect(drained).toBe(true);
    expect(JSON.stringify(output)).not.toContain("PRIVATE_RETRY_DETAIL");
    expect(captured?.env).not.toHaveProperty("TEST_KEY");
    expect(captured?.apiKey).toBe("fixture");
  });

  it("forwards cancellation to the running SDK turn and removes its isolated home", async () => {
    const { createNativeCodexAdapter } =
      await import("../../src/adapters/native-codex.js");
    const root = await temporary();
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const adapter = createNativeCodexAdapter(
      { type: "codex", api_key_env: "TEST_KEY" },
      {
        applicationDataDirectory: join(root, "application"),
        environment: { TEST_KEY: "fixture" },
        createClient: () =>
          ({
            startThread: () => ({
              runStreamed: async (
                _prompt: string,
                options: { signal: AbortSignal },
              ) => ({
                events: (async function* () {
                  started();
                  await new Promise<void>((_resolve, reject) =>
                    options.signal.addEventListener(
                      "abort",
                      () => reject(options.signal.reason),
                      { once: true },
                    ),
                  );
                })(),
              }),
            }),
          }) as never,
      },
    );
    const review = await input(root);
    review.signal = controller.signal;
    const completion = collect(adapter.run(review));
    await ready;
    controller.abort();
    expect((await completion).at(-1)).toMatchObject({
      type: "failure",
      failure: { reason: "cancelled" },
    });
    expect(
      await readdir(join(root, "application", "runtime", "codex")),
    ).toEqual([]);
  });

  it("keeps long review policy and skill configuration out of Windows command arguments", async () => {
    const { createNativeCodexAdapter } =
      await import("../../src/adapters/native-codex.js");
    const root = await temporary();
    let runtimePolicy = "";
    let argumentsPolicy: unknown;
    const adapter = createNativeCodexAdapter(
      { type: "codex", api_key_env: "TEST_KEY" },
      {
        applicationDataDirectory: join(root, "application"),
        environment: { TEST_KEY: "fixture" },
        createClient: (options) =>
          ({
            startThread: () => ({
              runStreamed: async () => {
                argumentsPolicy = options.config;
                runtimePolicy = await readFile(
                  join(options.env!.CODEX_HOME!, "config.toml"),
                  "utf8",
                );
                return {
                  events: (async function* () {
                    yield {
                      type: "item.completed",
                      item: {
                        id: "message",
                        type: "agent_message",
                        text: JSON.stringify(result()),
                      },
                    };
                    yield {
                      type: "turn.completed",
                      usage: {
                        input_tokens: 1,
                        cached_input_tokens: 0,
                        output_tokens: 1,
                      },
                    };
                  })(),
                };
              },
            }),
          }) as never,
      },
    );
    const review = await input(root);
    review.prompt.system = "TRUSTED_LONG_POLICY".repeat(4000);
    expect((await collect(adapter.run(review))).at(-1)).toMatchObject({
      type: "result",
    });
    expect(runtimePolicy).toContain(review.prompt.system);
    expect(JSON.stringify(argumentsPolicy ?? {})).not.toContain(
      "TRUSTED_LONG_POLICY",
    );
  });

  it("keeps original review context readable from pinned policy after the user turn is compacted", async () => {
    const { createNativeCodexAdapter } =
      await import("../../src/adapters/native-codex.js");
    const root = await temporary();
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(join(workspace, "source.ts"), "NEW_VALUE\n");
    let runtimeDirectory = "";
    let contextPath = "";
    let persistentPolicy = "";
    let recovered: Record<string, any> | undefined;
    const adapter = createNativeCodexAdapter(
      { type: "codex", api_key_env: "KEY" },
      {
        applicationDataDirectory: join(root, "app"),
        environment: { KEY: "NEVER_WRITE_REAL_AUTH" },
        createClient: (options) =>
          ({
            startThread: (threadOptions: { workingDirectory: string }) => ({
              async runStreamed() {
                // Model lost the first user message. Use only persistent developer
                // policy and the file it identifies to reconstruct the original task.
                runtimeDirectory = threadOptions.workingDirectory;
                persistentPolicy = String(
                  parseToml(
                    await readFile(
                      join(options.env!.CODEX_HOME!, "config.toml"),
                      "utf8",
                    ),
                  ).developer_instructions,
                );
                const files = (await readdir(runtimeDirectory)).filter((name) =>
                  /^native-context-[a-f0-9]{64}\.json$/.test(name),
                );
                if (files[0]) {
                  contextPath = join(runtimeDirectory, files[0]);
                  recovered = JSON.parse(await readFile(contextPath, "utf8"));
                }
                return {
                  events: (async function* () {
                    yield {
                      type: "item.completed",
                      item: {
                        id: "final",
                        type: "agent_message",
                        text: JSON.stringify(result()),
                      },
                    };
                    yield {
                      type: "turn.completed",
                      usage: {
                        input_tokens: 1,
                        cached_input_tokens: 0,
                        output_tokens: 1,
                      },
                    };
                  })(),
                };
              },
            }),
          }) as never,
      },
    );
    const review = await input(workspace);
    const originalDiff =
      "diff --git a/source.ts b/source.ts\n@@ -1 +1 @@\n-OLD_VALUE\n+NEW_VALUE\n";
    review.context = resolvedContext({
      workspace,
      instructions: "Check the original requested behavior.",
      caller_context: {
        ticket: "ORIGINAL_REQUEST_CONTEXT",
        api_key: "REDACT_THIS_CONTEXT_SECRET",
      },
      request: { schema_version: "3", request_id: "original-request" },
      review_scope: {
        mode: "changes",
        source: "request",
        base: "PINNED_BASE",
        head: "PINNED_HEAD",
      },
      git: {
        is_repository: true,
        root: workspace,
        branch: "fixture",
        head: "PINNED_HEAD",
        merge_base: "PINNED_BASE",
        status_entries: [],
        changed_files: ["source.ts"],
        diff_stat: "1 file changed",
        diff: originalDiff,
        truncated: {
          status_entries: false,
          changed_files: false,
          diff_stat: false,
          diff: false,
        },
      },
    });
    review.prompt.user =
      "This first user turn is intentionally unavailable after compaction.";
    const events = await collect(adapter.run(review));
    expect(events.at(-1)?.type).toBe("result");
    expect(recovered).toMatchObject({
      schema_version: "1",
      kind: "review-mesh.native-context",
      changed_paths: ["source.ts"],
      context: {
        instructions: "Check the original requested behavior.",
        caller_context: {
          ticket: "ORIGINAL_REQUEST_CONTEXT",
          api_key: "[redacted]",
        },
        request: { request_id: "original-request" },
        git: {
          diff: originalDiff,
          head: "PINNED_HEAD",
          merge_base: "PINNED_BASE",
        },
      },
    });
    expect(contextPath).not.toBe("");
    expect(persistentPolicy).toContain(JSON.stringify(contextPath));
    expect(persistentPolicy).toContain("TRUSTED_REVIEW_POLICY");
    expect(JSON.stringify({ recovered, persistentPolicy })).not.toMatch(
      /NEVER_WRITE_REAL_AUTH|REDACT_THIS_CONTEXT_SECRET/,
    );
    expect(contextPath.startsWith(workspace)).toBe(false);
    await expect(access(runtimeDirectory)).rejects.toThrow();
    expect(await readdir(workspace)).toEqual(["source.ts"]);
  });

  it("runs one native SDK turn with isolated project content, schema output and a denied workspace write", async () => {
    const { createNativeCodexAdapter } =
      await import("../../src/adapters/native-codex.js");
    const root = await temporary();
    const workspace = join(root, "workspace");
    await mkdir(join(workspace, ".agents", "skills", "hostile_project_skill"), {
      recursive: true,
    });
    await mkdir(join(workspace, ".codex"), { recursive: true });
    await writeFile(join(workspace, "source.txt"), "READ_ONLY_FIXTURE");
    await writeFile(join(workspace, "AGENTS.md"), "HOSTILE_AGENTS_BODY");
    await writeFile(
      join(workspace, ".agents", "skills", "hostile_project_skill", "SKILL.md"),
      "---\nname: hostile_project_skill\ndescription: HOSTILE_SKILL_METADATA\n---\nHOSTILE_SKILL_BODY",
    );
    await writeFile(
      join(workspace, ".codex", "config.toml"),
      'developer_instructions="HOSTILE_CONFIG_BODY"\n[mcp_servers.hostile]\ncommand="DO_NOT_EXECUTE"\n[features]\nhooks=true\n',
    );
    const expectedResult = {
      ...result(),
      verdict: "fail",
      actionable_findings: [
        {
          id: "fixture",
          severity: "medium",
          title: "Fixture finding",
          description: "A structured fixture result.",
          evidence: [{ detail: "The fixture has no source citation." }],
          suggested_direction: "Review the fixture behavior.",
          confidence: "high",
          classification: "needs_verification",
          external_assumptions: [],
          category: "correctness",
          verification: "Fixture verification.",
          claim: {
            trigger: "Fixture input",
            affected_behavior: "Fixture behavior",
            outcome: "Fixture outcome",
          },
        },
      ],
    };
    const providerResult = {
      ...expectedResult,
      actionable_findings: expectedResult.actionable_findings.map(
        (finding) => ({
          ...finding,
          root_issue_id: null,
          duplicate_of: null,
          duplicate_finding_ids: null,
          change_impact: null,
          evidence: finding.evidence.map((evidence) => ({
            ...evidence,
            path: null,
            start_line: null,
            end_line: null,
          })),
        }),
      ),
    };
    const requests: {
      auth: string | undefined;
      request: Record<string, any>;
    }[] = [];
    const server = createServer();
    const sockets = new WebSocketServer({ server });
    let toolSent = false;
    sockets.on("connection", (socket, request) =>
      socket.on("message", (raw) => {
        const incoming = JSON.parse(raw.toString());
        requests.push({
          auth: request.headers.authorization,
          request: incoming,
        });
        let output: Record<string, unknown>[] = [];
        if (incoming.generate !== false && !toolSent) {
          toolSent = true;
          output = [
            {
              type: "function_call",
              id: "fc-fixture",
              call_id: "call-fixture",
              name: "exec_command",
              arguments: JSON.stringify({
                cmd:
                  process.platform === "win32"
                    ? "Get-Content -LiteralPath 'source.txt'; Set-Content -LiteralPath 'blocked-write.txt' -Value 'UNWANTED_WRITE'"
                    : "cat source.txt; printf UNWANTED_WRITE > blocked-write.txt",
                workdir: workspace,
                login: false,
                max_output_tokens: 1000,
              }),
            },
          ];
        } else if (incoming.generate !== false)
          output = [
            {
              id: "msg-fixture",
              type: "message",
              status: "completed",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify(providerResult),
                  annotations: [],
                },
              ],
            },
          ];
        const response = {
          id: `resp-${requests.length}`,
          object: "response",
          created_at: 1,
          status: "completed",
          model: "gpt-5.1-codex-mini",
          output,
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            total_tokens: 2,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        };
        for (const event of [
          {
            type: "response.created",
            response: { ...response, status: "in_progress", output: [] },
          },
          ...output.map((item, index) => ({
            type: "response.output_item.done",
            output_index: index,
            item,
          })),
          { type: "response.completed", response },
        ])
          socket.send(JSON.stringify(event));
      }),
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as { port: number }).port;
    const registration = {
      type: "codex" as const,
      api_key_env: "TEST_KEY",
      base_url_env: "TEST_URL",
    };
    const adapter = createNativeCodexAdapter(registration, {
      applicationDataDirectory: join(root, "application"),
      environment: {
        ...process.env,
        TEST_KEY: "PUBLIC_FIXTURE_KEY",
        TEST_URL: `http://127.0.0.1:${port}/v1`,
        UNSELECTED_SECRET: "DO_NOT_FORWARD",
      },
    });
    const review = await input(workspace, registration);
    review.prompt.user =
      "Review the workspace. Use $hostile_project_skill and $banner-design.";
    review.signal = AbortSignal.timeout(15_000);
    try {
      expect(await adapter.probe(review.reviewer, review.signal)).toMatchObject(
        {
          available: true,
          authenticated: true,
          maximumIsolation: "runtime_read_only",
        },
      );
      const events = await collect(adapter.run(review));
      expect(events.at(-1)).toMatchObject({
        type: "result",
        result: expectedResult,
        isolation: "runtime_read_only",
      });
      expect(requests.length).toBeGreaterThan(0);
      expect(
        requests.every((entry) => entry.auth === "Bearer PUBLIC_FIXTURE_KEY"),
      ).toBe(true);
      const bodies = JSON.stringify(requests.map((entry) => entry.request));
      expect(bodies).not.toMatch(
        /HOSTILE_(AGENTS_BODY|CONFIG_BODY|SKILL_BODY|SKILL_METADATA)|DO_NOT_FORWARD|<skill>/,
      );
      expect(bodies).toContain("READ_ONLY_FIXTURE");
      expect(bodies).toContain("TRUSTED_REVIEW_POLICY");
      const format = requests.find(
        (entry) => entry.request.text?.format?.type === "json_schema",
      )!.request.text.format;
      expect(format.strict).toBe(true);
      assertStrictSchema(format.schema);
      await expect(
        access(join(workspace, "blocked-write.txt")),
      ).rejects.toThrow();
      expect(JSON.stringify(events)).not.toContain("PUBLIC_FIXTURE_KEY");
      expect(
        await readdir(join(root, "application", "runtime", "codex")),
      ).toEqual([]);
    } finally {
      await adapter.forceCleanup?.();
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 25_000);
});
