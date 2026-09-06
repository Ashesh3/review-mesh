import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createReadOnlyFileTools } from "../../src/adapters/file-tools.js";
import { createChangeCoverageLedger } from "../../src/context/change-coverage.js";
import type { ResolvedContext } from "../../src/context/resolve.js";
import { InspectionSession } from "../../src/adapters/inspection-session.js";
import { resolvedReviewer } from "../helpers/fixtures.js";
import { reviewerResultJsonSchema } from "../../src/protocol/json-schema.js";
import { createOpenAICompatibleAdapter } from "../../src/adapters/openai-compatible.js";
import { passResult } from "../helpers/fixtures.js";

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

function context(
  workspace: string,
  changedFiles = ["worker.ts"],
): ResolvedContext {
  return {
    consistency_mode: "live_worktree",
    workspace,
    project_name: "tools-test",
    instructions: "Review.",
    review_scope: { mode: "changes", source: "request" },
    git: {
      is_repository: true,
      root: workspace,
      branch: "main",
      head: "a".repeat(40),
      merge_base: "b".repeat(40),
      status_entries: [],
      changed_files: changedFiles,
      changed_paths: changedFiles.map((path) => ({
        path,
        kind: "untracked" as const,
      })),
      diff_stat: "",
      diff: "",
      raw_diff: { byte_count: 0, sha256: sha256("") },
      truncated: {
        status_entries: false,
        changed_files: false,
        diff_stat: false,
        diff: false,
      },
    },
  };
}

