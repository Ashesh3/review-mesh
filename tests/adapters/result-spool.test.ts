import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_RESULT_SPOOL_BYTES,
  ResultSpoolError,
  createResultSpool,
} from "../../src/adapters/result-spool.js";

const roots: string[] = [];

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "review-mesh-result-spool-test-"));
  roots.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("result spool", () => {
  it("appends and reads exact bytes, then durably wipes its owned file idempotently", async () => {
    const directory = await root();
    const spool = await createResultSpool({ directory, id: "exact" });

    await spool.append('{"review_markdown":"A €');
    await spool.append(new TextEncoder().encode(" and 🚀"));
    await spool.append('"}');

    expect(spool.byteLength).toBe(
      Buffer.byteLength('{"review_markdown":"A € and 🚀"}', "utf8"),
    );
    await expect(spool.readText()).resolves.toBe(
      '{"review_markdown":"A € and 🚀"}',
    );
    expect(await readFile(spool.path, "utf8")).toBe(
      '{"review_markdown":"A € and 🚀"}',
    );

    await spool.cleanup();
    expect(spool.byteLength).toBe(0);
    expect(await readFile(spool.path)).toHaveLength(0);
    await expect(spool.cleanup()).resolves.toBeUndefined();
    expect(await readFile(spool.path)).toHaveLength(0);
  });

  it("enforces the fixed 16 MiB total limit without discarding accepted fragments", async () => {
    expect(MAX_RESULT_SPOOL_BYTES).toBe(16 * 1024 * 1024);
    const directory = await root();
    const spool = await createResultSpool({ directory, id: "bounded" });
    const accepted = Buffer.alloc(MAX_RESULT_SPOOL_BYTES, 0x61);

    await spool.append(accepted);
    await expect(spool.append("b")).rejects.toMatchObject({
      code: "result_too_large",
    });
    expect(spool.byteLength).toBe(MAX_RESULT_SPOOL_BYTES);
    expect((await spool.read()).equals(accepted)).toBe(true);
    await spool.cleanup();
  });

  it("rejects a replaced spool path and never deletes the foreign replacement", async () => {
    const directory = await root();
    const spool = await createResultSpool({ directory, id: "identity" });
    await spool.append("owned");
    const moved = join(directory, "moved-owned.spool");
    await rename(spool.path, moved);
    await writeFile(spool.path, "foreign");

    await expect(spool.append("more")).rejects.toMatchObject({
      code: "identity_changed",
    });
    await expect(spool.cleanup()).resolves.toBeUndefined();
    await expect(spool.cleanup()).resolves.toBeUndefined();
    expect(await readFile(spool.path, "utf8")).toBe("foreign");
    expect(await readFile(moved)).toHaveLength(0);
  });

  it("preserves a foreign replacement when identity changes during creation", async () => {
    const directory = await root();
    let original = "";
    let path = "";

    await expect(
      createResultSpool({
        directory,
        id: "creation-race",
        async afterCreateOpen(openedPath: string) {
          path = openedPath;
          original = `${openedPath}.original`;
          await rename(openedPath, original);
          await writeFile(openedPath, "foreign replacement");
        },
      }),
    ).rejects.toMatchObject({ code: "identity_changed" });
    expect(await readFile(path, "utf8")).toBe("foreign replacement");
    expect(await readFile(original)).toHaveLength(0);
  });

  it("does not unlink a replacement introduced at the cleanup remove boundary", async () => {
    const directory = await root();
    let replacementPath = "";
    const spool = await createResultSpool({
      directory,
      id: "cleanup-race",
      async beforeCleanupWipe(path: string) {
        replacementPath = path;
        await rename(path, `${path}.owned`);
        await writeFile(path, "foreign replacement");
      },
    } as Parameters<typeof createResultSpool>[0]);
    await spool.append("owned content");

    await expect(spool.cleanup()).resolves.toBeUndefined();
    await expect(spool.cleanup()).resolves.toBeUndefined();
    expect(replacementPath).not.toBe("");
    expect(await readFile(replacementPath, "utf8")).toBe(
      "foreign replacement",
    );
    expect(await readFile(`${replacementPath}.owned`)).toHaveLength(0);
  });

  it("refuses a symlinked spool directory", async () => {
    const directory = await root();
    const target = join(directory, "target");
    const link = join(directory, "link");
    await mkdir(target);
    await symlink(
      target,
      link,
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(
      createResultSpool({ directory: link, id: "linked" }),
    ).rejects.toMatchObject({
      code: "unsafe_directory",
    });
  });
});
