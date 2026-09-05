import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { createSafeArtifactParent, safeArtifactParent } from "./run-index.js";

const safeId = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
function paths(root: string, runId: string) {
  if (!safeId.test(runId) || runId === "." || runId === "..")
    throw new Error("Invalid run ID.");
  return {
    lease: join(root, `${runId}.control.json`),
    request: join(root, `${runId}.stop.json`),
  };
}
async function readOwned(path: string) {
  await safeArtifactParent(path);
  const handle = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = await handle.stat({ bigint: true });
    const named = await lstat(path, { bigint: true });
    if (
      !stat.isFile() ||
      named.isSymbolicLink() ||
      stat.ino !== named.ino ||
      stat.dev !== named.dev ||
      stat.size > 4096n
    )
      throw new Error("Unsafe run control file.");
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (BigInt(bytesRead) !== stat.size)
      throw new Error("Run control file changed during read.");
    await safeArtifactParent(path);
    return {
      data: JSON.parse(
        buffer.subarray(0, bytesRead).toString("utf8"),
      ) as Record<string, unknown>,
      stat,
    };
  } finally {
    await handle.close();
  }
}

/** Local cooperative control. It never signals a PID or exposes a network API. */
export async function createRunControl(
  root: string,
  runId: string,
  controller: AbortController,
) {
  const files = paths(root, runId);
  await createSafeArtifactParent(files.lease);
  const nonce = randomUUID();
  const handle = await open(files.lease, "wx", 0o600);
  await handle.writeFile(
    JSON.stringify({ schema_version: "1", run_id: runId, nonce }),
  );
  let pending: Promise<void> | undefined;
  const check = async () => {
    const now = new Date();
    await handle.utimes(now, now);
    const request = await readOwned(files.request).catch(() => undefined);
    if (
      request?.data.nonce === nonce &&
      (request.data.action === "cancel" || request.data.action === "pause")
    ) {
      controller.abort(
        new Error(
          `Run ${request.data.action} requested; resume from the finalized checkpoint.`,
        ),
      );
    }
  };
  const timer = setInterval(() => {
    if (!pending)
      pending = check()
        .catch(() => undefined)
        .finally(() => {
          pending = undefined;
        });
  }, 100);
  timer.unref();
  let closed = false;
  return {
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      await pending;
      // Wipe through the owned handle; never unlink a pathname that another
      // process might have replaced. Empty private markers are harmless.
      await handle.truncate(0);
      await handle.close();
    },
  };
}

export async function requestRunStop(
  root: string,
  runId: string,
  action: "cancel" | "pause",
) {
  const files = paths(root, runId);
  const lease = await readOwned(files.lease).catch(() => undefined);
  if (
    !lease ||
    lease.data.run_id !== runId ||
    typeof lease.data.nonce !== "string" ||
    Date.now() - Number(lease.stat.mtimeMs) > 5000
  )
    throw new Error("The run is not active or its control lease is stale.");
  const existing = await readOwned(files.request).catch(() => undefined);
  if (!existing || existing.data.nonce !== lease.data.nonce) {
    const handle = await open(files.request, "wx", 0o600);
    try {
      await handle.writeFile(
        JSON.stringify({ nonce: lease.data.nonce, action }),
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  return {
    schema_version: "1",
    kind: "review-mesh.run-control",
    run_id: runId,
    action: existing?.data.action ?? action,
    status: "requested",
    resume_command: `review-mesh resume ${runId}`,
  };
}
