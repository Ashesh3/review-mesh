import { expect, it } from "vitest";
import {
  access,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeClaudeAdapter } from "../../src/adapters/native-claude.js";
import { resolvedReviewer, resolvedContext } from "../helpers/fixtures.js";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createServer } from "node:http";
import { nativeResultJsonSchema } from "../../src/protocol/native-review.js";
it("keeps the original context readable through a system pointer after compaction and cleans it with the private home", async () => {
  let retainedPath: string | undefined;
  let system = "";
  let retained:
    { context: { git: { diff: string } }; changed_paths: string[] } | undefined;
  const originalDiff =
    "diff --git a/source.ts b/source.ts\n--- a/source.ts\n+++ b/source.ts\n@@ -1 +1 @@\n-old\n+new\n";
  const context = resolvedContext({
    git: {
      is_repository: true,
      root: "F:/fixture",
      branch: "main",
      head: "a".repeat(40),
      merge_base: "b".repeat(40),
      status_entries: [],
      changed_files: ["source.ts", "support.ts"],
      diff_stat: "",
      diff: originalDiff,
      truncated: {
        status_entries: false,
        changed_files: false,
        diff_stat: false,
        diff: false,
      },
    },
  });
  const adapter = createNativeClaudeAdapter(
    { type: "claude", api_key_env: "KEY" },
    {
      environment: { KEY: "fixture" },
      runtime: () => ({
        executablePath: "fixture",
        pathEntries: [],
        sdkVersion: "fixture",
        runtimeVersion: "fixture",
        mode: "managed_process",
      }),
      query: ({ options }) =>
        (async function* () {
          system = String(options.systemPrompt);
          const contextDirectory = options.additionalDirectories?.[0];
          expect(contextDirectory).toBe(
            await realpath(
              join(options.env!.CLAUDE_CONFIG_DIR!, "review-context"),
            ),
          );
          expect(options.additionalDirectories).toHaveLength(1);
          const files = await readdir(contextDirectory!);
          const file = files.find(
            (name) =>
              name.startsWith("native-context-") && name.endsWith(".json"),
          );
          if (file) {
            retainedPath = join(contextDirectory!, file);
            // Reading is the SDK's native tool boundary; no reconstructed prompt is needed.
            retained = JSON.parse(await readFile(retainedPath, "utf8"));
          }
          yield {
            type: "system",
            subtype: "compact_boundary",
            uuid: "00000000-0000-0000-0000-000000000001",
            session_id: "00000000-0000-0000-0000-000000000002",
            compact_metadata: { trigger: "auto", pre_tokens: 100000 },
          } as SDKMessage;
        })(),
    },
  );
  for await (const _event of adapter.run({
    runId: "fixture",
    reviewer: resolvedReviewer({ adapter: { type: "claude" } }),
    context,
    prompt: {
      system: "Trusted review instructions.",
      user: "Original context was compacted.",
      combined: "Review",
    },
    resultJsonSchema: { type: "object" },
    isolationPolicy: "prefer_enforced",
    signal: new AbortController().signal,
  })) {
    /* drain */
  }
  expect(retained?.context.git.diff).toBe(originalDiff);
  expect(retained?.changed_paths).toEqual(["source.ts", "support.ts"]);
  expect(system).toContain("Trusted review instructions.");
  expect(system).toContain("after compaction");
  expect(system).toContain("native-context-");
  expect(retainedPath).toBeDefined();
  expect(existsSync(retainedPath!)).toBe(false);
});

