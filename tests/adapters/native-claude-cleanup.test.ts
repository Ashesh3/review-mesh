import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createNativeClaudeAdapter } from "../../src/adapters/native-claude.js";
import { resolvedReviewer } from "../helpers/fixtures.js";

const dependencies = vi.hoisted(() => ({ startup: vi.fn(), rm: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", async (original) => ({
  ...(await original<typeof import("@anthropic-ai/claude-agent-sdk")>()),
  startup: dependencies.startup,
}));
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  mkdtemp: vi.fn(async () => "fixture-private-home"),
  rm: dependencies.rm,
}));
afterEach(() => vi.useRealTimers());
beforeEach(() => {
  dependencies.startup.mockReset();
  dependencies.rm.mockReset();
});

function adapter() {
  return createNativeClaudeAdapter(
    { type: "claude", api_key_env: "KEY" },
    {
      environment: { KEY: "fixture-secret" },
      runtime: () => ({
        executablePath: "fixture",
        pathEntries: [],
        sdkVersion: "fixture",
        runtimeVersion: "fixture",
        mode: "managed_process",
      }),
    },
  );
}

it("retries transient directory release independently of Bun's ignored rm options", async () => {
  vi.useFakeTimers();
  dependencies.startup.mockResolvedValueOnce({
    close() {},
    async [Symbol.asyncDispose]() {},
  });
  dependencies.rm
    .mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "EBUSY" }))
    .mockResolvedValueOnce(undefined);
  const result = adapter().probe(
    resolvedReviewer({ adapter: { type: "claude" } }),
    new AbortController().signal,
  );
  const outcome = result.then(
    (value) => value,
    () => ({ available: false }),
  );
  await vi.advanceTimersByTimeAsync(100);
  expect(await outcome).toMatchObject({ available: true });
  expect(dependencies.rm).toHaveBeenCalledTimes(2);
});

it("keeps the initialization error when directory cleanup also fails", async () => {
  vi.useFakeTimers();
  dependencies.startup.mockRejectedValueOnce(
    new Error("provider fixture-secret"),
  );
  dependencies.rm.mockRejectedValue(
    Object.assign(new Error("locked fixture-secret"), { code: "EBUSY" }),
  );
  const result = adapter().probe(
    resolvedReviewer({ adapter: { type: "claude" } }),
    new AbortController().signal,
  );
  const outcome = result.then(
    (value) => value,
    () => ({ rejected: true }),
  );
  await vi.advanceTimersByTimeAsync(1500);
  expect(await outcome).toMatchObject({
    available: false,
    message:
      "Claude SDK runtime initialization failed. Claude probe directory cleanup failed (EBUSY).",
  });
  expect(dependencies.rm).toHaveBeenCalledTimes(6);
  expect(JSON.stringify(await outcome)).not.toContain("fixture-secret");
});

it("does not retry unrelated directory errors or claim a successful probe", async () => {
  dependencies.startup.mockResolvedValueOnce({
    close() {},
    async [Symbol.asyncDispose]() {},
  });
  dependencies.rm.mockRejectedValue(
    Object.assign(new Error("io fixture-secret"), { code: "EIO" }),
  );
  const result = await adapter().probe(
    resolvedReviewer({ adapter: { type: "claude" } }),
    new AbortController().signal,
  );
  expect(result).toMatchObject({
    available: false,
    message: "Claude probe directory cleanup failed (EIO).",
  });
  expect(dependencies.rm).toHaveBeenCalledTimes(1);
});

it("still releases the private home when the SDK warm handle dispose fails", async () => {
  dependencies.startup.mockResolvedValueOnce({
    close() {},
    async [Symbol.asyncDispose]() {
      throw new Error("dispose fixture-secret");
    },
  });
  dependencies.rm.mockResolvedValueOnce(undefined);
  const result = await adapter().probe(
    resolvedReviewer({ adapter: { type: "claude" } }),
    new AbortController().signal,
  );
  expect(result).toMatchObject({
    available: false,
    message: "Claude probe SDK cleanup failed (cleanup_error).",
  });
  expect(dependencies.rm).toHaveBeenCalledTimes(1);
});

it("retains cancellation that arrives while the warm probe is being disposed", async () => {
  const controller = new AbortController();
  dependencies.startup.mockResolvedValueOnce({
    close() {
      controller.abort();
    },
    async [Symbol.asyncDispose]() {},
  });
  dependencies.rm.mockResolvedValueOnce(undefined);
  const result = await adapter().probe(
    resolvedReviewer({ adapter: { type: "claude" } }),
    controller.signal,
  );
  expect(result).toMatchObject({
    available: false,
    message: "Claude probe cancelled.",
  });
});
