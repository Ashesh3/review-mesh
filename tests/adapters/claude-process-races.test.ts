import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createClaudeProcessOwner } from "../../src/runtime/claude-process.js";

const runtime = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: runtime.spawn }));

afterEach(() => vi.useRealTimers());
beforeEach(() => runtime.spawn.mockReset());

it.runIf(process.platform === "win32")(
  "waits for delayed child close when taskkill reports a disappearing descendant",
  async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      pid: 1234,
      exitCode: null as number | null,
      signalCode: null,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      kill: vi.fn(() => {
        child.exitCode = 1;
        child.emit("close");
        return true;
      }),
    });
    const killer = new EventEmitter();
    runtime.spawn.mockReturnValueOnce(child).mockReturnValueOnce(killer);
    const owner = createClaudeProcessOwner();
    owner.spawn({
      command: "fixture.exe",
      args: [],
      env: {},
      signal: new AbortController().signal,
    });
    const closed = owner.close({ terminateTree: true });
    const outcome = closed.then(
      () => "closed",
      () => "failed",
    );
    // taskkill's 255 can mean a descendant exited before it was terminated.
    killer.emit("close", 255);
    setTimeout(() => {
      child.exitCode = 1;
      child.emit("close");
    }, 75);
    await vi.advanceTimersByTimeAsync(100);
    expect(await outcome).toBe("closed");
    expect(child.kill).not.toHaveBeenCalled();
    expect(runtime.spawn.mock.calls.at(-1)).toMatchObject([
      expect.stringMatching(/System32[\\/]taskkill\.exe$/),
      ["/PID", "1234", "/T", "/F"],
      { windowsHide: true, stdio: "ignore" },
    ]);
  },
);

it.runIf(process.platform === "win32")(
  "bounds a failed tree shutdown without treating a surviving root as closed",
  async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      pid: 1234,
      exitCode: null as number | null,
      signalCode: null,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      kill: vi.fn(() => false),
    });
    const killer = new EventEmitter();
    runtime.spawn.mockReturnValueOnce(child).mockReturnValueOnce(killer);
    const owner = createClaudeProcessOwner();
    owner.spawn({
      command: "fixture.exe",
      args: [],
      env: {},
      signal: new AbortController().signal,
    });
    let outcome = "pending";
    const closed = owner.close({ terminateTree: true }).then(
      () => {
        outcome = "closed";
      },
      () => {
        outcome = "failed";
      },
    );
    killer.emit(
      "error",
      Object.assign(new Error("unavailable"), { code: "ENOENT" }),
    );
    killer.emit("close", -1);
    await vi.advanceTimersByTimeAsync(6000);
    expect(outcome).toBe("failed");
    child.exitCode = 1;
    child.emit("close");
    await closed;
  },
);

it.runIf(process.platform === "win32")(
  "does not pass a root PID to taskkill after a signal exit",
  async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 1234,
      exitCode: null,
      signalCode: null as NodeJS.Signals | null,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
    });
    runtime.spawn.mockReturnValueOnce(child);
    const owner = createClaudeProcessOwner();
    owner.spawn({
      command: "fixture.exe",
      args: [],
      env: {},
      signal: new AbortController().signal,
    });
    child.signalCode = "SIGTERM";
    child.emit("close");
    await owner.close({ terminateTree: true });
    expect(runtime.spawn).toHaveBeenCalledTimes(1);
  },
);
