import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/cli.js";

afterEach(() => {
  process.exitCode = undefined;
});

describe("review-mesh serve", () => {
  it("starts the injected dashboard without consuming stdin and opens interactively", async () => {
    const input = new PassThrough();
    input.write("leave unread");
    const output = new PassThrough() as PassThrough & { isTTY?: boolean };
    output.isTTY = true;
    const error = new PassThrough();
    let stdout = "";
    let stderr = "";
    let opened: string | undefined;
    output.on("data", (chunk) => (stdout += chunk.toString()));
    error.on("data", (chunk) => (stderr += chunk.toString()));
    const closed = Promise.resolve();
    await runCli(new EventEmitter(), {
      argv: ["serve"],
      input,
      output,
      error,
      startDashboard: async (options) => ({
        host: options.host,
        port: 1234,
        url: "http://127.0.0.1:1234/",
        startedAt: new Date().toISOString(),
        closed,
        close: async () => undefined,
      }),
      openBrowser: (url) => {
        opened = url;
      },
    });
    expect(process.exitCode).toBe(0);
    expect(stdout).toContain("http://127.0.0.1:1234/");
    expect(stderr).toBe("");
    expect(opened).toBe("http://127.0.0.1:1234/");
    expect(input.read()?.toString()).toBe("leave unread");
  });

  it.each([
    ["bad host", ["serve", "--host"]],
    ["bad port", ["serve", "--port", "not-a-port"]],
    ["out of range", ["serve", "--port", "70000"]],
    ["positional", ["serve", "workspace"]],
  ])("rejects %s", async (_label, argv) => {
    const output = new PassThrough();
    const error = new PassThrough();
    let stderr = "";
    output.resume();
    error.on("data", (chunk) => (stderr += chunk.toString()));
    await runCli(new EventEmitter(), { argv, output, error });
    expect(process.exitCode).toBe(2);
    expect(JSON.parse(stderr)).toMatchObject({ error: "invalid_usage" });
  });
});
