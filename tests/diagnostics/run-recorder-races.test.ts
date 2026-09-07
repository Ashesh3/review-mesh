import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  open as realOpen,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";

const fault = vi.hoisted(() => ({
  path: "",
  on: "none" as "none" | "open" | "restat",
}));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      if (String(args[0]) !== fault.path || fault.on === "none")
        return fs.open(...args);
      const mode = fault.on;
      fault.on = "none";
      if (mode === "open") {
        await fs.rm(fault.path);
        return fs.open(...args);
      }
      const handle = await fs.open(...args);
      const read = handle.read.bind(handle);
      handle.read = (async (...readArgs: unknown[]) => {
        const result = await (read as (...args: unknown[]) => Promise<unknown>)(
          ...readArgs,
        );
        await fs.rm(fault.path);
        return result;
      }) as typeof handle.read;
      return handle;
    },
  };
});

import { createRunRecorder } from "../../src/diagnostics/run-recorder.js";

const roots: string[] = [];
afterEach(async () => {
  fault.path = "";
  fault.on = "none";
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

it.each(["open", "restat"] as const)(
  "ignores a concurrently removed active publication during %s scavenging",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "mesh-recorder-race-"));
    roots.push(root);
    const runsDirectory = join(root, "runs");
    await mkdir(runsDirectory);
    const path = join(runsDirectory, "run-other.jsonl.active.99999.1.owner");
    await writeFile(
      path,
      '{"record":"resolution","run_id":"run-other","resolution":{}}\n',
    );
    fault.path = path;
    fault.on = mode;
    const recorder = createRunRecorder({
      runsDirectory,
      applicationDataRoot: root,
      runId: "current",
      maxRuns: 2,
      resolution: {},
    });
    await recorder.ready();
    await expect(recorder.close()).resolves.toBeUndefined();
    const handle = await realOpen(join(runsDirectory, "current.jsonl"));
    await handle.close();
  },
);
