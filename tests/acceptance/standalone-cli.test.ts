import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const projectRoot = resolve(import.meta.dirname, "../..");
const windowsExecutable = join(
  projectRoot,
  "dist",
  "release",
  "review-mesh-windows-x64.exe",
);

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const windowsExecutableExists = await exists(windowsExecutable);

describe.skipIf(process.platform !== "win32")("standalone CLI", () => {
  it.skipIf(!windowsExecutableExists)(
    "runs the exact Windows release executable",
    async () => {
      const child = spawn(windowsExecutable, [], {
        cwd: projectRoot,
        stdio: "pipe",
        windowsHide: true,
      });
      const stderr: Buffer[] = [];
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.stdin.end();
      const exitCode = await new Promise<number | null>(
        (resolveExit, reject) => {
          child.once("error", reject);
          child.once("close", resolveExit);
        },
      );
      expect(exitCode).toBe(2);
      expect(Buffer.concat(stderr).toString("utf8")).toBe(
        `${JSON.stringify({
          error: "invalid_usage",
          message: "Expected exactly: review-mesh review",
        })}\n`,
      );
    },
    30_000,
  );
});
