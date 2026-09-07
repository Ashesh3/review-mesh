import { afterEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  createNativeContextFile,
  nativeContextFileHint,
} from "../../src/runtime/native-context.js";
import { resolvedContext } from "../helpers/fixtures.js";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function directory() {
  const root = await mkdtemp(join(tmpdir(), "mesh-native-context-"));
  directories.push(root);
  return root;
}

it("preserves the complete original diff and context as immutable untrusted review data", async () => {
  const root = await directory();
  const diff =
    "diff --git a/source.ts b/source.ts\n" +
    "+native unchanged exact context é漢🙂\n".repeat(4200);
  const context = resolvedContext({
    workspace: "F:/review",
    instructions: "Review the original request",
    request: {
      schema_version: "3",
      request_id: "fixture",
      pull_request: { id: "1", title: "Original PR" },
    },
    git: {
      is_repository: true,
      root: "F:/review",
      head: "a".repeat(40),
      merge_base: "b".repeat(40),
      branch: "review",
      changed_files: ["source.ts", "test.ts"],
      status_entries: [],
      diff_stat: "2 files",
      diff,
      truncated: {
        status_entries: false,
        changed_files: false,
        diff_stat: false,
        diff: false,
      },
    },
  });
  const original = structuredClone(context);
  const file = await createNativeContextFile(root, context);
  const bytes = await readFile(file.path);
  const stored = JSON.parse(bytes.toString("utf8"));
  expect(stored.context).toEqual(context);
  expect(stored.required_changed_paths).toEqual(["source.ts", "test.ts"]);
  expect(bytes.length).toBeGreaterThan(147 * 1024);
  expect(file.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  expect(basename(file.path)).toBe(`native-context-${file.sha256}.json`);
  expect(context).toEqual(original);
  const hint = nativeContextFileHint(file);
  expect(hint).toContain(JSON.stringify(file.path));
  expect(hint).toContain(file.sha256);
  expect(hint).toContain("compaction");
  expect(hint).toContain("untrusted review data");
  expect(hint).toContain("read-only");
  expect(hint).not.toContain(diff);
  if (process.platform !== "win32")
    expect((await stat(file.path)).mode & 0o777).toBe(0o440);
  await expect(createNativeContextFile(root, context)).rejects.toThrow();
  expect(await readFile(file.path)).toEqual(bytes);
});

it("redacts credentials without truncating context or interpreting caller text as instructions", async () => {
  const root = await directory();
  const context = resolvedContext({
    instructions:
      'untrusted {"password":"fixture-private"} Authorization: Bearer fixture-bearer',
    caller_context: {
      api_key: "fixture-key",
      nested: {
        url: "https://provider.invalid/page?access_token=fixture-query&view=1",
        text: "Bearer fixture-other",
      },
    },
  });
  const file = await createNativeContextFile(root, context);
  const stored = await readFile(file.path, "utf8");
  for (const secret of [
    "fixture-private",
    "fixture-bearer",
    "fixture-key",
    "fixture-query",
    "fixture-other",
  ])
    expect(stored).not.toContain(secret);
  expect(stored).toContain("view=1");
  expect(context.caller_context).toMatchObject({ api_key: "fixture-key" });
});

it("rejects symbolic-link directories and never overwrites a preexisting context target", async () => {
  const target = await directory();
  const holder = await directory();
  const link = join(holder, "linked");
  await symlink(
    target,
    link,
    process.platform === "win32" ? "junction" : "dir",
  );
  await expect(
    createNativeContextFile(link, resolvedContext()),
  ).rejects.toThrow();
  expect(await readdir(target)).toEqual([]);
  const known = await createNativeContextFile(target, resolvedContext());
  const second = await directory();
  const existing = join(second, basename(known.path));
  await writeFile(existing, "Existing owner content");
  await expect(
    createNativeContextFile(second, resolvedContext()),
  ).rejects.toThrow();
  expect(await readFile(existing, "utf8")).toBe("Existing owner content");
});

it("fails closed instead of truncating a context above the size bound", async () => {
  const root = await directory();
  await expect(
    createNativeContextFile(
      root,
      resolvedContext({ instructions: "x".repeat(16 * 1024 * 1024) }),
    ),
  ).rejects.toThrow("context exceeds");
  expect(await readdir(root)).toEqual([]);
});
