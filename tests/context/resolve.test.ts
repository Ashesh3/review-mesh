import { createHash } from "node:crypto";
import { access, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { execa } from "execa";
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

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function nodeCommand(path: string): string {
  return `node "${path.replaceAll("\\", "/")}"`;
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
        review_scope: {
          mode: "changes",
          base: "HEAD~1",
          head: "HEAD",
          paths: ["src"],
        },
      }),
      git: createGitRunner(),
    });

    expect(await snapshotTree(repo.path)).toEqual(before);
    expect(context.consistency_mode).toBe("live_worktree");
    expect(context.instructions).toBe("Keep this raw.");
    expect(context.caller_context).toEqual({ ticket: "RM-4" });
    expect(context.review_scope).toEqual({
      mode: "changes",
      source: "request",
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

  it("allows an explicit full review outside Git", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "review-mesh-non-git-"));
    directories.push(workspace);

    const context = await resolveContext({
      request: request({
        project_name: "plain",
        workspace,
        review_scope: { mode: "full" },
      }),
      git: createGitRunner(),
    });

    expect(context.git).toEqual({ is_repository: false });
    expect(context.review_scope).toEqual({ mode: "full", source: "request" });
  });

  it("defaults v2 requests to changes above main and includes local work", async () => {
    const repo = await createGitFixture();
    fixtures.push(repo);
    await execa("git", ["branch", "-M", "main"], { cwd: repo.path });
    await execa("git", ["checkout", "-b", "feature/change-scope"], {
      cwd: repo.path,
    });
    await repo.write("src/feature.ts", "export const feature = true;\n");
    await repo.stage("src/feature.ts");
    await execa("git", ["commit", "-m", "Feature commit"], { cwd: repo.path });
    await repo.write("src/local.ts", "export const local = true;\n");

    const context = await resolveContext({
      request: {
        schema_version: "2",
        project_name: "project",
        workspace: repo.path,
        instructions: "Review the current changes.",
        review_scope: { mode: "changes" },
      },
      git: createGitRunner(),
    });

    expect(context.review_scope).toEqual({
      mode: "changes",
      source: "request",
    });
    expect(context.git.is_repository).toBe(true);
    if (!context.git.is_repository) throw new Error("expected Git repository");
    expect(context.git.base?.requested).toBe("main");
    expect(context.git.merge_base).toMatch(/^[0-9a-f]{40}$/u);
    expect(context.git.changed_files).toEqual(
      expect.arrayContaining(["src/feature.ts", "src/local.ts"]),
    );
    expect(context.git.diff).toContain("src/feature.ts");
  });

  it("rejects mismatched branch assertions and non-Git change scopes", async () => {
    const repo = await createGitFixture();
    fixtures.push(repo);
    await expect(
      resolveContext({
        request: {
          schema_version: "2",
          project_name: "project",
          workspace: repo.path,
          instructions: "Review changes.",
          review_scope: { mode: "changes", branch: "not-current" },
        },
        git: createGitRunner(),
      }),
    ).rejects.toThrow(/does not match checked-out branch/i);

    const workspace = await mkdtemp(join(tmpdir(), "review-mesh-non-git-v2-"));
    directories.push(workspace);
    await expect(
      resolveContext({
        request: {
          schema_version: "2",
          project_name: "plain",
          workspace,
          instructions: "Review changes.",
          review_scope: { mode: "changes" },
        },
        git: createGitRunner(),
      }),
    ).rejects.toThrow(/requires a Git repository/i);
  });

  it("rejects an unresolved explicit base without substituting another ref", async () => {
    const repo = await createGitFixture();
    fixtures.push(repo);

    await expect(
      resolveContext({
        request: request({
          workspace: repo.path,
          review_scope: {
            mode: "changes",
            base: "missing-ref",
            head: "HEAD",
          },
        }),
        git: createGitRunner(),
      }),
    ).rejects.toThrow(/could not resolve requested review base missing-ref/i);
  });

  it("fails closed when Git cannot produce a complete change scope", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "review-mesh-scope-fail-"));
    directories.push(workspace);
    const commit = "a".repeat(40);
    const base = "b".repeat(40);
    const git: GitRunner = {
      async run(args) {
        if (args.includes("--is-inside-work-tree")) {
          return { stdout: "true\n", stderr: "", exitCode: 0 };
        }
        if (args.includes("--show-toplevel")) {
          return { stdout: `${workspace}\n`, stderr: "", exitCode: 0 };
        }
        if (args.includes("--abbrev-ref")) {
          return { stdout: "feature\n", stderr: "", exitCode: 0 };
        }
        if (args[0] === "rev-parse" && args[1] === "HEAD") {
          return { stdout: `${commit}\n`, stderr: "", exitCode: 0 };
        }
        if (args.includes("--verify")) {
          return {
            stdout: `${args.at(-1) === "HEAD^{commit}" ? commit : base}\n`,
            stderr: "",
            exitCode: 0,
          };
        }
        if (args[0] === "merge-base") {
          return { stdout: `${"b".repeat(40)}\n`, stderr: "", exitCode: 0 };
        }
        if (args[0] === "merge-base") {
          return { stdout: `${base}\n`, stderr: "", exitCode: 0 };
        }
        if (args[0] === "diff" && args.includes("--name-only")) {
          return { stdout: "", stderr: "failed", exitCode: 1 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };

    await expect(
      resolveContext({
        request: request({
          workspace,
          review_scope: { mode: "changes", base: "main" },
        }),
        git,
      }),
    ).rejects.toThrow(/complete Git change scope/i);
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

  it("does not execute repository-configured fsmonitor or textconv helpers", async () => {
    const repo = await createGitFixture();
    fixtures.push(repo);
    const fsmonitorSentinel = join(repo.path, "fsmonitor-called");
    const textconvSentinel = join(repo.path, "textconv-called");
    const fsmonitorScript = join(repo.path, "fsmonitor.mjs");
    const textconvScript = join(repo.path, "textconv.mjs");
    await writeFile(
      fsmonitorScript,
      `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(fsmonitorSentinel)}, "called\\n");\nprocess.stdout.write("token\\n");\n`,
      "utf8",
    );
    await writeFile(
      textconvScript,
      `import { appendFileSync, readFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(textconvSentinel)}, "called\\n");\nprocess.stdout.write(readFileSync(process.argv.at(-1)));\n`,
      "utf8",
    );
    await repo.write(".gitattributes", "README.md diff=sentinel\n");
    await repo.write("README.md", "textconv candidate\n");
    for (const [key, value] of [
      ["core.fsmonitor", nodeCommand(fsmonitorScript)],
      ["diff.sentinel.textconv", nodeCommand(textconvScript)],
    ] as const) {
      const configured = await execa("git", ["config", key, value], {
        cwd: repo.path,
        reject: false,
      });
      expect(configured.exitCode).toBe(0);
    }

    const untrustedStatus = await execa(
      "git",
      ["status", "--porcelain=v2", "--untracked-files=all"],
      { cwd: repo.path, reject: false },
    );
    expect(untrustedStatus.exitCode).toBe(0);
    expect(await exists(fsmonitorSentinel)).toBe(true);
    const untrustedDiff = await execa(
      "git",
      ["diff", "--textconv", "--", "README.md"],
      { cwd: repo.path, reject: false },
    );
    expect(untrustedDiff.exitCode).toBe(0);
    expect(await exists(textconvSentinel)).toBe(true);
    await Promise.all([
      rm(fsmonitorSentinel, { force: true }),
      rm(textconvSentinel, { force: true }),
    ]);

    await resolveContext({
      request: request({ workspace: repo.path }),
      git: createGitRunner(),
    });

    expect(await exists(fsmonitorSentinel)).toBe(false);
    expect(await exists(textconvSentinel)).toBe(false);
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
          const requested = args.at(-1);
          if (requested === "HEAD^{commit}") {
            return {
              stdout: `${"a".repeat(40)}\n`,
              stderr: "",
              exitCode: 0,
            };
          }
          if (requested === "main^{commit}") {
            return {
              stdout: `${"b".repeat(40)}\n`,
              stderr: "",
              exitCode: 0,
            };
          }
          return {
            stdout: "",
            stderr: `${"x".repeat(8_191)}😀`,
            exitCode: 1,
          };
        }
        if (args[0] === "merge-base") {
          return { stdout: `${"a".repeat(40)}\n`, stderr: "", exitCode: 0 };
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
        review_scope: {
          mode: "changes",
          base: "main",
          paths: ["-looks-like-an-option"],
        },
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
      diff: false,
    });
    for (const command of commands.filter(
      (args) => args[0] !== "rev-parse" && args[0] !== "merge-base",
    )) {
      expect(command).toContain("--");
    }
    for (const command of commands.filter((args) => args[0] === "diff")) {
      expect(command).toContain("--no-ext-diff");
      expect(command).toContain("--no-textconv");
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
        if (args.includes("--verify")) {
          return {
            stdout: `${"a".repeat(40)}\n`,
            stderr: "",
            exitCode: 0,
          };
        }
        if (args[0] === "merge-base") {
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
      diff: false,
    });
  });
});
