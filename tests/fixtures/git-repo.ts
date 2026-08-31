import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";

export interface GitFixture {
  path: string;
  write(relativePath: string, contents: string): Promise<void>;
  stage(relativePath: string): Promise<void>;
  dispose(): Promise<void>;
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  const result = await execa("git", args, { cwd, reject: false });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
}

export async function createGitFixture(): Promise<GitFixture> {
  const path = await mkdtemp(join(tmpdir(), "review-mesh-git-"));
  await git(path, ["init"]);
  await git(path, ["config", "user.name", "Review Mesh Test"]);
  await git(path, ["config", "user.email", "review-mesh@example.test"]);

  await mkdir(join(path, "src"), { recursive: true });
  await writeFile(join(path, "README.md"), "fixture\n", "utf8");
  await git(path, ["add", "README.md"]);
  await git(path, ["commit", "-m", "Initial fixture"]);
  await git(path, ["commit", "--allow-empty", "-m", "Second fixture commit"]);

  return {
    path,
    async write(relativePath, contents) {
      const absolutePath = join(path, relativePath);
      await mkdir(join(absolutePath, ".."), { recursive: true });
      await writeFile(absolutePath, contents, "utf8");
    },
    async stage(relativePath) {
      await git(path, ["add", "--", relativePath]);
    },
    async dispose() {
      await rm(path, { recursive: true, force: true });
    },
  };
}
