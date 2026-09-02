import { realpath, stat } from "node:fs/promises";
import type { ReviewRequest, JsonValue } from "../protocol/schemas.js";
import type { GitRunner, GitRunResult } from "./git.js";

const MAX_STATUS_ENTRIES = 2_000;
const MAX_CHANGED_FILES = 10_000;
const MAX_DIFF_STAT_BYTES = 64 * 1_024;
const MAX_DIFF_BYTES = 2 * 1_024 * 1_024;
const MAX_ERROR_BYTES = 8 * 1_024;

export class ReviewScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewScopeError";
  }
}

export interface RefResolution {
  requested: string;
  resolved: string | null;
  error?: string;
}

export interface NonGitContext {
  is_repository: false;
}

export interface GitContext {
  is_repository: true;
  root: string;
  branch: string | null;
  head: string | null;
  base?: RefResolution;
  requested_head?: RefResolution;
  merge_base: string | null;
  status_entries: string[];
  changed_files: string[];
  diff_stat: string;
  diff: string;
  truncated: {
    status_entries: boolean;
    changed_files: boolean;
    diff_stat: boolean;
    diff: boolean;
  };
}

export interface ResolvedContext {
  consistency_mode: "live_worktree";
  workspace: string;
  project_name: string;
  instructions: string;
  caller_context?: JsonValue;
  review_scope: {
    mode: "changes" | "full";
    source: "request";
    base?: string;
    head?: string;
    branch?: string;
    paths?: string[];
  };
  git: NonGitContext | GitContext;
}

export interface ResolveContextInput {
  request: ReviewRequest;
  git: GitRunner;
  signal?: AbortSignal;
}

interface BoundedText {
  value: string;
  truncated: boolean;
}

function boundedText(value: string, maximumBytes: number): BoundedText {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength <= maximumBytes) return { value, truncated: false };
  let end = maximumBytes;
  let leadingByte = end - 1;
  while (
    leadingByte >= 0 &&
    (encoded[leadingByte]! & 0b1100_0000) === 0b1000_0000
  ) {
    leadingByte -= 1;
  }
  const leadingByteLength =
    leadingByte < 0
      ? 0
      : (encoded[leadingByte]! & 0b1111_1000) === 0b1111_0000
        ? 4
        : (encoded[leadingByte]! & 0b1111_0000) === 0b1110_0000
          ? 3
          : (encoded[leadingByte]! & 0b1110_0000) === 0b1100_0000
            ? 2
            : 1;
  if (leadingByte + leadingByteLength > end) end = leadingByte;
  return {
    value: encoded.subarray(0, end).toString("utf8"),
    truncated: true,
  };
}

function boundedError(result: GitRunResult): string {
  const message =
    result.stderr || result.stdout || `git exited with ${result.exitCode}`;
  return boundedText(message, MAX_ERROR_BYTES).value;
}

function trimOutput(result: GitRunResult): string | null {
  return result.exitCode === 0 ? result.stdout.trim() || null : null;
}

function resolveBranch(result: GitRunResult): string | null {
  const branch = trimOutput(result);
  return branch === "HEAD" ? null : branch;
}

function boundedLines(
  value: string,
  maximum: number,
): {
  values: string[];
  truncated: boolean;
} {
  const values = value.split(/\r?\n/).filter((line) => line.length > 0);
  return {
    values: values.slice(0, maximum),
    truncated: values.length > maximum,
  };
}

function boundedPaths(
  value: string,
  maximum: number,
): {
  values: string[];
  truncated: boolean;
} {
  const values = value.split("\0").filter((path) => path.length > 0);
  return {
    values: values.slice(0, maximum),
    truncated: values.length > maximum,
  };
}

function pathspecArgs(paths: readonly string[] | undefined): string[] {
  return paths === undefined || paths.length === 0 ? [] : ["--", ...paths];
}

