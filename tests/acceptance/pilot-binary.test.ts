import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import packageMetadata from "../../package.json" with { type: "json" };

const enabled = process.env.REVIEW_MESH_VERIFY_STANDALONE === "1";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function exec(
  file: string,
  args: string[],
  cwd: string,
  input = "",
  env = process.env,
) {
  const child = spawn(file, args, {
    cwd,
    env,
    stdio: "pipe",
    windowsHide: true,
  });
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
  child.stdin.end(input);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { code, stdout, stderr };
}
async function wslPath(path: string) {
  const result = await exec(
    "wsl.exe",
    ["-d", "Ubuntu", "--exec", "wslpath", "-a", path],
    process.cwd(),
  );
  if (result.code) throw new Error(result.stderr);
  return result.stdout.trim();
}

it.skipIf(!enabled)(
  "runs 57 changed Git files through both binaries and both pilot model identities",
  async () => {
    const files = Array.from({ length: 57 }, (_, i) => `source-${i}.ts`);
    const observed = new Map<
      string,
      { reads: Set<string>; repair: boolean; requests: number }
    >();
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/v1/models") {
        response.end(
          JSON.stringify({
            data: [{ id: "gpt-6-astra" }, { id: "claude-opus-5" }],
          }),
        );
        return;
      }
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          const messages = body.messages as Array<Record<string, any>>;
          const model = String(body.model);
          const state = observed.get(model) ?? {
            reads: new Set<string>(),
            repair: false,
            requests: 0,
          };
          observed.set(model, state);
          state.requests++;
          const toolIds = new Set(
            messages
              .filter((m) => m.role === "tool")
              .map((m) => m.tool_call_id),
          );
          for (const message of messages.filter((m) => m.role === "tool")) {
            const result = JSON.parse(message.content);
            if (result.ok && result.path) state.reads.add(result.path);
          }
          let message: Record<string, unknown>;
          if (body.tools) {
            const pending = files
              .filter((path) => !toolIds.has(`read-${path}`))
              .slice(0, 24);
            message = pending.length
              ? {
                  role: "assistant",
                  content: null,
                  tool_calls: pending.map((path) => ({
                    id: `read-${path}`,
                    type: "function",
                    function: {
                      name: "read_file",
                      arguments: JSON.stringify({
                        path,
                        offset: 0,
                        byte_count: 131072,
                      }),
                    },
                  })),
                }
              : { role: "assistant", content: "Inspection complete." };
          } else {
            const assignment = [...messages].reverse().flatMap((m) => {
              try {
                const data = JSON.parse(m.content);
                return data.result_id && Number.isInteger(data.page_index)
                  ? [data]
                  : [];
              } catch {
                return [];
              }
            })[0];
            if (!assignment) throw new Error("No current page assignment");
            const narrative =
              "Inspected all 57 changed files with Unicode evidence λ.\n";
            const malformed = assignment.page_index === 0 && !state.repair;
            if (malformed) state.repair = true;
            const page = {
              schema_version: "1",
              kind: "review-mesh.result-page",
              result_id: assignment.result_id,
              result_kind: "reviewer",
              result_schema_version: "4",
              page_index: assignment.page_index,
              page_count: 2,
              page_kind: assignment.page_index === 0 ? "header" : "narrative",
              previous_page_digest: assignment.previous_page_digest,
              payload:
                assignment.page_index === 0
                  ? {
                      verdict: "pass",
                      summary: malformed
                        ? "x".repeat(1028)
                        : "Complete observed review",
                      informational_notes: [],
                      narrative_byte_count: Buffer.byteLength(narrative),
                      narrative_fragment_count: 1,
                      actionable_finding_count: 0,
                      coverage_attestation: null,
                    }
                  : { text_fragment: narrative },
            };
            message = { role: "assistant", content: JSON.stringify(page) };
          }
          response.end(
            JSON.stringify({ choices: [{ message, finish_reason: "stop" }] }),
          );
        } catch (error) {
          response.statusCode = 500;
          response.end(JSON.stringify({ error: String(error) }));
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No server port");
    try {
      for (const platform of ["Windows", "Linux"]) {
        observed.clear();
        const root = await mkdtemp(join(tmpdir(), "review-mesh-pilot-binary-"));
        roots.push(root);
        const workspace = join(root, "workspace"),
          home = join(root, "home");
        await mkdir(workspace);
        await mkdir(home);
        for (const path of files)
          await writeFile(join(workspace, path), "export const value = 1;\n");
        for (const args of [
          ["init", "--initial-branch=main"],
          ["add", "."],
          [
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@localhost",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.hooksPath=/dev/null",
            "commit",
            "-m",
            "baseline",
          ],
        ]) {
          const result = await exec("git", args, workspace);
          expect(result.code, result.stderr).toBe(0);
        }
        for (const path of files)
          await writeFile(
            join(workspace, path),
            "export const value = 'λ changed';\n",
          );
        const configFile =
          platform === "Windows"
            ? join(home, "review-mesh", "Config", "config.toml")
            : join(home, "review-mesh", "config.toml");
        await mkdir(resolve(configFile, ".."), { recursive: true });
        const agentConfig = ["gpt-6-astra", "claude-opus-5"]
          .map(
            (model, i) => `
[agents.lens${i}]
adapter = "fixture"
model = "${model}"
effort = "max"
purpose = "Pilot acceptance"
instructions = "Inspect all changed files."
isolation = "prefer_enforced"
timeout_ms = 60000
kind = "generic"
required_input = []
adjudication = "off"
[agents.lens${i}.applicability]
mode = "always"
[agents.lens${i}.change_coverage]
relevant_paths = ["**"]
minimum_inspection = "full_file"
proof = "observed"
`,
          )
          .join("\n");
        const config = `schema_version = "7"
[execution]
max_concurrency = 2
heartbeat_interval_ms = 1000
shutdown_grace_period_ms = 1000
deadline_mode = "fixed"
run_deadline_ms = 120000
no_progress_timeout_ms = 30000
[diagnostics]
persist_runs = true
max_runs = 10
[adapters.fixture]
type = "openai_compatible"
base_url_env = "PILOT_BASE_URL"
api_key_env = "PILOT_API_KEY"
streaming = "disabled"
${agentConfig}
[defaults]
agents = ["lens0", "lens1"]
`;
        await writeFile(configFile, config);
        let executable = resolve("dist/release/review-mesh-windows-x64.exe");
        let args: string[] = [],
          requestWorkspace = workspace;
        const environment = {
          ...process.env,
          APPDATA: home,
          LOCALAPPDATA: home,
          PILOT_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
          PILOT_API_KEY: "fixture-local-only",
        };
        if (platform === "Linux") {
          requestWorkspace = await wslPath(workspace);
          const linuxHome = await wslPath(home);
          const host = await exec(
            "wsl.exe",
            [
              "-d",
              "Ubuntu",
              "--exec",
              "sh",
              "-c",
              "ip route show default | cut -d ' ' -f 3",
            ],
            root,
          );
          args = [
            "-d",
            "Ubuntu",
            "--exec",
            "env",
            `XDG_CONFIG_HOME=${linuxHome}`,
            `XDG_DATA_HOME=${linuxHome}/data`,
            `PILOT_BASE_URL=http://${host.stdout.trim()}:${address.port}/v1`,
            "PILOT_API_KEY=fixture-local-only",
            await wslPath(resolve("dist/release/review-mesh-linux-x64")),
          ];
          executable = "wsl.exe";
        }
        const run = (command: string[], input = "") =>
          exec(executable, [...args, ...command], root, input, environment);
        const version = await run(["--version"]);
        expect(version.stdout.trim()).toBe(
          `review-mesh ${packageMetadata.version}`,
        );
        const result = await run(
          ["review"],
          JSON.stringify({
            schema_version: "3",
            project_name: "workspace",
            workspace: requestWorkspace,
            instructions: "Inspect the changed evidence.",
            review_scope: { mode: "changes", base: "HEAD" },
          }),
        );
        expect(
          result.code,
          `${platform}: ${result.stderr}\n${result.stdout.slice(-6000)}`,
        ).toBe(0);
        const events = result.stdout
          .trim()
          .split(/\r?\n/)
          .map((line) => JSON.parse(line));
        const terminal = events.at(-1);
        expect(terminal).toMatchObject({
          event: "run.completed",
          data: { run_outcome: "clear", coverage_outcome: "complete" },
        });
        for (const model of ["gpt-6-astra", "claude-opus-5"]) {
          expect(observed.get(model)?.reads.size, `${platform}/${model}`).toBe(
            57,
          );
          expect(observed.get(model)?.repair).toBe(true);
        }
        const status = JSON.parse(
          (await run(["status", terminal.run_id, "--json"])).stdout,
        );
        expect(status).toMatchObject({ terminal: true, run_outcome: "clear" });
        expect(status).not.toHaveProperty("context");
        expect((await run(["help", "review"])).stdout).toContain(
          'The string "3"',
        );
        expect((await run(["help", "config-file"])).stdout).toContain(
          "Schema version 7",
        );
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  180000,
);