it("keeps bounded sanitized SDK errors without leaking selected credential values", async () => {
  const diagnostics: unknown[] = [];
  const secret = "plain-fixture-secret";
  const endpoint = "https://private-provider.invalid/v1";
  const adapter = createNativeClaudeAdapter(
    { type: "claude", api_key_env: "KEY", base_url_env: "URL" },
    {
      environment: { KEY: secret, URL: endpoint },
      runtime: () => ({
        executablePath: "fixture",
        pathEntries: [],
        sdkVersion: "fixture",
        runtimeVersion: "fixture",
        mode: "managed_process",
      }),
      query: ({ options }) => {
        options.stderr?.(`unsupported schema ${endpoint} ${secret}`);
        throw new Error(`SDK failed ${secret} ${endpoint}`);
      },
    },
  );
  const events = [];
  for await (const event of adapter.run({
    runId: "run-test",
    reviewer: resolvedReviewer({ adapter: { type: "claude" } }),
    context: resolvedContext(),
    prompt: { system: "Review", user: "Input", combined: "Review" },
    resultJsonSchema: { type: "object" },
    isolationPolicy: "prefer_enforced",
    signal: new AbortController().signal,
    recordDiagnostic: async (diagnostic) => {
      diagnostics.push(diagnostic);
    },
  }))
    events.push(event);
  expect(diagnostics).toMatchObject([
    {
      kind: "adapter_exception",
      diagnostics: {
        exception_message: expect.stringContaining("SDK failed"),
        provider_error_message: expect.stringContaining("unsupported schema"),
      },
    },
  ]);
  const serialized = JSON.stringify([diagnostics, events]);
  expect(serialized).not.toContain(secret);
  expect(serialized).not.toContain(endpoint);
});

it("distinguishes the Claude SDK and runtime versions even when the isolation policy blocks startup", async () => {
  const adapter = createNativeClaudeAdapter(
    { type: "claude", api_key_env: "KEY" },
    {
      environment: { KEY: "fixture" },
      runtime: () => ({
        executablePath: "fixture",
        pathEntries: [],
        sdkVersion: "0.3.251",
        runtimeVersion: "2.1.251",
        mode: "managed_process",
      }),
    },
  );
  expect(
    await adapter.probe(
      resolvedReviewer({ isolationPolicy: "require_enforced" }),
      new AbortController().signal,
    ),
  ).toMatchObject({
    available: false,
    sdk_version: "0.3.251",
    runtime_version: "2.1.251",
  });
});

it.each([
  [
    "missing explicitly configured key",
    {
      type: "claude",
      api_key_env: "MISSING",
      env_allowlist: ["ANTHROPIC_API_KEY"],
    },
    { ANTHROPIC_API_KEY: "ambient-fallback" },
  ],
  [
    "prototype inherited key",
    { type: "claude", api_key_env: "KEY" },
    Object.create({ KEY: "inherited-secret" }),
  ],
  [
    "empty explicitly configured key",
    { type: "claude", api_key_env: "KEY" },
    { KEY: "  " },
  ],
  [
    "missing configured provider URL",
    {
      type: "claude",
      api_key_env: "KEY",
      base_url_env: "MISSING",
      env_allowlist: ["ANTHROPIC_BASE_URL"],
    },
    { KEY: "fixture", ANTHROPIC_BASE_URL: "https://fallback.invalid" },
  ],
  [
    "prototype inherited provider URL",
    { type: "claude", api_key_env: "KEY", base_url_env: "URL" },
    Object.assign(Object.create({ URL: "https://inherited.invalid" }), {
      KEY: "fixture",
    }),
  ],
  [
    "non-HTTP provider URL",
    { type: "claude", api_key_env: "KEY", base_url_env: "URL" },
    { KEY: "fixture", URL: "file:///secret/config" },
  ],
  [
    "provider URL with credentials",
    { type: "claude", api_key_env: "KEY", base_url_env: "URL" },
    { KEY: "fixture", URL: "https://username:password@example.invalid" },
  ],
  [
    "no selected credentials",
    { type: "claude" },
    { ANTHROPIC_API_KEY: "unselected" },
  ],
] as const)(
  "rejects %s before probe or review can start a vendor process",
  async (_name, registration, environment) => {
    let calls = 0;
    const adapter = createNativeClaudeAdapter(
      registration as Parameters<typeof createNativeClaudeAdapter>[0],
      {
        environment,
        runtime: () => ({
          executablePath: "fixture",
          pathEntries: [],
          sdkVersion: "fixture",
          runtimeVersion: "fixture",
          mode: "managed_process",
        }),
        query: () => {
          calls++;
          return (async function* () {})();
        },
      },
    );
    const reviewer = resolvedReviewer({ adapter: { type: "claude" } });
    await expect(
      adapter.probe(reviewer, new AbortController().signal),
    ).resolves.toMatchObject({ available: false, authenticated: false });
    const events = [];
    for await (const event of adapter.run({
      runId: "run-test",
      reviewer,
      context: resolvedContext(),
      prompt: { system: "Review", user: "Input", combined: "Review Input" },
      resultJsonSchema: { type: "object" },
      isolationPolicy: "prefer_enforced",
      signal: new AbortController().signal,
    }))
      events.push(event);
    expect(calls).toBe(0);
    expect(events).toMatchObject([
      { type: "failure", failure: { reason: "adapter_unavailable" } },
    ]);
    expect(JSON.stringify(events)).not.toContain("password");
  },
);

