import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createGitRunner } from "../../src/context/git.js";
import { resolveContext } from "../../src/context/resolve.js";
import type { GitRunner } from "../../src/context/git.js";
import { request } from "../helpers/fixtures.js";
import { createGitFixture, type GitFixture } from "../fixtures/git-repo.js";

async function snapshotTree(root: string): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>();

  async function visit(
    directory: string,
    relativeDirectory = "",
  ): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = relativeDirectory
        ? join(relativeDirectory, entry.name)
        : entry.name;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        snapshot.set(`${relativePath}/`, "directory");
        await visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        const contents = await readFile(absolutePath);
        snapshot.set(
          relativePath,
          createHash("sha256").update(contents).digest("hex"),
        );
      } else {
        snapshot.set(relativePath, "other");
      }
    }
  }

  await visit(root);
  return snapshot;
}

async function snapshotFile(
  path: string,
): Promise<{ hash: string; mtimeMs: number }> {
  const [contents, metadata] = await Promise.all([readFile(path), stat(path)]);
  return {
    hash: createHash("sha256").update(contents).digest("hex"),
    mtimeMs: metadata.mtimeMs,
  };
}

describe("resolveContext", () => {
  const fixtures: GitFixture[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
    await Promise.all(
      directories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("resolves branch, head, base, status, and diff metadata without writing", async () => {
    const repo = await createGitFixture();
    fixtures.push(repo);
    await repo.write("src/value.ts", "export const value = 2;\n");
    await repo.write("src/staged.ts", "export const staged = true;\n");
    await repo.stage("src/staged.ts");
    const before = await snapshotTree(repo.path);

    const context = await resolveContext({
      request: request({
        workspace: repo.path,
        instructions: "Keep this raw.",
        context: { ticket: "RM-4" },
        scope_hints: { base: "HEAD~1", head: "HEAD", paths: ["src"] },
      }),
      git: createGitRunner(),
    });

    expect(await snapshotTree(repo.path)).toEqual(before);
    expect(context.consistency_mode).toBe("live_worktree");
    expect(context.instructions).toBe("Keep this raw.");
    expect(context.caller_context).toEqual({ ticket: "RM-4" });
    expect(context.scope_hints).toEqual({
      base: "HEAD~1",
      head: "HEAD",
      paths: ["src"],
    });
    expect(context.git.is_repository).toBe(true);
    if (!context.git.is_repository)
      throw new Error("expected a Git repository");
    expect(context.git.branch).toBeTruthy();
    expect(context.git.head).toMatch(/^[0-9a-f]{40}$/);
    expect(context.git.base).toMatchObject({
      requested: "HEAD~1",
      resolved: expect.stringMatching(/^[0-9a-f]{40}$/),
    });
    expect(context.git.requested_head).toMatchObject({
      requested: "HEAD",
      resolved: expect.stringMatching(/^[0-9a-f]{40}$/),
    });
    expect(context.git.merge_base).toMatch(/^[0-9a-f]{40}$/);
    expect(context.git.status_entries.length).toBeGreaterThan(0);
    expect(context.git.changed_files).toEqual(
      expect.arrayContaining(["src/value.ts", "src/staged.ts"]),
    );
    expect(context.git.diff_stat).toContain("src/staged.ts");
  });

  it("returns an explicit non-git manifest instead of failing", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "review-mesh-non-git-"));
    directories.push(workspace);

    const context = await resolveContext({
      request: request({ workspace }),
      git: createGitRunner(),
    });

    expect(context.git).toEqual({ is_repository: false });
  });

  it("surfaces an unresolved explicit base without substituting another ref", async () => {
    const repo = await createGitFixture();
    fixtures.push(repo);

    const context = await resolveContext({
      request: request({
        workspace: repo.path,
        scope_hints: { base: "missing-ref", head: "HEAD" },
      }),
      git: createGitRunner(),
    });

    expect(context.git.is_repository).toBe(true);
    if (!context.git.is_repository)
      throw new Error("expected a Git repository");
    expect(context.git.base).toMatchObject({
      requested: "missing-ref",
      resolved: null,
    });
    expect(context.git.base?.error).toBeTruthy();
    expect(context.git.merge_base).toBeNull();
  });

  it("does not refresh a stale Git index during context discovery", async () => {
    const repo = await createGitFixture();
    fixtures.push(repo);
    await repo.write("README.md", "fixture with stale index stat\n");
    const indexPath = join(repo.path, ".git", "index");
    const before = await snapshotFile(indexPath);

    await resolveContext({
      request: request({ workspace: repo.path }),
      git: createGitRunner(),
    });

    expect(await snapshotFile(indexPath)).toEqual(before);
  });

  it("bounds manifest output and reports a detached branch as null", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "review-mesh-bounded-"));
    directories.push(workspace);
    const commands: readonly string[][] = [];
    const git: GitRunner = {
      async run(args) {
        (commands as string[][]).push([...args]);
        if (args.includes("--is-inside-work-tree")) {
          return { stdout: "true\n", stderr: "", exitCode: 0 };
        }
        if (args.includes("--show-toplevel")) {
          return { stdout: `${workspace}\n`, stderr: "", exitCode: 0 };
        }
        if (args.includes("--abbrev-ref")) {
          return { stdout: "HEAD\n", stderr: "", exitCode: 0 };
        }
        if (args[0] === "rev-parse" && args[1] === "HEAD") {
          return { stdout: `${"a".repeat(40)}\n`, stderr: "", exitCode: 0 };
        }
        if (args.includes("--verify")) {
          return {
            stdout: "",
            stderr: `${"x".repeat(8_191)}😀`,
            exitCode: 1,
          };
        }
        if (args[0] === "status") {
          return {
            stdout: Array.from(
              { length: 2_001 },
              (_, index) => `? file-${index}`,
            ).join("\n"),
            stderr: "",
            exitCode: 0,
          };
        }
        if (args[0] === "ls-files") {
          return {
            stdout: `${Array.from({ length: 10_001 }, (_, index) => `file-${index}`).join("\0")}\0`,
            stderr: "",
            exitCode: 0,
          };
        }
        if (args[0] === "diff" && args.includes("--stat")) {
          return {
            stdout: `${"s".repeat(65_535)}😀`,
            stderr: "",
            exitCode: 0,
          };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };

    const context = await resolveContext({
      request: request({
        workspace,
        scope_hints: { base: "missing-ref", paths: ["-looks-like-an-option"] },
      }),
      git,
    });

    expect(context.git.is_repository).toBe(true);
    if (!context.git.is_repository)
      throw new Error("expected a Git repository");
    expect(context.git.branch).toBeNull();
    expect(context.git.status_entries).toHaveLength(2_000);
    expect(context.git.changed_files).toHaveLength(10_000);
    expect(Buffer.byteLength(context.git.diff_stat)).toBeLessThanOrEqual(
      64 * 1_024,
    );
    expect(
      Buffer.byteLength(context.git.base?.error ?? ""),
    ).toBeLessThanOrEqual(8 * 1_024);
    expect(context.git.truncated).toEqual({
      status_entries: true,
      changed_files: true,
      diff_stat: true,
    });
    for (const command of commands.filter((args) => args[0] !== "rev-parse")) {
      expect(command).toContain("--");
    }
  });

  it("reports transport-truncated Git output in manifest truncation flags", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "review-mesh-transport-"));
    directories.push(workspace);
    const git: GitRunner = {
      async run(args) {
        if (args.includes("--is-inside-work-tree")) {
          return { stdout: "true\n", stderr: "", exitCode: 0 };
        }
        if (args.includes("--show-toplevel")) {
          return { stdout: `${workspace}\n`, stderr: "", exitCode: 0 };
        }
        if (args.includes("--abbrev-ref")) {
          return { stdout: "main\n", stderr: "", exitCode: 0 };
        }
        if (args[0] === "rev-parse" && args[1] === "HEAD") {
          return { stdout: `${"a".repeat(40)}\n`, stderr: "", exitCode: 0 };
        }
        if (args[0] === "status") {
          return {
            stdout: "? truncated-status\n",
            stderr: "",
            exitCode: 0,
            outputTruncated: true,
          };
        }
        if (args[0] === "diff" && args.includes("--name-only")) {
          return {
            stdout: "truncated-path\0",
            stderr: "",
            exitCode: 0,
            outputTruncated: true,
          };
        }
        if (args[0] === "diff" && args.includes("--stat")) {
          return {
            stdout: " truncated | 1 +\n",
            stderr: "",
            exitCode: 0,
            outputTruncated: true,
          };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };

    const context = await resolveContext({
      request: request({ workspace }),
      git,
    });

    expect(context.git.is_repository).toBe(true);
    if (!context.git.is_repository)
      throw new Error("expected a Git repository");
    expect(context.git.truncated).toEqual({
      status_entries: true,
      changed_files: true,
      diff_stat: true,
    });
  });
});
