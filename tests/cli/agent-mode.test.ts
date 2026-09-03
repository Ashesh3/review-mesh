import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../../src/cli.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("explicit agent-mode flags", () => {
  it("accepts compact/no-ansi/aggregate flags and resolves details-file", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-mesh-agent-mode-"));
    roots.push(root);
    const input = new PassThrough();
    input.end(
      JSON.stringify({
        schema_version: "2",
        project_name: "demo",
        workspace: root,
        instructions: "Review.",
        review_scope: { mode: "full" },
      }),
    );
    const runReview = vi.fn(async () => 0);
    await runCli(process, {
      argv: [
        "review",
        "--output-mode",
        "compact-jsonl",
        "--no-ansi",
        "--heartbeat",
        "aggregate",
        "--details-file",
        "details.jsonl",
      ],
      cwd: root,
      input,
      output: new PassThrough(),
      error: new PassThrough(),
      runReview,
    });
    expect(runReview).toHaveBeenCalledWith(
      expect.objectContaining({ detailsFile: join(root, "details.jsonl") }),
    );
  });

  it("rejects unsupported output modes", async () => {
    const error = new PassThrough();
    error.setEncoding("utf8");
    let encoded = "";
    error.on("data", (chunk: string) => (encoded += chunk));
    await runCli(process, {
      argv: ["review", "--output-mode", "verbose"],
      input: Object.assign(new PassThrough(), { isTTY: true }),
      output: new PassThrough(),
      error,
    });
    expect(encoded).toContain("invalid_usage");
  });

  it.each([
    ["missing details value", ["review", "--details-file", "--no-ansi"]],
    [
      "duplicate details option",
      ["review", "--details-file", "one.jsonl", "--details-file", "two.jsonl"],
    ],
    [
      "duplicate output mode",
      [
        "review",
        "--output-mode",
        "compact-jsonl",
        "--output-mode",
        "compact-jsonl",
      ],
    ],
  ])("rejects %s", async (_label, argv) => {
    const error = new PassThrough();
    error.setEncoding("utf8");
    let encoded = "";
    error.on("data", (chunk: string) => (encoded += chunk));
    const runReview = vi.fn(async () => 0);

    await runCli(process, {
      argv,
      input: Object.assign(new PassThrough(), { isTTY: true }),
      output: new PassThrough(),
      error,
      runReview,
    });

    expect(encoded).toContain("invalid_usage");
    expect(runReview).not.toHaveBeenCalled();
  });
});