it("returns the complete structured review and native attestation from one SDK result", async () => {
  const result = {
    schema_version: "4",
    verdict: "pass",
    review_markdown: "# Review\nNo findings.",
    summary: "No findings.",
    actionable_findings: [],
    informational_notes: [],
    native_scope_attestation: {
      reviewed_paths: ["source.ts"],
      complete: true,
      limitations: [],
    },
  };
  const adapter = createNativeClaudeAdapter(
    { type: "claude", api_key_env: "KEY" },
    {
      environment: { KEY: "fixture" },
      runtime: () => ({
        executablePath: "fixture",
        pathEntries: [],
        sdkVersion: "fixture",
        runtimeVersion: "fixture",
        mode: "managed_process",
      }),
      query: () =>
        (async function* () {
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            structured_output: result,
          } as SDKMessage;
        })(),
    },
  );
  const reviewer = resolvedReviewer({ adapter: { type: "claude" } });
  const events = [];
  for await (const event of adapter.run({
    runId: "run-test",
    reviewer,
    context: resolvedContext(),
    prompt: { system: "Review", user: "Input", combined: "Review Input" },
    resultJsonSchema: nativeResultJsonSchema(reviewer),
    isolationPolicy: "prefer_enforced",
    signal: new AbortController().signal,
  }))
    events.push(event);
  expect(events).toEqual([
    { type: "result", result, isolation: "runtime_read_only" },
  ]);
});

