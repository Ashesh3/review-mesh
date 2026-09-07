import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type CopilotClient, type SessionConfig } from "@github/copilot-sdk";
import { runCli } from "../../src/cli.js";
import { AdapterRegistry } from "../../src/adapters/registry.js";
import { createNativeCopilotAdapter } from "../../src/adapters/native-copilot.js";
import {
  createTestCopilotSession,
  type TestCopilotSession,
} from "./copilot-session.js";

const [root, scenario] = process.argv.slice(2);
if (!root || !scenario) throw new Error("Missing shutdown fixture arguments.");
const workspace = join(root, "workspace");
const configFile = join(root, "config.toml");
const runsDirectory = join(root, "runs");
await mkdir(workspace);
await writeFile(join(workspace, "source.ts"), "export const answer = 42;\n");
await writeFile(
  configFile,
  `schema_version = "7"
[execution]
max_concurrency = 1
heartbeat_interval_ms = 1000
shutdown_grace_period_ms = 1000
deadline_mode = "adaptive"
no_progress_timeout_ms = 10000
retry_attempts = 1
[diagnostics]
persist_runs = true
max_runs = 10
[adapters.native]
type = "sdk"
[agents.review]
adapter = "native"
model = "kimi-k3"
purpose = "Review"
instructions = "Review the fixture"
isolation = "prefer_enforced"
timeout_ms = 60000
${scenario === "deadline" ? "lens_deadline_ms = 1000" : ""}
kind = "generic"
required_input = []
adjudication = "off"
[agents.review.applicability]
mode = "always"
[agents.review.change_coverage]
relevant_paths = ["**"]
minimum_inspection = "full_file"
proof = "native_attested"
[defaults]
agents = ["review"]
`,
);

const signals = new EventEmitter();
let sends = 0;
let disconnects = 0;
let stops = 0;
let forces = 0;
const registry = new AdapterRegistry();
registry.register("copilot", () =>
  createNativeCopilotAdapter(
    {
      type: "copilot",
      base_url_env: "URL",
      api_key_env: "KEY",
    },
    {
      environment: { URL: "http://127.0.0.1:1", KEY: "fixture" },
      applicationDataDirectory: root,
      runtime: () => ({
        executablePath: "fixture",
        pathEntries: [],
        sdkVersion: "1.0.11",
        runtimeVersion: "fixture",
        mode: "managed_process",
      }),
      createClient: () => {
        let session: TestCopilotSession | undefined;
        return {
          async start() {},
          async stop() {
            stops++;
            session?._markDisconnected();
            return [];
          },
          async forceStop() {
            forces++;
            session?._markDisconnected();
          },
          async createSession(config: SessionConfig) {
            session = createTestCopilotSession({
              async sendRequest(method: string) {
                if (method === "session.destroy") disconnects++;
                if (method !== "session.send") return {};
                sends++;
                if (scenario === "deadline")
                  return { messageId: "fixture-message" };
                setImmediate(async () => {
                  if (scenario === "cancel") {
                    signals.emit("SIGINT");
                  } else if (scenario === "error") {
                    session!._dispatchEvent({
                      id: "error",
                      timestamp: new Date().toISOString(),
                      parentId: null,
                      type: "session.error",
                      data: {
                        errorType: "fixture_error",
                        message: "Fixture provider failure",
                      },
                    });
                  } else {
                    const submit = config.tools!.find(
                      (tool) => tool.name === "submit_review",
                    )!;
                    await submit.handler!(
                      {
                        schema_version: "4",
                        verdict: "pass",
                        summary: "No defects",
                        review_markdown: "Complete fixture review.\n".repeat(
                          2000,
                        ),
                        actionable_findings: [],
                        informational_notes: [],
                        native_scope_attestation: {
                          complete: true,
                          reviewed_paths: ["source.ts"],
                          limitations: [],
                        },
                      },
                      {
                        sessionId: "shutdown-fixture",
                        toolCallId: "submit",
                        toolName: "submit_review",
                        arguments: {},
                      },
                    );
                    session!._dispatchEvent({
                      id: "idle",
                      timestamp: new Date().toISOString(),
                      parentId: null,
                      type: "session.idle",
                      ephemeral: true,
                      data: {},
                    });
                  }
                });
                return { messageId: "fixture-message" };
              },
            });
            return session;
          },
        } as unknown as CopilotClient;
      },
    },
  ),
);

process.once("exit", (code) => {
  writeFileSync(
    join(root, "exit.json"),
    JSON.stringify({ code, sends, disconnects, stops, forces }),
  );
});
await runCli(signals, {
  argv: ["review", "--output-mode", "full-jsonl"],
  configFile,
  adapterRegistry: registry,
  appPaths: {
    configFile,
    reviewersDirectory: join(root, "reviewers"),
    runsDirectory,
  },
});
await writeFile(
  join(root, "returned.json"),
  JSON.stringify({
    code: process.exitCode,
    sends,
    disconnects,
    stops,
    forces,
    signalListeners:
      signals.listenerCount("SIGINT") + signals.listenerCount("SIGTERM"),
    resources: process.getActiveResourcesInfo(),
  }),
);
