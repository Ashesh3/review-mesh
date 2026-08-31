import { execa } from "execa";

const TRUSTED_GIT_CONFIG = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.pager=cat",
  "-c",
  "pager.status=false",
  "-c",
  "pager.diff=false",
] as const;

const TRUSTED_GIT_ENVIRONMENT = {
  GIT_ATTR_NOSYSTEM: "1",
  GIT_DIFF_OPTS: "",
  GIT_EXTERNAL_DIFF: "",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_PAGER: "",
  GIT_TERMINAL_PROMPT: "0",
  PAGER: "",
} as const;

interface GitProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  isMaxBuffer?: boolean;
}

interface GitExecuteOptions {
  cwd: string;
  reject: false;
  timeout: number;
  cancelSignal?: AbortSignal;
  env: Readonly<Record<string, string>>;
  maxBuffer: number;
}

export type GitExecutor = (
  file: string,
  args: readonly string[],
  options: GitExecuteOptions,
) => Promise<GitProcessResult>;

export interface GitRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  outputTruncated?: boolean;
}

export interface GitRunner {
  run(
    args: readonly string[],
    options: { cwd: string; signal?: AbortSignal },
  ): Promise<GitRunResult>;
}

export function createGitRunner(
  execute: GitExecutor = execa as unknown as GitExecutor,
): GitRunner {
  return {
    async run(args, { cwd, signal }) {
      const result = await execute("git", [...TRUSTED_GIT_CONFIG, ...args], {
        cwd,
        reject: false,
        timeout: 15_000,
        ...(signal === undefined ? {} : { cancelSignal: signal }),
        env: TRUSTED_GIT_ENVIRONMENT,
        // Read-only discovery bounds data again before it becomes manifest data.
        // This limits process buffering in the exceptional case as well.
        maxBuffer: 1_048_576,
      });
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode ?? 1,
        ...(result.isMaxBuffer === true ? { outputTruncated: true } : {}),
      };
    },
  };
}
