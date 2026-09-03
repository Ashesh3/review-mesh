import { spawn } from "node:child_process";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { networkInterfaces } from "node:os";
import {
  dashboardFingerprint,
  readDashboardReviewer,
  readDashboardRun,
  readDashboardSnapshot,
  type DashboardServerInfo,
} from "./dashboard-data.js";
import { dashboardHtml } from "./dashboard-ui.js";
import type { AppPaths } from "../config/paths.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const API_PREFIX = "/api/";

export interface DashboardServerOptions {
  host: string;
  port: number;
  appPaths: AppPaths;
  signal: AbortSignal;
  pollIntervalMs?: number;
}

export interface DashboardServerHandle {
  host: string;
  port: number;
  url: string;
  startedAt: string;
  closed: Promise<void>;
  close(): Promise<void>;
}

export function isLoopbackHost(host: string): boolean {
  if (LOOPBACK_HOSTS.has(host.toLowerCase())) return true;
  return Object.values(networkInterfaces())
    .flat()
    .some(
      (entry) =>
        entry !== undefined &&
        entry.internal &&
        entry.address.toLowerCase() === host.toLowerCase(),
    );
}

function hostForUrl(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

function expectedOrigins(info: DashboardServerInfo): Set<string> {
  const hosts = new Set([info.host, "localhost"]);
  if (info.host === "localhost") {
    hosts.add("127.0.0.1");
    hosts.add("::1");
  }
  return new Set(
    [...hosts].map((host) => `http://${hostForUrl(host)}:${info.port}`),
  );
}

function requestOrigin(request: IncomingMessage): string | undefined {
  const origin = request.headers.origin;
  return Array.isArray(origin) ? origin[0] : origin;
}

function requestHost(request: IncomingMessage): string | undefined {
  const host = request.headers.host;
  return Array.isArray(host) ? host[0] : host;
}

function requestIsSameOrigin(
  request: IncomingMessage,
  info: DashboardServerInfo,
): boolean {
  const allowed = expectedOrigins(info);
  const host = requestHost(request);
  if (host === undefined || !allowed.has(`http://${host}`)) return false;
  const origin = requestOrigin(request);
  return origin === undefined || allowed.has(origin);
}

function commonHeaders(contentType: string): Record<string, string> {
  return {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Content-Security-Policy":
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  };
}

function send(
  request: IncomingMessage,
  response: ServerResponse,
  statusCode: number,
  body: string,
  contentType: string,
  additional: Record<string, string> = {},
): void {
  const encoded = Buffer.from(body, "utf8");
  response.writeHead(statusCode, {
    ...commonHeaders(contentType),
    "Content-Length": String(encoded.byteLength),
    ...additional,
  });
  if (request.method === "HEAD") response.end();
  else response.end(encoded);
}

function sendJson(
  request: IncomingMessage,
  response: ServerResponse,
  statusCode: number,
  value: unknown,
  additional: Record<string, string> = {},
): void {
  send(
    request,
    response,
    statusCode,
    `${JSON.stringify(value)}\n`,
    "application/json; charset=utf-8",
    additional,
  );
}

function decodedSegments(pathname: string): string[] | undefined {
  try {
    return pathname
      .split("/")
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));
  } catch {
    return undefined;
  }
}

function openCommand(url: string): { command: string; args: string[] } {
  if (process.platform === "win32") {
    return {
      command: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", "start", "", url],
    };
  }
  if (process.platform === "darwin") return { command: "open", args: [url] };
  return { command: "xdg-open", args: [url] };
}