describe("createReadOnlyFileTools", () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(
      directories
        .splice(0)
        .map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it("preserves UTF-8 BOM bytes as readable source without a spurious tail", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-mesh-bom-"));
    directories.push(root);
    const source = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("class Synthetic { }\n".repeat(10_000)),
    ]);
    await writeFile(join(root, "worker.ts"), source);
    const ctx = context(root);
    const ledger = await createChangeCoverageLedger({
      context: ctx,
      policy: {
        relevantPaths: ["**"],
        minimumInspection: "full_file",
        proof: "observed",
      },
    });
    const read = await createReadOnlyFileTools({
      ledger,
      readable: true,
    }).readFile({ path: "worker.ts", byteCount: 128 * 1024 });
    expect(read.response).toMatchObject({
      encoding: "utf8",
      byte_count: 131072,
    });
    if (!read.response.ok) throw new Error("fixture unavailable");
    expect(
      Buffer.from(read.response.content, "utf8").equals(
        source.subarray(0, 131072),
      ),
    ).toBe(true);
    expect(read.response.content.charCodeAt(0)).toBe(0xfeff);
    const session = new InspectionSession(
      {
        runId: "bom",
        reviewer: resolvedReviewer(),
        context: ctx,
        coverage: ledger,
        prompt: {
          system: "synthetic",
          user: "synthetic",
          combined: "synthetic",
        },
        resultJsonSchema: reviewerResultJsonSchema,
        isolationPolicy: "prefer_enforced",
        signal: new AbortController().signal,
      },
      [],
    );
    await session.deliver(6 * 1024 * 1024);
    const ranges = session.messages.map((message) =>
      JSON.parse(String(message.content).split("\n").slice(1).join("\n")),
    );
    expect(
      ranges.map((range) => ({
        encoding: range.encoding,
        bytes: range.byte_count,
      })),
    ).toEqual([
      { encoding: "utf8", bytes: 131072 },
      { encoding: "utf8", bytes: source.length - 131072 },
    ]);
    expect(
      Buffer.concat(
        ranges.map((range) => Buffer.from(range.content, "utf8")),
      ).equals(source),
    ).toBe(true);
    await ledger.close();
  });

  it.each(["./src", "src/", "src\\", "./src//./", ".\\src\\"])(
    "normalizes harmless list and search prefix %s",
    async (path) => {
      const root = await mkdtemp(join(tmpdir(), "review-mesh-prefix-"));
      directories.push(root);
      await mkdir(join(root, "src"));
      await writeFile(join(root, "src", "worker.ts"), "needle\n");
      const ledger = await createChangeCoverageLedger({
        context: context(root, ["src/worker.ts"]),
        policy: {
          relevantPaths: ["**"],
          minimumInspection: "full_file",
          proof: "observed",
        },
      });
      const tools = createReadOnlyFileTools({ ledger });
      await expect(tools.listFiles({ path })).resolves.toMatchObject({
        files: [{ path: "src/worker.ts" }],
      });
      await expect(
        tools.searchText({ path, query: "needle" }),
      ).resolves.toMatchObject({
        matches: [{ path: "src/worker.ts", line: 1 }],
      });
      await ledger.close();
    },
  );

  it.each([
    "../private",
    "src/../private",
    "/private",
    "C:\\private",
    "\\\\host\\private",
    "src\u0000private",
  ])(
    "returns a repairable private tool error for forbidden prefix %s",
    async (path) => {
      const root = await mkdtemp(join(tmpdir(), "review-mesh-path-error-"));
      directories.push(root);
      await writeFile(join(root, "worker.ts"), "needle\n");
      const ledger = await createChangeCoverageLedger({
        context: context(root),
        policy: {
          relevantPaths: ["**"],
          minimumInspection: "full_file",
          proof: "observed",
        },
      });
      const tools = createReadOnlyFileTools({ ledger });
      const results = [
        await tools.listFiles({ path }),
        await tools.searchText({ path, query: "needle" }),
      ];
      for (const result of results) {
        expect(result).toMatchObject({
          error: expect.any(String),
          reason: "invalid_path",
          retryable: true,
        });
        expect(JSON.stringify(result)).not.toContain("private");
      }
      await expect(tools.listFiles({ path: "." })).resolves.toMatchObject({
        files: [{ path: "worker.ts" }],
      });
      await ledger.close();
    },
  );

  it("continues a real adapter review after an invalid list path", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-mesh-path-repair-"));
    directories.push(root);
    await writeFile(join(root, "worker.ts"), "needle\n");
    const ctx = context(root);
    const ledger = await createChangeCoverageLedger({
      context: ctx,
      policy: {
        relevantPaths: ["**"],
        minimumInspection: "full_file",
        proof: "observed",
      },
    });
    const registration = {
      type: "openai_compatible" as const,
      base_url_env: "URL",
      api_key_env: "KEY",
    };
    const requests: any[] = [];
    const adapter = createOpenAICompatibleAdapter(registration, {
      environment: { URL: "https://no-network.invalid/v1", KEY: "synthetic" },
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        requests.push(body);
        const message =
          requests.length === 1
            ? {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "bad-path",
                    type: "function",
                    function: {
                      name: "list_files",
                      arguments: '{"path":"../private"}',
                    },
                  },
                ],
              }
            : {
                role: "assistant",
                content: body.response_format
                  ? JSON.stringify(passResult("Recovered after tool error."))
                  : "Ready.",
              };
        return new Response(
          JSON.stringify({ choices: [{ message, finish_reason: "stop" }] }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });
    const events = [];
    for await (const event of adapter.run({
      runId: "path-repair",
      reviewer: resolvedReviewer({ adapter: registration }),
      context: ctx,
      coverage: ledger,
      prompt: { system: "synthetic", user: "synthetic", combined: "synthetic" },
      resultJsonSchema: reviewerResultJsonSchema,
      isolationPolicy: "prefer_enforced",
      signal: new AbortController().signal,
    }))
      events.push(event);
    expect(events.some((event) => event.type === "result")).toBe(true);
    expect(events.some((event) => event.type === "failure")).toBe(false);
    const errorResponse = requests[1].messages.find(
      (message: any) => message.role === "tool",
    );
    expect(JSON.parse(errorResponse.content)).toMatchObject({
      reason: "invalid_path",
      retryable: true,
    });
    expect(errorResponse.content).not.toContain("private");
    await ledger.close();
  });

  it("returns exact base64 bytes and records only an acknowledged response", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-mesh-tools-"));
    directories.push(root);
    await writeFile(join(root, "worker.ts"), "éclair", "utf8");
    const ledger = await createChangeCoverageLedger({
      context: context(root),
      policy: {
        relevantPaths: ["**"],
        minimumInspection: "full_file",
        proof: "observed",
      },
    });
    const tools = createReadOnlyFileTools({ ledger });

    const result = await tools.readFile({
      path: "worker.ts",
      offset: 0,
      byteCount: 3,
    });
    expect(result.response).toMatchObject({
      ok: true,
      path: "worker.ts",
      encoding: "base64",
      offset: 0,
      byte_count: 3,
      total_byte_count: Buffer.byteLength("éclair"),
      content: Buffer.from("éc", "utf8").toString("base64"),
      sha256: sha256("éc"),
      eof: false,
    });
    expect(ledger.summary().status).toBe("incomplete");
    expect(result.acknowledgeDelivered(JSON.stringify(result.response))).toBe(
      true,
    );
    expect(ledger.summary().status).toBe("incomplete");
  });

  it("credits only the exact serialized response admitted to the provider", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-mesh-tools-"));
    directories.push(root);
    await writeFile(join(root, "worker.ts"), "abcdef", "utf8");
    const ledger = await createChangeCoverageLedger({
      context: context(root),
      policy: {
        relevantPaths: ["**"],
        minimumInspection: "full_file",
        proof: "observed",
      },
    });
    const tools = createReadOnlyFileTools({ ledger });

    const altered = await tools.readFile({ path: "worker.ts" });
    if (!altered.response.ok) throw new Error(altered.response.reason);
    altered.response.content = "";
    expect(altered.acknowledgeDelivered(JSON.stringify(altered.response))).toBe(
      false,
    );
    expect(ledger.summary().status).toBe("incomplete");

    const admitted = await tools.readFile({ path: "worker.ts" });
    const serialized = JSON.stringify(admitted.response);
    expect(admitted.acknowledgeDelivered(serialized)).toBe(true);
    expect(ledger.summary().status).toBe("complete");
  });

  it("lists and searches pinned text without crediting full-file inspection", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-mesh-tools-"));
    directories.push(root);
    await writeFile(
      join(root, "worker.ts"),
      "first\nneedle here\nlast\n",
      "utf8",
    );
    await writeFile(join(root, "other.ts"), "needle there\n", "utf8");
    const ledger = await createChangeCoverageLedger({
      context: context(root, ["other.ts", "worker.ts"]),
      policy: {
        relevantPaths: ["**"],
        minimumInspection: "full_file",
        proof: "observed",
      },
    });
    const tools = createReadOnlyFileTools({ ledger });

    await expect(tools.listFiles({ path: "." })).resolves.toMatchObject({
      files: [
        { path: "other.ts", byte_count: 13 },
        { path: "worker.ts", byte_count: 23 },
      ],
      truncated: false,
    });
    await expect(
      tools.searchText({ query: "needle", path: "." }),
    ).resolves.toEqual({
      matches: [
        { path: "other.ts", line: 1, text: "needle there" },
        { path: "worker.ts", line: 2, text: "needle here" },
      ],
      truncated: false,
    });
    expect(ledger.summary()).toMatchObject({
      status: "incomplete",
      deficit_count: 2,
    });
  });

  it("lists whole-workspace snapshot files during a full review", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-mesh-tools-"));
    directories.push(root);
    await writeFile(join(root, "worker.ts"), "whole workspace\n", "utf8");
    const full = context(root, []);
    full.review_scope = { mode: "full", source: "request" };
    const ledger = await createChangeCoverageLedger({
      context: full,
      policy: {
        relevantPaths: ["**"],
        minimumInspection: "full_file",
        proof: "observed",
      },
    });
    const tools = createReadOnlyFileTools({ ledger });
    await expect(tools.listFiles()).resolves.toMatchObject({
      files: [{ path: "worker.ts", byte_count: 16 }],
    });
    expect(ledger.summary().status).toBe("not_applicable");
  });

  it("keeps full-review reads, listings, and searches inside the path filter", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-mesh-tools-"));
    directories.push(root);
    await mkdir(join(root, "allowed"));
    await mkdir(join(root, "outside"));
    await writeFile(join(root, "allowed", "worker.ts"), "needle allowed\n");
    await writeFile(join(root, "outside", "secret.ts"), "needle secret\n");
    const full = context(root, []);
    full.review_scope = {
      mode: "full",
      source: "request",
      paths: ["allowed"],
    };
    const ledger = await createChangeCoverageLedger({
      context: full,
      policy: {
        relevantPaths: ["**"],
        minimumInspection: "full_file",
        proof: "observed",
      },
    });
    const tools = createReadOnlyFileTools({ ledger });

    await expect(tools.listFiles()).resolves.toEqual({
      files: [{ path: "allowed/worker.ts", byte_count: 15 }],
      truncated: false,
    });
    await expect(tools.searchText({ query: "needle" })).resolves.toEqual({
      matches: [{ path: "allowed/worker.ts", line: 1, text: "needle allowed" }],
      truncated: false,
    });
    await expect(
      tools.readFile({ path: "outside/secret.ts" }),
    ).resolves.toMatchObject({
      response: {
        ok: false,
        path: "outside/secret.ts",
        reason: "unavailable",
      },
    });
  });
});