it.each([
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
])(
  "preserves native %s authentication without inserting an API-key relay",
  async (provider) => {
    let captured: Options | undefined;
    const adapter = createNativeClaudeAdapter(
      { type: "claude", env_allowlist: [provider] },
      {
        environment: { [provider]: "1" },
        runtime: () => ({
          executablePath: "fixture",
          pathEntries: [],
          sdkVersion: "fixture",
          runtimeVersion: "fixture",
          mode: "managed_process",
        }),
        query: ({ options }) => {
          captured = options;
          return (async function* () {})();
        },
      },
    );
    for await (const _event of adapter.run({
      runId: "provider-fixture",
      reviewer: resolvedReviewer({ adapter: { type: "claude" } }),
      context: resolvedContext(),
      prompt: { system: "Review", user: "Review", combined: "Review" },
      resultJsonSchema: { type: "object" },
      isolationPolicy: "prefer_enforced",
      signal: new AbortController().signal,
    })) {
      /* drain */
    }
    expect(captured?.env?.[provider]).toBe("1");
    expect(captured?.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(captured?.env?.ANTHROPIC_BASE_URL).toBeUndefined();
  },
);

it("returns cancelled without starting the SDK when cancellation predates admission", async () => {
  let calls = 0;
  const adapter = createNativeClaudeAdapter(
    { type: "claude" },
    {
      runtime: () => ({
        executablePath: "fixture",
        pathEntries: [],
        sdkVersion: "fixture",
        runtimeVersion: "fixture",
        mode: "managed_process",
      }),
      query: () => {
        calls++;
        return (async function* () {})();
      },
    },
  );
  const events = [];
  for await (const event of adapter.run({
    runId: "run-test",
    reviewer: resolvedReviewer({ adapter: { type: "claude" } }),
    context: resolvedContext(),
    prompt: { system: "Review", user: "Input", combined: "Review Input" },
    resultJsonSchema: { type: "object" },
    isolationPolicy: "prefer_enforced",
    signal: AbortSignal.abort(),
  }))
    events.push(event);
  expect(calls).toBe(0);
  expect(events).toMatchObject([
    { type: "failure", failure: { reason: "cancelled" } },
  ]);
});

it("reports unavailable when the packaged runtime is missing without throwing from probe", async () => {
  const adapter = createNativeClaudeAdapter(
    { type: "claude", api_key_env: "KEY" },
    {
      environment: { KEY: "fixture" },
      runtime: () => {
        throw new Error("missing executable");
      },
    },
  );
  await expect(
    adapter.probe(
      resolvedReviewer({ adapter: { type: "claude" } }),
      new AbortController().signal,
    ),
  ).resolves.toMatchObject({ available: false });
});

it("waits for actual child exit before deleting the private runtime home", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "review-mesh-claude-cleanup-"));
  const exitMarker = join(fixture, "exited");
  const childScript = join(fixture, "runtime.cjs");
  await writeFile(
    childScript,
    `const fs = require('node:fs'); process.stdin.resume(); process.stdin.on('end', () => setTimeout(() => { fs.writeFileSync(process.argv[2], 'closed'); process.exit(0); }, 150)); process.stdout.write('ready');`,
  );
  let privateHome: string | undefined;
  const adapter = createNativeClaudeAdapter(
    { type: "claude", api_key_env: "KEY" },
    {
      environment: { ...process.env, KEY: "fixture" },
      runtime: () => ({
        executablePath: "fixture",
        pathEntries: [],
        sdkVersion: "fixture",
        runtimeVersion: "fixture",
        mode: "managed_process",
      }),
      query: ({ options }) => {
        privateHome = options.env!.CLAUDE_CONFIG_DIR;
        const child = options.spawnClaudeCodeProcess!({
          command: process.execPath,
          args: [childScript, exitMarker],
          cwd: privateHome!,
          env: options.env!,
          signal: new AbortController().signal,
        });
        const ready = new Promise<void>((resolve) =>
          child.stdout.once("data", () => resolve()),
        );
        return {
          close: () => child.stdin.end(),
          async *[Symbol.asyncIterator]() {
            await ready;
            yield {
              type: "result",
              subtype: "success",
              is_error: false,
              result: "missing output",
            } as SDKMessage;
          },
        };
      },
    },
  );
  try {
    for await (const _event of adapter.run({
      runId: "run-test",
      reviewer: resolvedReviewer({ adapter: { type: "claude" } }),
      context: resolvedContext(),
      prompt: { system: "Review", user: "Input", combined: "Review Input" },
      resultJsonSchema: { type: "object" },
      isolationPolicy: "prefer_enforced",
      signal: new AbortController().signal,
    })) {
      /* drain cleanup */
    }
    await expect(access(exitMarker)).resolves.toBeUndefined();
    expect(privateHome).toBeDefined();
    expect(existsSync(privateHome!)).toBe(false);
  } finally {
    await adapter.forceCleanup?.();
    await rm(fixture, { recursive: true, force: true });
  }
});

