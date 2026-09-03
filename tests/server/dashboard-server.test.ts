import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isLoopbackHost,
  startDashboardServer,
} from "../../src/server/dashboard-server.js";

const roots: string[] = [];

async function rawStatus(input: {
  host: string;
  port: number;
  path: string;
  headers: Record<string, string>;
}): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: input.host,
        port: input.port,
        path: input.path,
        headers: input.headers,
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode));
      },
    );
    request.once("error", reject);
    request.end();
  });
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("dashboard server", () => {
  it("serves embedded UI and read-only same-origin APIs", async () => {
    const root = await mkdtemp(join(tmpdir(), "review-mesh-dashboard-server-"));
    roots.push(root);
    const appPaths = {
      configFile: join(root, "config", "config.toml"),
      reviewersDirectory: join(root, "config", "reviewers"),
      runsDirectory: join(root, "data", "runs"),
    };
    await mkdir(appPaths.runsDirectory, { recursive: true });
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(
      appPaths.configFile,
      `schema_version = "5"
[execution]
max_concurrency = 1
heartbeat_interval_ms = 15000
shutdown_grace_period_ms = 5000
[diagnostics]
persist_runs = true
max_runs = 10
[adapters.command]
type = "command"
command = "node"
protocol = "review-mesh-command-v1"
[agents.test]
adapter = "command"
purpose = "Test"
instructions = "Test"
isolation = "prefer_enforced"
timeout_ms = 5000
model = "test"
[defaults]
agents = ["test"]
`,
    );
    const controller = new AbortController();
    const server = await startDashboardServer({
      host: "127.0.0.1",
      port: 0,
      appPaths,
      signal: controller.signal,
      pollIntervalMs: 25,
    });
    const page = await fetch(server.url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Review Mesh");
    expect(page.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    const snapshot = await fetch(`${server.url}api/snapshot`);
    expect(snapshot.status).toBe(200);
    expect(await snapshot.json()).toMatchObject({
      server: { read_only: true, host: "127.0.0.1" },
    });
    const head = await fetch(server.url, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const mutation = await fetch(`${server.url}api/snapshot`, {
      method: "POST",
    });
    expect(mutation.status).toBe(405);
    expect(mutation.headers.get("allow")).toBe("GET, HEAD");
    expect(
      await rawStatus({
        host: server.host,
        port: server.port,
        path: "/api/snapshot",
        headers: { Host: "evil.example" },
      }),
    ).toBe(421);
    const crossOrigin = await fetch(`${server.url}api/snapshot`, {
      headers: { Origin: "https://evil.example" },
    });
    expect(crossOrigin.status).toBe(421);
    controller.abort();
    await server.closed;
  });

  it("rejects non-loopback binding", async () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    await expect(
      startDashboardServer({
        host: "0.0.0.0",
        port: 0,
        appPaths: {
          configFile: "missing",
          reviewersDirectory: "missing",
          runsDirectory: "missing",
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/loopback/u);
  });
});
