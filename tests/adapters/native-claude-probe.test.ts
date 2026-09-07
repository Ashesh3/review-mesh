import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import type { Options, WarmQuery } from "@anthropic-ai/claude-agent-sdk";
import { createNativeClaudeAdapter } from "../../src/adapters/native-claude.js";
import { resolvedReviewer } from "../helpers/fixtures.js";

const vendor = vi.hoisted(() => ({ startup: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", async (original) => ({
  ...(await original<typeof import("@anthropic-ai/claude-agent-sdk")>()),
  startup: vendor.startup,
}));

it
  .runIf(process.platform === "win32")
  .each(["success", "cancel", "forceCleanup", "startupError"])(
  "retains the Windows probe root until its startup tree is stopped on %s",
  async (mode) => {
    const signal = new AbortController();
    let home: string | undefined;
    let descendantPid: number | undefined;
    let child: ReturnType<typeof spawn> | undefined;
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
      },
    );
    vendor.startup.mockImplementationOnce(
      async ({ options }: { options: Options }) => {
        home = options.env!.CLAUDE_CONFIG_DIR;
        child = options.spawnClaudeCodeProcess!({
          command: process.execPath,
          args: [
            "-e",
            `const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', "process.send('ready'); process.disconnect(); setInterval(() => {}, 60000)"], { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'ignore', 'ipc'], detached: true, windowsHide: true });
child.once('message', () => { child.unref(); process.stdout.write(String(child.pid)); });
process.stdin.resume(); process.stdin.once('end', () => process.exit(0));`,
          ],
          env: options.env!,
          cwd: home!,
          signal: new AbortController().signal,
        }) as ReturnType<typeof spawn>;
        child.stdin!.on("error", () => undefined);
        // Mirrors SDK close-on-abort: EOF would orphan the startup grandchildren.
        options.abortController!.signal.addEventListener(
          "abort",
          () => child?.stdin?.end(),
          { once: true },
        );
        descendantPid = await new Promise<number>((resolve, reject) => {
          child!.stdout!.once("data", (data) =>
            resolve(Number(data.toString())),
          );
          child!.once("error", reject);
        });
        if (mode === "cancel") signal.abort();
        if (mode === "forceCleanup") await adapter.forceCleanup?.();
        if (mode === "startupError") throw new Error("fixture startup failure");
        return {
          close: () => child?.stdin?.end(),
          [Symbol.asyncDispose]: async () => {
            child?.stdin?.end();
          },
          query: () => {
            throw new Error("Unused");
          },
        } satisfies WarmQuery;
      },
    );
    try {
      await expect(
        adapter.probe(
          resolvedReviewer({ adapter: { type: "claude" } }),
          signal.signal,
        ),
      ).resolves.toMatchObject({ available: mode === "success" });
      expect(home).toBeDefined();
      expect(existsSync(home!)).toBe(false);
      expect(() => process.kill(descendantPid!, 0)).toThrow();
    } finally {
      await adapter.forceCleanup?.();
      if (descendantPid) {
        try {
          process.kill(descendantPid);
        } catch {}
      }
      if (child && child.exitCode === null && child.signalCode === null)
        child.kill();
      if (home)
        await rm(home, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        });
    }
  },
);

it("does not start the vendor after a probe has been cancelled before admission", async () => {
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
    },
  );
  await expect(
    adapter.probe(
      resolvedReviewer({ adapter: { type: "claude" } }),
      AbortSignal.abort(),
    ),
  ).resolves.toMatchObject({
    available: false,
    message: "Claude probe cancelled.",
  });
  expect(vendor.startup).not.toHaveBeenCalled();
});
