import { realpath } from "node:fs/promises";
import { basename, dirname, normalize, parse, resolve } from "node:path";
import { createGitRunner, type GitRunner } from "../context/git.js";
import { projectNameSchema, type ProjectConfig } from "./schemas.js";

export type ProjectNameSource =
  "git_remote" | "git_common_directory" | "git_root" | "workspace";

export interface ResolvedProjectName {
  name: string;
  source: ProjectNameSource;
}

export interface SelectedProjectByName {
  name: string;
  project: ProjectConfig;
}

function normalizedName(name: string): string {
  return name.toLocaleLowerCase("en-US");
}

/** Validates one portable project name used as a v4 configuration key. */
export function requireProjectName(value: string): string {
  return projectNameSchema.parse(value);
}

/** Rejects project-name maps whose keys would match ambiguously. */
export function validateProjectNames(
  projects: Readonly<Record<string, ProjectConfig>> | undefined,
): void {
  const normalized = new Map<string, string>();
  for (const name of Object.keys(projects ?? {})) {
    requireProjectName(name);
    const key = normalizedName(name);
    const previous = normalized.get(key);
    if (previous !== undefined) {
      throw new Error(
        `duplicate normalized project name: ${name} conflicts with ${previous}`,
      );
    }
    normalized.set(key, name);
  }
}

/** Selects the configured project whose name matches the resolved repository. */
export function selectProjectByName(
  projects: Readonly<Record<string, ProjectConfig>> | undefined,
  projectName: string | undefined,
): SelectedProjectByName | undefined {
  validateProjectNames(projects);
  if (projectName === undefined) return undefined;
  const requested = normalizedName(requireProjectName(projectName));
  const entry = Object.entries(projects ?? {}).find(
    ([name]) => normalizedName(name) === requested,
  );
  return entry === undefined
    ? undefined
    : { name: entry[0], project: entry[1] };
}

/** Derives a project name when migrating a legacy absolute-path project key. */
export function projectNameFromLegacyPath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/u, "");
  const name = trimmed.split(/[\\/]/u).filter(Boolean).at(-1);
  if (name === undefined || /^[A-Za-z]:$/u.test(name)) {
    throw new Error(`cannot derive a project name from legacy path: ${path}`);
  }
  return requireProjectName(name);
}

function projectNameFromRemoteUrl(remoteUrl: string): string | undefined {
  const withoutQuery = remoteUrl.trim().split(/[?#]/u, 1)[0] ?? "";
  const trimmed = withoutQuery.replace(/[\\/]+$/u, "");
  const segment = trimmed
    .split(/[\\/:]/u)
    .filter(Boolean)
    .at(-1);
  if (segment === undefined) return undefined;
  const candidate = segment.replace(/\.git$/iu, "");
  try {
    return requireProjectName(decodeURIComponent(candidate));
  } catch {
    return undefined;
  }
}

function lines(value: string): string[] {
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function gitOutput(
  git: GitRunner,
  workspace: string,
  args: readonly string[],
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  if (signal?.aborted) throw signal.reason ?? new Error("operation aborted");
  try {
    const result = await git.run(
      args,
      signal === undefined ? { cwd: workspace } : { cwd: workspace, signal },
    );
    return result.exitCode === 0 && result.stdout.trim().length > 0
      ? result.stdout.trim()
      : undefined;
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    return undefined;
  }
}

function directoryProjectName(path: string): string {
  const name = basename(normalize(path));
  if (name.length > 0) return requireProjectName(name);
  const root = parse(path).root.replace(/[^A-Za-z0-9._-]+/gu, "");
  return requireProjectName(root.length === 0 ? "root" : root);
}

async function remoteProjectName(
  git: GitRunner,
  workspace: string,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  const origin = await gitOutput(
    git,
    workspace,
    ["remote", "get-url", "origin"],
    signal,
  );
  const originName =
    origin === undefined ? undefined : projectNameFromRemoteUrl(origin);
  if (originName !== undefined) return originName;

  const remotes = lines(
    (await gitOutput(git, workspace, ["remote"], signal)) ?? "",
  ).filter((name) => name !== "origin");
  for (const remote of remotes) {
    const url = await gitOutput(
      git,
      workspace,
      ["remote", "get-url", remote],
      signal,
    );
    const name = url === undefined ? undefined : projectNameFromRemoteUrl(url);
    if (name !== undefined) return name;
  }
  return undefined;
}

/**
 * Resolves stable project identity for a workspace. Git remote repository names
 * are preferred so clones and linked worktrees share one configuration entry.
 */
export async function resolveProjectName(
  workspace: string,
  options: { git?: GitRunner; signal?: AbortSignal } = {},
): Promise<ResolvedProjectName> {
  const canonicalWorkspace = await realpath(workspace);
  const git = options.git ?? createGitRunner();
  const gitRootText = await gitOutput(
    git,
    canonicalWorkspace,
    ["rev-parse", "--show-toplevel"],
    options.signal,
  );
  if (gitRootText === undefined) {
    return {
      name: directoryProjectName(canonicalWorkspace),
      source: "workspace",
    };
  }

  const remoteName = await remoteProjectName(
    git,
    canonicalWorkspace,
    options.signal,
  );
  if (remoteName !== undefined) {
    return { name: remoteName, source: "git_remote" };
  }

  const commonDirectoryText = await gitOutput(
    git,
    canonicalWorkspace,
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    options.signal,
  );
  if (commonDirectoryText !== undefined) {
    const commonDirectory = resolve(canonicalWorkspace, commonDirectoryText);
    const commonBase = basename(normalize(commonDirectory));
    const repositoryDirectory =
      commonBase === ".git" || commonBase.startsWith(".git-")
        ? dirname(commonDirectory)
        : commonDirectory;
    const commonName = basename(normalize(repositoryDirectory));
    try {
      return {
        name: requireProjectName(commonName.replace(/\.git$/iu, "")),
        source: "git_common_directory",
      };
    } catch {
      // Fall through to the worktree root name.
    }
  }

  const canonicalRoot = await realpath(gitRootText);
  return {
    name: directoryProjectName(canonicalRoot),
    source: "git_root",
  };
}
