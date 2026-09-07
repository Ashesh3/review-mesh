import { spawn, type ChildProcess } from "node:child_process";
import { isAbsolute, join } from "node:path";
import type { Options } from "@anthropic-ai/claude-agent-sdk";

/** Retains OS exit promises because SDK close/dispose can return before exit. */
export function createClaudeProcessOwner(): {
  spawn: NonNullable<Options["spawnClaudeCodeProcess"]>;
  close(options?: { terminateTree?: boolean }): Promise<void>;
} {
  const children = new Map<ChildProcess, Promise<void>>();
  let closing: Promise<void> | undefined;
  let terminating: Promise<void> | undefined;
  const exited = (child: ChildProcess) =>
    child.exitCode !== null || child.signalCode !== null;
  const waitForRelease = async (stopped: Promise<void>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      stopped.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 3000);
      }),
    ]).finally(() => clearTimeout(timer));
  };
  async function terminateTree(child: ChildProcess, stopped: Promise<void>) {
    // Once the root has exited its PID can be reused. Never pass it to taskkill.
    if (exited(child) || child.pid === undefined) {
      await stopped;
      return;
    }
    const systemRoot =
      process.env.SystemRoot ?? process.env.SYSTEMROOT ?? process.env.WINDIR;
    if (!systemRoot || !isAbsolute(systemRoot))
      throw new Error("Windows process tree cleanup is unavailable.");
    const killer = spawn(
      join(systemRoot, "System32", "taskkill.exe"),
      ["/PID", String(child.pid), "/T", "/F"],
      { windowsHide: true, stdio: "ignore", timeout: 5000 },
    );
    await new Promise<void>((resolve) => {
      killer.on("error", () => {
        /* Report only after checking the owned child's actual exit below. */
      });
      killer.once("close", () => resolve());
    });
    // taskkill can report failure for a grandchild which exited concurrently;
    // Bun also delivers the root's close after taskkill itself has exited.
    if (!(await waitForRelease(stopped))) {
      child.kill();
      await waitForRelease(stopped);
      throw new Error("Claude runtime process tree cleanup failed.");
    }
    await stopped;
  }
  return {
    spawn(options) {
      if (closing || terminating)
        throw new Error("Claude runtime is already closing.");
      const child = spawn(options.command, options.args, {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        env: options.env,
        signal: options.signal,
        windowsHide: true,
        stdio: "pipe",
      });
      const stopped = new Promise<void>((resolve) => {
        child.once("close", () => resolve());
        child.on("error", () => {
          /* SDK owns error reporting; close follows. */
        });
      });
      children.set(child, stopped);
      return child;
    },
    close(options) {
      if (options?.terminateTree && process.platform === "win32")
        return (terminating ??= Promise.all(
          [...children].map(([child, stopped]) =>
            terminateTree(child, stopped),
          ),
        ).then(() => undefined));
      if (terminating) return terminating;
      return (closing ??= Promise.all(
        [...children].map(async ([child, stopped]) => {
          if (exited(child)) {
            await stopped;
            return;
          }
          child.stdin?.end();
          const timer = setTimeout(() => child.kill(), 3000);
          try {
            await stopped;
          } finally {
            clearTimeout(timer);
          }
        }),
      ).then(() => undefined));
    },
  };
}
