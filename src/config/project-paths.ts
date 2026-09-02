import {
  isAbsolute,
  normalize,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";
import type { ProjectConfig } from "./schemas.js";

export interface SelectedProject {
  path: string;
  project: ProjectConfig;
}

/** Normalizes a configured absolute project path for host-local comparison. */
export function normalizedProjectPath(path: string): string {
  if (!isAbsolute(path)) {
    throw new Error(`project path must be absolute: ${path}`);
  }
  const absolute = normalize(resolve(path));
  const root = parse(absolute).root;
  const withoutTrailingSeparators =
    absolute === root ? absolute : absolute.replace(/[\\/]+$/, "");
  return process.platform === "win32"
    ? withoutTrailingSeparators.toLowerCase()
    : withoutTrailingSeparators;
}

/** Rejects ambiguous project maps before they can be saved or resolved. */
export function validateProjectKeys(
  projects: Readonly<Record<string, ProjectConfig>> | undefined,
): void {
  const normalized = new Map<string, string>();
  for (const path of Object.keys(projects ?? {})) {
    const key = normalizedProjectPath(path);
    const previous = normalized.get(key);
    if (previous !== undefined) {
      throw new Error(
        `duplicate normalized project path: ${path} conflicts with ${previous}`,
      );
    }
    normalized.set(key, path);
  }
}

/** Selects the most-specific configured project containing the workspace. */
export function selectProject(
  projects: Readonly<Record<string, ProjectConfig>> | undefined,
  workspace: string | undefined,
): SelectedProject | undefined {
  validateProjectKeys(projects);
  if (workspace === undefined) return undefined;
  const workspaceKey = normalizedProjectPath(workspace);
  let selected:
    | { path: string; comparisonPath: string; project: ProjectConfig }
    | undefined;
  for (const [path, project] of Object.entries(projects ?? {})) {
    const comparisonPath = normalizedProjectPath(path);
    const remainder = relative(comparisonPath, workspaceKey);
    const contains =
      remainder === "" ||
      (remainder !== ".." &&
        !remainder.startsWith(`..${sep}`) &&
        !isAbsolute(remainder));
    if (
      contains &&
      (selected === undefined ||
        comparisonPath.length > selected.comparisonPath.length)
    ) {
      selected = { path, comparisonPath, project };
    }
  }
  return selected === undefined
    ? undefined
    : { path: selected.path, project: selected.project };
}
