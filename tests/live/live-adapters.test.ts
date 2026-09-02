import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createClaudeAdapter } from "../../src/adapters/claude.js";
import { createCodexAdapter } from "../../src/adapters/codex.js";
import { createCopilotAdapter } from "../../src/adapters/copilot.js";
import type { ReviewAdapter } from "../../src/adapters/types.js";
import type {
  AdapterRegistration,
  ReviewerProfile,
  ResolvedReviewer,
} from "../../src/config/schemas.js";
import { createGitRunner } from "../../src/context/git.js";
import { resolveContext } from "../../src/context/resolve.js";
import { reviewerResultJsonSchema } from "../../src/protocol/json-schema.js";
import { buildReviewerPrompt } from "../../src/protocol/prompt.js";
import { reviewerResultSchema } from "../../src/protocol/schemas.js";

const executeFile = promisify(execFile);
const enabled = process.env.REVIEW_MESH_LIVE === "1";
const roots: string[] = [];

type AdapterType = "codex" | "claude" | "copilot";

interface LiveReviewerDefinition extends Pick<
  ReviewerProfile,
  "model" | "purpose" | "isolation" | "timeout_ms"
> {
  adapter: AdapterRegistration;
  instructions: string;
  runtime?: ReviewerProfile["runtime"];
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function createBugRepository(): Promise<{
  root: string;
  sentinel: string;
  sentinelHash: string;
  initialStatus: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "review-mesh-live-"));
  roots.push(root);
  const sentinel = join(root, "SENTINEL.txt");
  await writeFile(
    join(root, "bug.js"),
    "export function divide(total, count) { return total / count; }\n",
  );
  await writeFile(sentinel, "review-mesh-live-sentinel\n");
  await mkdir(join(root, "nested"));
  await executeFile("git", ["init", "--initial-branch=main"], { cwd: root });
  await executeFile("git", ["config", "user.email", "live@example.invalid"], {
    cwd: root,
  });
  await executeFile("git", ["config", "user.name", "Review Mesh Live"], {
    cwd: root,
  });
  await executeFile("git", ["add", "."], { cwd: root });
  await executeFile("git", ["commit", "-m", "fixture"], { cwd: root });
  const { stdout } = await executeFile(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: root },
  );
  return {
    root,
    sentinel,
    sentinelHash: hash(await readFile(sentinel, "utf8")),
    initialStatus: stdout,
  };
}

function parseDefinition(name: string): LiveReviewerDefinition | undefined {
  const value = process.env[name];
  if (!enabled || value === undefined) return undefined;
  const definition = JSON.parse(value) as LiveReviewerDefinition;
  if (definition.adapter === undefined || definition.model === undefined) {
    throw new Error(`${name} must contain adapter and model`);
  }
  return definition;
}

function resolvedReviewer(
  type: AdapterType,
  definition: LiveReviewerDefinition,
): ResolvedReviewer {
  return {
    id: `live-${type}`,
    purpose: definition.purpose,
    adapterId: type,
    adapter: definition.adapter,
    model: definition.model,
    instruction_layers: [
      { source: "trusted", content: definition.instructions },
    ],
    isolationPolicy: definition.isolation,
    timeoutMs: definition.timeout_ms,
    runtime: definition.runtime ?? {},
  };
}

function createAdapter(
  type: AdapterType,
  registration: AdapterRegistration,
): ReviewAdapter {
  if (type === "codex") return createCodexAdapter(registration);
  if (type === "claude") return createClaudeAdapter(registration);
  return createCopilotAdapter(registration);
}

async function runLiveAdapter(
  type: AdapterType,
  definition: LiveReviewerDefinition,
): Promise<void> {
  expect(definition.adapter.type).toBe(type);
  const repository = await createBugRepository();
  const reviewer = resolvedReviewer(type, definition);
  const context = await resolveContext({
    request: {
      schema_version: "2",
      project_name: "live-project",
      workspace: repository.root,
      instructions:
        "Review this repository. Report the divide-by-zero defect if actionable.",
      review_scope: { mode: "full" },
    },
    git: createGitRunner(),
    signal: new AbortController().signal,
  });
  const prompt = buildReviewerPrompt({
    reviewer,
    context,
    resultJsonSchema: reviewerResultJsonSchema,
  });
  const adapter = createAdapter(type, definition.adapter);
  const controller = new AbortController();
  const capabilities = await adapter.probe(reviewer, controller.signal);
  expect(capabilities.available, capabilities.message).toBe(true);

  const events = [];
  for await (const event of adapter.run({
    runId: `live-${type}`,
    reviewer,
    context,
    prompt,
    resultJsonSchema: reviewerResultJsonSchema,
    isolationPolicy: reviewer.isolationPolicy,
    signal: controller.signal,
  })) {
    events.push(event);
  }

  const terminal = events.filter(
    (event) => event.type === "result" || event.type === "failure",
  );
  expect(terminal).toHaveLength(1);
  expect(terminal[0]?.type).toBe("result");
  if (terminal[0]?.type !== "result") throw new Error("live review failed");
  reviewerResultSchema.parse(terminal[0].result);
  expect(hash(await readFile(repository.sentinel, "utf8"))).toBe(
    repository.sentinelHash,
  );
  const { stdout: finalStatus } = await executeFile(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: repository.root },
  );
  expect(finalStatus).toBe(repository.initialStatus);
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("live adapters", () => {
  for (const [type, environmentName] of [
    ["codex", "REVIEW_MESH_LIVE_CODEX_REVIEWER"],
    ["claude", "REVIEW_MESH_LIVE_CLAUDE_REVIEWER"],
    ["copilot", "REVIEW_MESH_LIVE_COPILOT_REVIEWER"],
  ] as const) {
    const definition = parseDefinition(environmentName);
    it.skipIf(definition === undefined)(
      `runs a real ${type} review without modifying the repository`,
      async () => runLiveAdapter(type, definition!),
      600_000,
    );
  }
});