it.runIf(process.env.REVIEW_MESH_VERIFY_SDK_RUNTIME === "1")(
  "cancels the actual Claude SDK after reaching a local provider and waits for shutdown",
  async () => {
    let requests = 0;
    const requestPaths: string[] = [];
    const controller = new AbortController();
    const server = createServer((request, response) => {
      request.resume();
      requestPaths.push((request.url ?? "").split("?")[0]!);
      if (request.url?.includes("/messages")) {
        requests++;
        setTimeout(() => controller.abort(), 100);
      }
      response.writeHead(401, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          type: "error",
          error: {
            type: "authentication_error",
            message: "Local runtime fixture refuses authentication",
          },
        }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No local fixture port");
    const workspace = await mkdtemp(
      join(tmpdir(), "review-mesh-claude-provider-"),
    );
    const adapter = createNativeClaudeAdapter(
      {
        type: "claude",
        api_key_env: "FIXTURE_KEY",
        base_url_env: "FIXTURE_URL",
        env_allowlist: ["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"],
      },
      {
        environment: {
          ...process.env,
          FIXTURE_KEY: "local-fixture-key",
          FIXTURE_URL: `http://127.0.0.1:${address.port}/gateway/v1`,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        },
      },
    );
    try {
      const events = [];
      for await (const event of adapter.run({
        runId: "run-test",
        reviewer: resolvedReviewer({
          model: "claude-sonnet-4-6",
          adapter: { type: "claude" },
        }),
        context: resolvedContext({ workspace }),
        prompt: {
          system: "Review this local fixture.",
          user: "Return a review.",
          combined: "Review",
        },
        resultJsonSchema: nativeResultJsonSchema(
          resolvedReviewer({ adapter: { type: "claude" } }),
        ),
        isolationPolicy: "prefer_enforced",
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(20000),
        ]),
      }))
        events.push(event);
      expect(requests).toBeGreaterThan(0);
      expect(
        requestPaths.some((path) => path.startsWith("/gateway/v1/messages")),
      ).toBe(true);
      expect(requestPaths.some((path) => path.includes("/v1/v1/"))).toBe(false);
      expect(events.at(-1)).toMatchObject({
        type: "failure",
        failure: { reason: "cancelled" },
      });
      await adapter.forceCleanup?.();
      await expect(
        rm(workspace, { recursive: true, force: true }),
      ).resolves.toBeUndefined();
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

it("keeps Claude's native tools and uses one SDK session even for a terminal provider error", async () => {
  let calls = 0;
  let options: Options | undefined;
  const adapter = createNativeClaudeAdapter(
    { type: "claude", api_key_env: "REVIEW_KEY", base_url_env: "REVIEW_URL" },
    {
      environment: {
        REVIEW_KEY: "test-only",
        REVIEW_URL: "http://127.0.0.1:34567/vendor-prefix",
      },
      runtime: () => ({
        executablePath: "fixture",
        pathEntries: [],
        sdkVersion: "fixture",
        runtimeVersion: "fixture",
        mode: "managed_process",
      }),
      query: ({ options: opts }) => {
        calls++;
        options = opts;
        return (async function* () {
          yield {
            type: "result",
            subtype: "error_during_execution",
            is_error: true,
            errors: ["Provider rate limited"],
          } as SDKMessage;
        })();
      },
    },
  );
  const events = [];
  for await (const event of adapter.run({
    runId: "run-test",
    reviewer: resolvedReviewer({
      model: "claude-opus",
      adapter: { type: "claude" },
    }),
    context: resolvedContext(),
    prompt: { system: "Review", user: "Input", combined: "Review Input" },
    resultJsonSchema: { type: "object" },
    isolationPolicy: "prefer_enforced",
    signal: new AbortController().signal,
  }))
    events.push(event);
  expect(calls).toBe(1);
  expect(options?.tools).toEqual(["Read", "Glob", "Grep", "Bash"]);
  expect(options?.disallowedTools).not.toContain("Bash");
  expect(options?.disallowedTools).toEqual(
    expect.arrayContaining(["Edit", "Write", "NotebookEdit"]),
  );
  expect(options?.permissionMode).toBe("dontAsk");
  expect(options?.mcpServers).toEqual({});
  expect(options?.settings).toMatchObject({
    autoCompactEnabled: true,
  });
  expect(options?.settings).not.toHaveProperty("autoCompactWindow");
  expect(options?.hooks?.PreCompact).toHaveLength(1);
  expect(options?.hooks?.PostCompact).toHaveLength(1);
  expect(options?.env?.CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS).toBeUndefined();
  expect(options?.env?.ANTHROPIC_API_KEY).not.toBe("test-only");
  expect(options?.env?.ANTHROPIC_API_KEY).toMatch(/^[a-f0-9]{64}$/);
  expect(options?.env?.ANTHROPIC_BASE_URL).toMatch(
    /^http:\/\/127\.0\.0\.1:\d+$/,
  );
  expect(events.at(-1)).toMatchObject({ type: "failure" });
});

it("uses native read-only permissions without directing the model's file pagination", async () => {
  let options: Options | undefined;
  const adapter = createNativeClaudeAdapter(
    { type: "claude", api_key_env: "KEY" },
    {
      environment: { KEY: "fixture" },
      runtime: () => ({
        executablePath: "fixture",
        pathEntries: [],
        sdkVersion: "fixture",
        runtimeVersion: "fixture",
        mode: "managed_process",
      }),
      query: (input) => {
        options = input.options;
        return (async function* () {})();
      },
    },
  );
  for await (const _event of adapter.run({
    runId: "fixture",
    reviewer: resolvedReviewer({ adapter: { type: "claude" } }),
    context: resolvedContext(),
    prompt: {
      system: "Read all required files.",
      user: "Read",
      combined: "Read",
    },
    resultJsonSchema: { type: "object" },
    isolationPolicy: "prefer_enforced",
    signal: new AbortController().signal,
  })) {
    /* drain */
  }
  expect(options?.hooks?.PostToolUse).toBeUndefined();
  expect(options?.env?.CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS).toBeUndefined();
  const permission = options!.canUseTool!;
  const details = {
    signal: new AbortController().signal,
    toolUseID: "fixture",
    requestId: "fixture",
  };
  for (const name of ["Read", "Glob", "Grep"])
    expect(
      await permission(name, { file_path: "source.ts" }, details),
    ).toMatchObject({ behavior: "allow" });
  // The SDK approves known read-only Git commands itself. Anything reaching
  // this fallback required approval and is not blanket-approved by the host.
  for (const name of ["Bash", "Edit", "Write", "WebFetch"])
    expect(
      await permission(name, { command: "write to source.ts" }, details),
    ).toMatchObject({ behavior: "deny" });
});

it("rejects native success without structured output", async () => {
  const adapter = createNativeClaudeAdapter(
    { type: "claude", api_key_env: "REVIEW_KEY" },
    {
      environment: { REVIEW_KEY: "test-only" },
      runtime: () => ({
        executablePath: "fixture",
        pathEntries: [],
        sdkVersion: "fixture",
        runtimeVersion: "fixture",
        mode: "managed_process",
      }),
      query: () =>
        (async function* () {
          yield {
            type: "result",
            subtype: "success",
            is_error: false,
            result: "plain text",
          } as SDKMessage;
        })(),
    },
  );
  const events = [];
  for await (const event of adapter.run({
    runId: "run-test",
    reviewer: resolvedReviewer({
      model: "claude-opus",
      adapter: { type: "claude" },
    }),
    context: resolvedContext(),
    prompt: { system: "Review", user: "Input", combined: "Review Input" },
    resultJsonSchema: { type: "object" },
    isolationPolicy: "prefer_enforced",
    signal: new AbortController().signal,
  }))
    events.push(event);
  expect(events.at(-1)).toMatchObject({
    type: "failure",
    failure: { reason: "invalid_result" },
  });
});
