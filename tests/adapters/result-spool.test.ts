import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_RESULT_SPOOL_BYTES,
  ResultSpoolError,
  createResultSpool,
  wipeStaleResultSpools,
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

  it("retains exact bytes until the caller acknowledges durable persistence", async () => {
    const directory = await root();
    const spool = await createResultSpool({ directory, id: "deferred" });
    await spool.append('{"review_markdown":"complete"}');

    const cleanup = spool.lifecycle().persisted;
    expect(await readFile(spool.path, "utf8")).toBe(
      '{"review_markdown":"complete"}',
    );

    await cleanup();
    expect(await readFile(spool.path)).toHaveLength(0);
  });

  it("closes an abandoned spool without wiping retained diagnostic bytes", async () => {
    const directory = await root();
    const spool = await createResultSpool({ directory, id: "abandoned" });
    await spool.append("retained diagnostics");

    await spool.lifecycle().abandoned();

    expect(await readFile(spool.path, "utf8")).toBe("retained diagnostics");
    await expect(spool.append("more")).rejects.toMatchObject({
      code: "identity_changed",
    });
    await wipeStaleResultSpools({
      directory,
      now: () => Date.now() + 2 * 24 * 60 * 60 * 1_000,
      minimumAgeMs: 24 * 60 * 60 * 1_000,
    });
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

  it("supports a smaller caller-owned maximum for one semantic page", async () => {
    const directory = await root();
    const spool = await createResultSpool({
      directory,
      id: "page-limit",
      maximumBytes: 8,
    });

    await spool.append("12345678");
    await expect(spool.append("9")).rejects.toMatchObject({
      code: "result_too_large",
    });
    expect(await spool.readText()).toBe("12345678");
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
    expect(await readFile(replacementPath, "utf8")).toBe("foreign replacement");
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

  it("does not scavenge when the spool root is inside the reviewed workspace", async () => {
    const workspace = await root();
    const directory = join(workspace, "spools");
    await mkdir(directory);
    const id = "unsafe";
    const owned = join(
      directory,
      `.spool-${id}-00000000-0000-4000-8000-000000000001`,
    );
    const path = join(owned, `${id}.spool`);
    await mkdir(owned);
    await writeFile(path, "must remain");
    await writeFile(join(directory, ".scan-index"), `${basename(owned)}\n`);
    const staleAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000);
    const { utimes } = await import("node:fs/promises");
    await utimes(owned, staleAt, staleAt);

    await expect(
      createResultSpool({ directory, id: "new", reviewedWorkspace: workspace }),
    ).rejects.toMatchObject({ code: "unsafe_directory" });
    expect(await readFile(path, "utf8")).toBe("must remain");
  });

  it("wipes only stale owned spool placeholders and leaves fresh or foreign entries untouched", async () => {
    const directory = await root();
    const stale = await createResultSpool({ directory, id: "stale" });
    const fresh = await createResultSpool({ directory, id: "fresh" });
    await stale.append("stale diagnostic bytes");
    await fresh.append("fresh diagnostic bytes");
    const foreignDirectory = join(directory, "foreign");
    await mkdir(foreignDirectory);
    await writeFile(join(foreignDirectory, "foreign.spool"), "foreign");
    const staleAt = new Date(Date.now() - 2 * 60 * 60 * 1_000);
    const { utimes } = await import("node:fs/promises");
    await utimes(stale.path, staleAt, staleAt);
    await utimes(dirname(stale.path), staleAt, staleAt);

    const result = await wipeStaleResultSpools({
      directory,
      now: () => Date.now(),
      minimumAgeMs: 60 * 60 * 1_000,
    });

    expect(result.wiped).toBe(1);
    expect(await readFile(stale.path)).toHaveLength(0);
    expect(await readFile(fresh.path, "utf8")).toBe("fresh diagnostic bytes");
    expect(
      await readFile(join(foreignDirectory, "foreign.spool"), "utf8"),
    ).toBe("foreign");
    expect(
      (await readdir(directory)).some((name) =>
        name.startsWith(".spool-stale-"),
      ),
    ).toBe(true);
    await stale.lifecycle().abandoned();
    await fresh.cleanup();
  });

  it("advances a bounded persistent scan cursor past hundreds of empty placeholders", async () => {
    const directory = await root();
    const staleAt = new Date(Date.now() - 2 * 60 * 60 * 1_000);
    const { utimes } = await import("node:fs/promises");
    for (let index = 0; index < 300; index += 1) {
      const id = `empty-${String(index).padStart(3, "0")}`;
      const uuid = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      const owned = join(directory, `.spool-${id}-${uuid}`);
      await mkdir(owned);
      await writeFile(join(owned, `${id}.spool`), "");
      await utimes(owned, staleAt, staleAt);
      await writeFile(join(directory, ".scan-index"), `${basename(owned)}\n`, {
        flag: "a",
      });
    }
    const laterDirectory = join(
      directory,
      ".spool-later-00000000-0000-4000-8000-999999999999",
    );
    const laterPath = join(laterDirectory, "later.spool");
    await mkdir(laterDirectory);
    await writeFile(laterPath, "must eventually be wiped");
    await utimes(laterDirectory, staleAt, staleAt);
    await writeFile(
      join(directory, ".scan-index"),
      `${basename(laterDirectory)}\n`,
      { flag: "a" },
    );

    const results = [];
    for (let sweep = 0; sweep < 6; sweep += 1) {
      results.push(
        await wipeStaleResultSpools({
          directory,
          now: () => Date.now(),
          minimumAgeMs: 60 * 60 * 1_000,
          maximumEntries: 64,
        }),
      );
      if ((await readFile(laterPath)).length === 0) break;
    }

    expect(results.every((result) => result.inspected <= 64)).toBe(true);
    expect(results.some((result) => result.wiped === 1)).toBe(true);
    expect(await readFile(laterPath)).toHaveLength(0);
  });

  it("resets a scan cursor that points into the middle of an index record", async () => {
    const directory = await root();
    const id = "boundary";
    const owned = join(
      directory,
      `.spool-${id}-00000000-0000-4000-8000-000000000001`,
    );
    const path = join(owned, `${id}.spool`);
    await mkdir(owned);
    await writeFile(path, "stale bytes");
    const name = basename(owned);
    await writeFile(join(directory, ".scan-index"), `${name}\n`);
    await writeFile(join(directory, ".scan-cursor"), "3\n");
    const staleAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000);
    const { utimes } = await import("node:fs/promises");
    await utimes(owned, staleAt, staleAt);

    await wipeStaleResultSpools({ directory, maximumEntries: 1 });

    expect(await readFile(path)).toHaveLength(0);
  });

  it("fails safely before creating a spool when the scan index exceeds its cap", async () => {
    const directory = await root();
    await writeFile(
      join(directory, ".scan-index"),
      Buffer.alloc(16 * 1024 * 1024),
    );

    await expect(
      createResultSpool({ directory, id: "capped" }),
    ).rejects.toMatchObject({ code: "unsafe_directory" });
    expect(
      (await readdir(directory)).filter((name) => name.startsWith(".spool-")),
    ).toEqual([]);
  });

  it("skips an owned directory with many attacker-created children using bounded enumeration", async () => {
    const directory = await root();
    const id = "crowded";
    const owned = join(
      directory,
      `.spool-${id}-00000000-0000-4000-8000-000000000001`,
    );
    const path = join(owned, `${id}.spool`);
    await mkdir(owned);
    await writeFile(path, "must remain");
    for (let index = 0; index < 100; index += 1) {
      await writeFile(join(owned, `foreign-${index}`), "x");
    }
    await writeFile(join(directory, ".scan-index"), `${basename(owned)}\n`);
    const staleAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000);
    const { utimes } = await import("node:fs/promises");
    await utimes(owned, staleAt, staleAt);

    const result = await wipeStaleResultSpools({
      directory,
      maximumEntries: 1,
    });

    expect(result).toEqual({ inspected: 1, wiped: 0 });
    expect(await readFile(path, "utf8")).toBe("must remain");
  });
});
