import {
  lstat,
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
  it("appends and reads exact bytes, then removes its owned file", async () => {
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
    await expect(lstat(spool.path)).rejects.toMatchObject({ code: "ENOENT" });
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
    await expect(spool.cleanup()).rejects.toMatchObject({
      code: "identity_changed",
    });
    expect(await readFile(spool.path, "utf8")).toBe("foreign");
  });

  it("preserves a foreign replacement when identity changes during creation", async () => {
    const directory = await root();
    const original = join(directory, "creation-original.spool");
    const path = join(directory, "creation-race.spool");

    await expect(
      createResultSpool({
        directory,
        id: "creation-race",
        async afterCreateOpen(openedPath: string) {
          await rename(openedPath, original);
          await writeFile(openedPath, "foreign replacement");
        },
      }),
    ).rejects.toMatchObject({ code: "identity_changed" });
    expect(await readFile(path, "utf8")).toBe("foreign replacement");
    expect(await readFile(original, "utf8")).toBe("");
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