export function openDashboardBrowser(url: string): void {
  const command = openCommand(url);
  const child = spawn(command.command, command.args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

export async function startDashboardServer(
  options: DashboardServerOptions,
): Promise<DashboardServerHandle> {
  if (!isLoopbackHost(options.host)) {
    throw new Error("The dashboard may bind only to a loopback address.");
  }
  if (
    !Number.isSafeInteger(options.port) ||
    options.port < 0 ||
    options.port > 65535
  ) {
    throw new Error("Dashboard port must be an integer from 0 through 65535.");
  }
  const startedAt = new Date().toISOString();
  const clients = new Set<ServerResponse>();
  let info: DashboardServerInfo = {
    host: options.host,
    port: options.port,
    startedAt,
  };
  let fingerprint = await dashboardFingerprint(options.appPaths);
  let poll: ReturnType<typeof setInterval> | undefined;
  let closePromise: Promise<void> | undefined;

  const server = createServer((request, response) => {
    void (async () => {
      if (!requestIsSameOrigin(request, info)) {
        sendJson(
          request,
          response,
          421,
          {
            error: "misdirected_request",
            message:
              "The dashboard accepts only same-origin loopback requests.",
          },
          { Connection: "close" },
        );
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        sendJson(
          request,
          response,
          405,
          {
            error: "method_not_allowed",
            message: "The dashboard is read only.",
          },
          { Allow: "GET, HEAD" },
        );
        return;
      }
      const url = new URL(
        request.url ?? "/",
        `http://${requestHost(request)!}`,
      );
      if (url.pathname === "/" || url.pathname === "/index.html") {
        send(request, response, 200, dashboardHtml, "text/html; charset=utf-8");
        return;
      }
      if (url.pathname === "/api/snapshot") {
        sendJson(
          request,
          response,
          200,
          await readDashboardSnapshot({
            appPaths: options.appPaths,
            server: info,
          }),
        );
        return;
      }
      if (url.pathname === "/api/stream") {
        if (request.method === "HEAD") {
          send(request, response, 200, "", "text/event-stream; charset=utf-8");
          return;
        }
        response.writeHead(200, {
          ...commonHeaders("text/event-stream; charset=utf-8"),
          Connection: "keep-alive",
        });
        response.write(
          `event: ready\ndata: ${JSON.stringify({ generated_at: new Date().toISOString() })}\n\n`,
        );
        clients.add(response);
        const remove = () => clients.delete(response);
        request.once("close", remove);
        response.once("close", remove);
        return;
      }
      if (url.pathname.startsWith(API_PREFIX)) {
        const segments = decodedSegments(url.pathname);
        if (
          segments?.length === 3 &&
          segments[0] === "api" &&
          segments[1] === "runs"
        ) {
          try {
            sendJson(
              request,
              response,
              200,
              await readDashboardRun({
                appPaths: options.appPaths,
                runId: segments[2]!,
              }),
            );
          } catch (error) {
            sendJson(request, response, 404, {
              error: "run_not_found",
              message:
                error instanceof Error ? error.message : "Run not found.",
            });
          }
          return;
        }
        if (
          segments?.length === 5 &&
          segments[0] === "api" &&
          segments[1] === "runs" &&
          segments[3] === "reviewers"
        ) {
          try {
            sendJson(
              request,
              response,
              200,
              await readDashboardReviewer({
                appPaths: options.appPaths,
                runId: segments[2]!,
                reviewerId: segments[4]!,
              }),
            );
          } catch (error) {
            sendJson(request, response, 404, {
              error: "reviewer_not_found",
              message:
                error instanceof Error ? error.message : "Reviewer not found.",
            });
          }
          return;
        }
      }
      sendJson(request, response, 404, {
        error: "not_found",
        message: "The requested dashboard resource does not exist.",
      });
    })().catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      sendJson(request, response, 500, {
        error: "dashboard_failed",
        message: "The dashboard could not read its local data.",
      });
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error) => {
      server.removeListener("listening", onListening);
      rejectListen(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port, options.host);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("The dashboard server did not expose a TCP address.");
  }
  info = { ...info, port: address.port };
  const close = async (): Promise<void> => {
    closePromise ??= new Promise<void>((resolveClose) => {
      if (poll !== undefined) clearInterval(poll);
      for (const client of clients) client.end();
      clients.clear();
      if (!server.listening) resolveClose();
      else server.close(() => resolveClose());
    });
    return closePromise;
  };
  const onAbort = () => void close();
  options.signal.addEventListener("abort", onAbort, { once: true });
  const closed = new Promise<void>((resolveClosed) => {
    server.once("close", () => {
      options.signal.removeEventListener("abort", onAbort);
      resolveClosed();
    });
  });
  poll = setInterval(() => {
    void dashboardFingerprint(options.appPaths).then((next) => {
      if (next === fingerprint) return;
      fingerprint = next;
      const payload = `event: invalidated\ndata: ${JSON.stringify({ generated_at: new Date().toISOString() })}\n\n`;
      for (const client of clients) client.write(payload);
    });
  }, options.pollIntervalMs ?? 1_000);
  poll.unref?.();
  if (options.signal.aborted) await close();
  return {
    host: info.host,
    port: info.port,
    url: `http://${hostForUrl(info.host)}:${info.port}/`,
    startedAt,
    closed,
    close,
  };
}