async function run(
  git: GitRunner,
  args: readonly string[],
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<GitRunResult> {
  return git.run(args, signal === undefined ? { cwd } : { cwd, signal });
}

async function resolveRef(
  git: GitRunner,
  cwd: string,
  requested: string,
  signal: AbortSignal | undefined,
): Promise<RefResolution> {
  const result = await run(
    git,
    ["rev-parse", "--verify", "--end-of-options", `${requested}^{commit}`],
    cwd,
    signal,
  );
  const resolved = trimOutput(result);
  return resolved === null
    ? { requested, resolved: null, error: boundedError(result) }
    : { requested, resolved };
}

type NormalizedReviewScope = ResolvedContext["review_scope"];

function normalizedReviewScope(request: ReviewRequest): NormalizedReviewScope {
  return {
    mode: request.review_scope.mode,
    source: "request",
    ...(request.review_scope.mode !== "changes" ||
    request.review_scope.base === undefined
      ? {}
      : { base: request.review_scope.base }),
    ...(request.review_scope.mode !== "changes" ||
    request.review_scope.head === undefined
      ? {}
      : { head: request.review_scope.head }),
    ...(request.review_scope.mode !== "changes" ||
    request.review_scope.branch === undefined
      ? {}
      : { branch: request.review_scope.branch }),
    ...(request.review_scope.paths === undefined
      ? {}
      : { paths: [...request.review_scope.paths] }),
  };
}

async function defaultBaseRef(
  git: GitRunner,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<RefResolution | undefined> {
  const candidates: string[] = [];
  const remotes = trimOutput(await run(git, ["remote"], cwd, signal))
    ?.split(/\r?\n/u)
    .map((remote) => remote.trim())
    .filter(Boolean);
  for (const remote of [
    ...(remotes?.includes("origin") === true ? ["origin"] : []),
    ...(remotes ?? []).filter((name) => name !== "origin").sort(),
  ]) {
    const symbolic = trimOutput(
      await run(
        git,
        ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`],
        cwd,
        signal,
      ),
    );
    if (symbolic !== null) candidates.push(symbolic);
    candidates.push(`${remote}/main`, `${remote}/master`);
  }
  candidates.push("main", "master");

  for (const candidate of [...new Set(candidates)]) {
    const resolved = await resolveRef(git, cwd, candidate, signal);
    if (resolved.resolved !== null) return resolved;
  }
  return undefined;
}

export async function resolveContext({
  request,
  git,
  signal,
}: ResolveContextInput): Promise<ResolvedContext> {
  const workspace = await realpath(request.workspace);
  if (!(await stat(workspace)).isDirectory()) {
    throw new Error(`workspace is not a directory: ${workspace}`);
  }

  const reviewScope = normalizedReviewScope(request);
  const manifest: Omit<ResolvedContext, "git"> = {
    consistency_mode: "live_worktree",
    workspace,
    project_name: request.project_name,
    instructions: request.instructions,
    ...(request.context === undefined
      ? {}
      : { caller_context: request.context }),
    review_scope: reviewScope,
  };
  const inside = await run(
    git,
    ["rev-parse", "--is-inside-work-tree"],
    workspace,
    signal,
  );
  if (trimOutput(inside) !== "true") {
    if (reviewScope.mode === "changes") {
      throw new ReviewScopeError(
        "Change-focused review requires a Git repository; use review_scope.mode=full for a non-Git workspace.",
      );
    }
    return { ...manifest, git: { is_repository: false } };
  }

  const [rootResult, headResult, branchResult] = await Promise.all([
    run(git, ["rev-parse", "--show-toplevel"], workspace, signal),
    run(git, ["rev-parse", "HEAD"], workspace, signal),
    run(git, ["rev-parse", "--abbrev-ref", "HEAD"], workspace, signal),
  ]);
  const root = trimOutput(rootResult);
  if (root === null) {
    throw new Error(
      `could not resolve Git worktree root: ${boundedError(rootResult)}`,
    );
  }

  const branch = resolveBranch(branchResult);
  if (reviewScope.branch !== undefined && reviewScope.branch !== branch) {
    throw new ReviewScopeError(
      `Requested branch ${reviewScope.branch} does not match checked-out branch ${branch ?? "<detached>"}.`,
    );
  }

  const requestedHead =
    reviewScope.mode === "changes"
      ? await resolveRef(git, workspace, reviewScope.head ?? "HEAD", signal)
      : undefined;
  if (requestedHead?.resolved === null) {
    throw new ReviewScopeError(
      `Could not resolve requested review head ${requestedHead.requested}.`,
    );
  }
  const actualHead = trimOutput(headResult);
  if (
    requestedHead?.resolved !== undefined &&
    actualHead !== null &&
    requestedHead.resolved !== actualHead
  ) {
    throw new ReviewScopeError(
      "The requested review head does not match the checked-out workspace HEAD.",
    );
  }
  const base =
    reviewScope.mode !== "changes"
      ? undefined
      : reviewScope.base === undefined
        ? await defaultBaseRef(git, workspace, signal)
        : await resolveRef(git, workspace, reviewScope.base, signal);
  if (reviewScope.mode === "changes" && base?.resolved == null) {
    throw new ReviewScopeError(
      reviewScope.base === undefined
        ? "Could not infer the repository default branch; pass review_scope.base explicitly."
        : `Could not resolve requested review base ${base?.requested ?? reviewScope.base}.`,
    );
  }
  let mergeBase: string | null = null;
  if (
    base?.resolved !== null &&
    base?.resolved !== undefined &&
    requestedHead?.resolved !== null &&
    requestedHead?.resolved !== undefined
  ) {
    const result = await run(
      git,
      ["merge-base", base.resolved, requestedHead.resolved],
      workspace,
      signal,
    );
    mergeBase = trimOutput(result);
    if (mergeBase === null) {
      throw new ReviewScopeError(
        "The requested review base and checked-out head do not have a resolvable merge base.",
      );
    }
  }

  const paths = pathspecArgs(reviewScope.paths);
  const [
    statusResult,
    committedDiffResult,
    unstagedDiffResult,
    stagedDiffResult,
    committedPathsResult,
    unstagedPathsResult,
    committedStatResult,
    stagedPathsResult,
    untrackedPathsResult,
    unstagedStatResult,
    stagedStatResult,
  ] = await Promise.all([
    run(
      git,
      ["status", "--porcelain=v2", "--untracked-files=all", ...paths],
      workspace,
      signal,
    ),
    mergeBase === null || requestedHead?.resolved == null
      ? Promise.resolve<GitRunResult>({ stdout: "", stderr: "", exitCode: 0 })
      : run(
          git,
          [
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--unified=3",
            "--no-color",
            mergeBase,
            requestedHead.resolved,
            ...paths,
          ],
          workspace,
          signal,
        ),
    run(
      git,
      [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--unified=3",
        "--no-color",
        ...paths,
      ],
      workspace,
      signal,
    ),
    run(
      git,
      [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--cached",
        "--unified=3",
        "--no-color",
        ...paths,
      ],
      workspace,
      signal,
    ),
    mergeBase === null || requestedHead?.resolved == null
      ? Promise.resolve<GitRunResult>({ stdout: "", stderr: "", exitCode: 0 })
      : run(
          git,
          [
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--name-only",
            "-z",
            mergeBase,
            requestedHead.resolved,
            ...paths,
          ],
          workspace,
          signal,
        ),
    run(
      git,
      ["diff", "--no-ext-diff", "--no-textconv", "--name-only", "-z", ...paths],
      workspace,
      signal,
    ),
    mergeBase === null || requestedHead?.resolved == null
      ? Promise.resolve<GitRunResult>({ stdout: "", stderr: "", exitCode: 0 })
      : run(
          git,
          [
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--stat",
            mergeBase,
            requestedHead.resolved,
            ...paths,
          ],
          workspace,
          signal,
        ),
    run(
      git,
      [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--cached",
        "--name-only",
        "-z",
        ...paths,
      ],
      workspace,
      signal,
    ),
    run(
      git,
      ["ls-files", "--others", "--exclude-standard", "-z", ...paths],
      workspace,
      signal,
    ),
    run(
      git,
      ["diff", "--no-ext-diff", "--no-textconv", "--stat", ...paths],
      workspace,
      signal,
    ),
    run(
      git,
      [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--cached",
        "--stat",
        ...paths,
      ],
      workspace,
      signal,
    ),
  ]);
  if (
    reviewScope.mode === "changes" &&
    [
      statusResult,
      committedDiffResult,
      unstagedDiffResult,
      stagedDiffResult,
      committedPathsResult,
      unstagedPathsResult,
      committedStatResult,
      stagedPathsResult,
      untrackedPathsResult,
      unstagedStatResult,
      stagedStatResult,
    ].some((result) => result.exitCode !== 0)
  ) {
    throw new ReviewScopeError(
      "Review Mesh could not collect the complete Git change scope.",
    );
  }
  const status = boundedLines(
    statusResult.exitCode === 0 ? statusResult.stdout : "",
    MAX_STATUS_ENTRIES,
  );
  const committedPaths = boundedPaths(
    committedPathsResult.exitCode === 0 ? committedPathsResult.stdout : "",
    MAX_CHANGED_FILES,
  );
  const unstagedPaths = boundedPaths(
    unstagedPathsResult.exitCode === 0 ? unstagedPathsResult.stdout : "",
    MAX_CHANGED_FILES,
  );
  const stagedPaths = boundedPaths(
    stagedPathsResult.exitCode === 0 ? stagedPathsResult.stdout : "",
    MAX_CHANGED_FILES,
  );
  const untrackedPaths = boundedPaths(
    untrackedPathsResult.exitCode === 0 ? untrackedPathsResult.stdout : "",
    MAX_CHANGED_FILES,
  );
  const changedFiles = [
    ...new Set([
      ...unstagedPaths.values,
      ...stagedPaths.values,
      ...untrackedPaths.values,
      ...committedPaths.values,
    ]),
  ];
  const changedFilesTruncated =
    committedPaths.truncated ||
    unstagedPaths.truncated ||
    stagedPaths.truncated ||
    untrackedPaths.truncated ||
    unstagedPathsResult.outputTruncated === true ||
    stagedPathsResult.outputTruncated === true ||
    untrackedPathsResult.outputTruncated === true ||
    committedPathsResult.outputTruncated === true ||
    changedFiles.length > MAX_CHANGED_FILES;
  const diffStat = boundedText(
    [committedStatResult, unstagedStatResult, stagedStatResult]
      .filter((result) => result.exitCode === 0 && result.stdout.length > 0)
      .map((result) => result.stdout)
      .join("\n"),
    MAX_DIFF_STAT_BYTES,
  );
  const diff = boundedText(
    [committedDiffResult, unstagedDiffResult, stagedDiffResult]
      .filter((result) => result.exitCode === 0 && result.stdout.length > 0)
      .map((result) => result.stdout)
      .join("\n"),
    MAX_DIFF_BYTES,
  );

  return {
    ...manifest,
    git: {
      is_repository: true,
      root: await realpath(root),
      branch,
      head: actualHead,
      ...(base === undefined ? {} : { base }),
      ...(requestedHead === undefined ? {} : { requested_head: requestedHead }),
      merge_base: mergeBase,
      status_entries: status.values,
      changed_files: changedFiles.slice(0, MAX_CHANGED_FILES),
      diff_stat: diffStat.value,
      diff: diff.value,
      truncated: {
        status_entries:
          status.truncated || statusResult.outputTruncated === true,
        changed_files: changedFilesTruncated,
        diff_stat:
          diffStat.truncated ||
          committedStatResult.outputTruncated === true ||
          unstagedStatResult.outputTruncated === true ||
          stagedStatResult.outputTruncated === true,
        diff:
          diff.truncated ||
          committedDiffResult.outputTruncated === true ||
          unstagedDiffResult.outputTruncated === true ||
          stagedDiffResult.outputTruncated === true,
      },
    },
  };
}
