import { spawn, type ChildProcess } from "node:child_process";
import type { Options } from "@anthropic-ai/claude-agent-sdk";

/** Retains OS exit promises because SDK close/dispose can return before exit. */
export function createClaudeProcessOwner(): {
  spawn: NonNullable<Options["spawnClaudeCodeProcess"]>;
  close(): Promise<void>;
} {
  const children = new Map<ChildProcess, Promise<void>>();
  let closing: Promise<void> | undefined;
  return {
    spawn(options) {
      if (closing) throw new Error("Claude runtime is already closing.");
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
    close() {
      return (closing ??= Promise.all(
        [...children].map(async ([child, stopped]) => {
          if (child.exitCode !== null) {
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
