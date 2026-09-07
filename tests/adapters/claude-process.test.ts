import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createClaudeProcessOwner } from "../../src/runtime/claude-process.js";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

it.runIf(process.platform === "win32")(
  "closes the owned Windows tree before its root exits and releases its working directory",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "mesh-claude-owned-tree-"));
    const owner = createClaudeProcessOwner();
    let descendantPid: number | undefined;
    let unrelated: ChildProcess | undefined;
    try {
      unrelated = spawn(
        process.execPath,
        ["-e", "setInterval(() => {}, 60000)"],
        {
          stdio: "ignore",
          windowsHide: true,
        },
      );
      const child = owner.spawn({
        command: process.execPath,
        args: [
          "-e",
          `const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', "process.send('ready'); process.disconnect(); setInterval(() => {}, 60000)"], { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'ignore', 'ipc'], detached: true, windowsHide: true });
child.once('message', () => { child.unref(); process.stdout.write(String(child.pid)); });
process.stdin.resume(); process.stdin.once('end', () => process.exit(0));`,
        ],
        cwd: home,
        env: process.env,
        signal: new AbortController().signal,
      });
      descendantPid = await new Promise<number>((resolve, reject) => {
        child.stdout.once("data", (data) => resolve(Number(data.toString())));
        child.once("error", reject);
      });
      expect(alive(descendantPid)).toBe(true);

      // A disposable probe must stop the tree while the root still identifies it.
      await Promise.all([
        owner.close({ terminateTree: true }),
        owner.close({ terminateTree: true }),
      ]);

      expect(alive(descendantPid)).toBe(false);
      await expect(
        rm(home, { recursive: true, force: true }),
      ).resolves.toBeUndefined();
      expect(alive(unrelated.pid!)).toBe(true);
    } finally {
      await owner.close();
      if (descendantPid && alive(descendantPid)) process.kill(descendantPid);
      if (unrelated && unrelated.exitCode === null) {
        const stopped = new Promise<void>((resolve) =>
          unrelated!.once("close", () => resolve()),
        );
        unrelated.kill();
        await stopped;
      }
      await rm(home, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  },
);
