import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  createRunControl,
  requestRunStop,
} from "../../src/diagnostics/run-control.js";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
it("cancels only the matching live run and removes control state on close", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-mesh-control-"));
  roots.push(root);
  const controller = new AbortController();
  const control = await createRunControl(root, "run-one", controller);
  try {
    const stopped = new Promise<void>((resolve) =>
      controller.signal.addEventListener("abort", () => resolve(), {
        once: true,
      }),
    );
    expect(await requestRunStop(root, "run-one", "cancel")).toMatchObject({
      status: "requested",
      run_id: "run-one",
    });
    await stopped;
    expect(controller.signal.reason.message).toContain("cancel");
  } finally {
    await control.close();
  }
  await expect(requestRunStop(root, "run-one", "cancel")).rejects.toThrow(
    /not active/i,
  );
});
it("rejects unsafe IDs and forged control requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-mesh-control-"));
  roots.push(root);
  const controller = new AbortController();
  await expect(requestRunStop(root, "../elsewhere", "cancel")).rejects.toThrow(
    /invalid/i,
  );
  const control = await createRunControl(root, "run-one", controller);
  try {
    await writeFile(
      join(root, "run-one.stop.json"),
      JSON.stringify({ nonce: "wrong", action: "cancel" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(controller.signal.aborted).toBe(false);
  } finally {
    await control.close();
  }
});
