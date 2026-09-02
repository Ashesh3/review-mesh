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
const verifyStandalone = process.env.REVIEW_MESH_VERIFY_STANDALONE === "1";

describe.skipIf(process.platform !== "win32")("standalone CLI", () => {
  it.skipIf(!verifyStandalone || !windowsExecutableExists)(
    "prints agent-first help from the exact Windows release executable",
    async () => {
      const child = spawn(windowsExecutable, [], {
        cwd: projectRoot,
        stdio: "pipe",
        windowsHide: true,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.stdin.end();
      const exitCode = await new Promise<number | null>(
        (resolveExit, reject) => {
          child.once("error", reject);
          child.once("close", resolveExit);
        },
      );
      expect(exitCode).toBe(0);
      expect(Buffer.concat(stderr).toString("utf8")).toBe("");
      expect(Buffer.concat(stdout).toString("utf8")).toContain(
        "AGENT QUICK START",
      );
    },
    30_000,
  );
});
