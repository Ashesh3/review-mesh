import { execa } from "execa";

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

export function createGitRunner(): GitRunner {
  return {
    async run(args, { cwd, signal }) {
      const result = await execa("git", args, {
        cwd,
        reject: false,
        timeout: 15_000,
        ...(signal === undefined ? {} : { cancelSignal: signal }),
        env: { GIT_OPTIONAL_LOCKS: "0" },
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
