import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { userInfo } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { CodexOptions } from "@openai/codex-sdk";
import { stringify } from "smol-toml";
import { buildAllowlistedEnvironment } from "../adapters/types.js";

const execute = promisify(execFile);
type SkillDisable = { path: string; enabled: false };
export interface CodexIsolationHome {
  directory: string;
  home: string;
  workingDirectory: string;
  config: NonNullable<CodexOptions["config"]>;
  cleanup(): Promise<void>;
}

/** Mirrors native local skill roots, without reading any skill bodies or login state. */
async function ambientSkillRoots(): Promise<string[]> {
  let systemRoot = "/etc/codex/skills";
  if (process.platform === "win32") {
    const windowsRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    if (!windowsRoot)
      throw new Error("Windows system directory is unavailable.");
    const result = await execute(
      join(
        windowsRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData)",
      ],
      {
        env: buildAllowlistedEnvironment([]),
        windowsHide: true,
        timeout: 5_000,
        maxBuffer: 16_384,
      },
    );
    const commonData = result.stdout.trim();
    if (!isAbsolute(commonData))
      throw new Error("Windows common application data is unavailable.");
    systemRoot = join(commonData, "OpenAI", "Codex", "skills");
  }
  return [join(userInfo().homedir, ".agents", "skills"), systemRoot];
}

/** Exact canonical path selectors also block explicit $skill activation. */
export async function enumerateCodexSkillDisables(
  roots: readonly string[],
  options: { maximumEntries?: number; maximumDepth?: number } = {},
): Promise<SkillDisable[]> {
  const maximumEntries = options.maximumEntries ?? 20_000;
  const maximumDepth = options.maximumDepth ?? 64;
  const seen = new Set<string>();
  const disabled = new Set<string>();
  let count = 0;
  async function scan(path: string, depth: number): Promise<void> {
    if (depth > maximumDepth || ++count > maximumEntries)
      throw new Error("Codex skill isolation scan limit exceeded.");
    let canonical: string;
    try {
      canonical = await realpath(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && depth === 0)
        return;
      throw error;
    }
    const key =
      process.platform === "win32" ? canonical.toLowerCase() : canonical;
    const metadata = await stat(canonical);
    if (metadata.isDirectory()) {
      if (seen.has(key)) return;
      seen.add(key);
      for (const entry of await readdir(canonical, { withFileTypes: true })) {
        await scan(join(canonical, entry.name), depth + 1);
      }
    } else if (metadata.isFile() && /(?:^|[\\/])skill\.md$/i.test(path)) {
      disabled.add(canonical);
    }
  }
  for (const root of roots) await scan(root, 0);
  return [...disabled].sort().map((path) => ({ path, enabled: false }));
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink())
    throw new Error("Codex isolation directory is not a regular directory.");
}

export async function createCodexIsolationHome(
  applicationDataDirectory: string,
  systemPrompt: string,
): Promise<CodexIsolationHome> {
  await privateDirectory(applicationDataDirectory);
  const applicationRoot = await realpath(applicationDataDirectory);
  const runtimeRoot = join(applicationRoot, "runtime");
  await privateDirectory(runtimeRoot);
  const codexRoot = join(runtimeRoot, "codex");
  await privateDirectory(codexRoot);
  const directory = await mkdtemp(join(codexRoot, "native-"));
  const home = join(directory, "home");
  const workingDirectory = join(directory, "workspace");
  const cleanup = async () => {
    const containment = relative(codexRoot, resolve(directory));
    if (!containment || containment.startsWith("..") || isAbsolute(containment))
      throw new Error("Codex cleanup path escaped its runtime directory.");
    await rm(directory, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  };
  try {
    await privateDirectory(home);
    await privateDirectory(workingDirectory);
    const disabledSkills = await enumerateCodexSkillDisables(
      await ambientSkillRoots(),
    );
    const config: NonNullable<CodexOptions["config"]> = {
      developer_instructions: systemPrompt,
      project_doc_max_bytes: 0,
      project_root_markers: [],
      mcp_servers: {},
      features: {
        hooks: false,
        apps: false,
        plugins: false,
        multi_agent: false,
        memories: false,
        external_agent_memory_import: false,
        skill_search: false,
        goals: false,
        shell_snapshot: false,
      },
      skills: {
        include_instructions: false,
        bundled: { enabled: false },
        config: disabledSkills,
      },
      history: { persistence: "none" },
      shell_environment_policy: {
        inherit: "core",
        ignore_default_excludes: false,
        use_profile: false,
      },
      ...(process.platform === "win32"
        ? { windows: { sandbox: "unelevated" } }
        : {}),
    };
    await writeFile(join(home, "config.toml"), stringify(config), {
      flag: "wx",
      mode: 0o600,
    });
    return { directory, home, workingDirectory, cleanup, config };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
