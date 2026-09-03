import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
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

  it.skipIf(!verifyStandalone || !windowsExecutableExists)(
    "serves the embedded dashboard from the exact Windows release executable",
    async () => {
      const appData = await mkdtemp(
        join(tmpdir(), "review-mesh-standalone-dashboard-"),
      );
      const child = spawn(
        windowsExecutable,
        ["serve", "--host", "127.0.0.1", "--port", "0", "--no-open"],
        {
          cwd: tmpdir(),
          env: { ...process.env, APPDATA: appData, LOCALAPPDATA: appData },
          stdio: "pipe",
          windowsHide: true,
        },
      );
      try {
        const url = await new Promise<string>((resolveUrl, reject) => {
          let stdout = "";
          const timer = setTimeout(
            () => reject(new Error("dashboard URL was not printed")),
            15_000,
          );
          child.stdout.setEncoding("utf8");
          child.stdout.on("data", (chunk: string) => {
            stdout += chunk;
            const match = /Review Mesh dashboard: (http:\/\/[^\s]+)/u.exec(
              stdout,
            );
            if (match === null) return;
            clearTimeout(timer);
            resolveUrl(match[1]!);
          });
          child.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
        });
        const page = await fetch(url);
        expect(page.status).toBe(200);
        expect(await page.text()).toContain("Review Mesh");
        const snapshot = await fetch(new URL("api/snapshot", url));
        expect(snapshot.status).toBe(200);
        expect(await snapshot.json()).toMatchObject({
          server: { read_only: true },
        });
      } finally {
        child.kill("SIGTERM");
        await new Promise((resolveClose) => child.once("close", resolveClose));
        await rm(appData, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
