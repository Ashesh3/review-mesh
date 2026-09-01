import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCopilotRuntimePath } from "../../src/copilot/runtime.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Copilot runtime resolution", () => {
  it("prefers an explicit runtime path", () => {
    expect(
      resolveCopilotRuntimePath({ COPILOT_CLI_PATH: "C:\\tools\\copilot.exe" }),
    ).toBe("C:\\tools\\copilot.exe");
  });

  it("finds a native Copilot executable on PATH without a shell", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-mesh-copilot-runtime-"));
    roots.push(root);
    const executable = join(
      root,
      process.platform === "win32" ? "copilot.exe" : "copilot",
    );
    await writeFile(executable, "fixture");

    expect(resolveCopilotRuntimePath({ PATH: root }, [])).toBe(executable);
  });
});
