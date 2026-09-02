import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import { resolveProjectName } from "../../src/config/project-names.js";
import { resolveConfig } from "../../src/config/resolve.js";
import type { TrustedConfigV4 } from "../../src/config/schemas.js";

const roots: string[] = [];

async function git(cwd: string, args: readonly string[]): Promise<void> {
  const result = await execa("git", args, { cwd, reject: false });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
}

function config(projectName: string): TrustedConfigV4 {
  return {
    schema_version: "4",
    execution: {
      max_concurrency: 1,
      heartbeat_interval_ms: 1_000,
      shutdown_grace_period_ms: 1_000,
    },
    diagnostics: { persist_runs: false, max_runs: 1 },
    adapters: {
      command: {
        type: "command",
        command: "reviewer",
        protocol: "review-mesh-command-v1",
      },
    },
    agents: {
      project: {
        adapter: "command",
        model: "project-model",
        purpose: "Project review",
        instructions: "Review the project.",
        isolation: "prefer_enforced",
        timeout_ms: 1_000,
      },
      fallback: {
        adapter: "command",
        model: "fallback-model",
        purpose: "Fallback review",
        instructions: "Review the workspace.",
        isolation: "prefer_enforced",
        timeout_ms: 1_000,
      },
    },
    defaults: { agents: ["fallback"] },
    projects: { [projectName]: { agents: ["project"] } },
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("project-name discovery", () => {
  it("uses one origin repository name across differently named clones", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-mesh-project-name-"));
    roots.push(root);
    const source = join(root, "source-checkout");
    const remote = join(root, "stable-project.git");
    const firstClone = join(root, "first-location");
    const secondClone = join(root, "renamed-location");
    await mkdir(source);
    await git(source, ["init"]);
    await git(source, ["config", "user.name", "Review Mesh Test"]);
    await git(source, ["config", "user.email", "review-mesh@example.test"]);
    await writeFile(join(source, "README.md"), "fixture\n");
    await git(source, ["add", "README.md"]);
    await git(source, ["commit", "-m", "Initial fixture"]);
    await git(root, ["clone", "--bare", source, remote]);
    await git(root, ["clone", remote, firstClone]);
    await git(root, ["clone", remote, secondClone]);

    const first = await resolveProjectName(firstClone);
    const second = await resolveProjectName(secondClone);
    expect(first).toEqual({ name: "stable-project", source: "git_remote" });
    expect(second).toEqual(first);

    const trusted = config(first.name);
    expect(
      resolveConfig({
        trusted,
        workspace: firstClone,
        projectName: first.name,
        projectNameSource: first.source,
      }).reviewers.map(({ id }) => id),
    ).toEqual(["project"]);
    expect(
      resolveConfig({
        trusted,
        workspace: secondClone,
        projectName: second.name,
        projectNameSource: second.source,
      }).reviewers.map(({ id }) => id),
    ).toEqual(["project"]);
  });

  it("uses the shared Git common-directory name for a linked worktree without remotes", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-mesh-project-name-"));
    roots.push(root);
    const repository = join(root, "shared-repository");
    const worktree = join(root, "unrelated-worktree-name");
    await mkdir(repository);
    await git(repository, ["init"]);
    await git(repository, ["config", "user.name", "Review Mesh Test"]);
    await git(repository, ["config", "user.email", "review-mesh@example.test"]);
    await writeFile(join(repository, "README.md"), "fixture\n");
    await git(repository, ["add", "README.md"]);
    await git(repository, ["commit", "-m", "Initial fixture"]);
    await git(repository, [
      "worktree",
      "add",
      "-b",
      "fixture-worktree",
      worktree,
    ]);

    expect(await resolveProjectName(repository)).toEqual({
      name: "shared-repository",
      source: "git_common_directory",
    });
    expect(await resolveProjectName(worktree)).toEqual({
      name: "shared-repository",
      source: "git_common_directory",
    });
  });

  it("falls back to the workspace directory name outside Git", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-mesh-project-name-"));
    roots.push(root);
    const workspace = join(root, "plain-project");
    await mkdir(workspace);
    expect(await resolveProjectName(workspace)).toEqual({
      name: "plain-project",
      source: "workspace",
    });
  });
});
