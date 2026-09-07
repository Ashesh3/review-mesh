import { createHash } from "node:crypto";
import type { AdapterEvent } from "../adapters/types.js";

export class NativeNoProgressError extends Error {
  readonly code = "no_progress_timeout";
  constructor(timeoutMs: number) {
    super(`The native review made no observable progress for ${timeoutMs} ms.`);
    this.name = "NativeNoProgressError";
  }
}

/** One review attempt owns one progress deadline, regardless of SDK observability. */
export function createNativeProgressWatchdog(options: {
  timeoutMs: number;
  signal: AbortSignal;
  onTimeout(error: NativeNoProgressError): void;
  now?: () => number;
  maximumIdentities?: number;
}) {
  if (
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    options.timeoutMs > 2_147_483_647
  )
    throw new TypeError(
      "Progress timeout must be a positive supported timer duration.",
    );
  const maximumIdentities = options.maximumIdentities ?? 16_384;
  if (!Number.isSafeInteger(maximumIdentities) || maximumIdentities < 1)
    throw new TypeError(
      "Progress identity limit must be a positive safe integer.",
    );
  const now = options.now ?? (() => performance.now());
  let lastProgress = now();
  let activityCount = 0;
  let meaningfulCount = 0;
  let identityOverflow = false;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const identities = new Map<string, number>();
  const age = () => Math.max(0, now() - lastProgress);
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    timer = undefined;
    options.signal.removeEventListener("abort", close);
  };
  const expire = () => {
    if (closed) return;
    close();
    options.onTimeout(new NativeNoProgressError(options.timeoutMs));
  };
  const check = () => {
    timer = undefined;
    if (closed) return;
    const remaining = options.timeoutMs - age();
    if (remaining <= 0) expire();
    else timer = setTimeout(check, remaining);
  };
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(check, options.timeoutMs);
  };
  options.signal.addEventListener("abort", close, { once: true });
  if (options.signal.aborted) close();
  else arm();
  return {
    record(event: AdapterEvent): boolean {
      if (closed) return false;
      if (event.type === "result" || event.type === "failure") {
        close();
        return false;
      }
      activityCount = Math.min(Number.MAX_SAFE_INTEGER, activityCount + 1);
      // A late event must not revive an already elapsed progress deadline.
      if (age() >= options.timeoutMs) {
        expire();
        return false;
      }
      if (!event.identity || Buffer.byteLength(event.identity, "utf8") > 4096)
        return false;
      const bytes = event.byteCount;
      if (bytes !== undefined && (!Number.isSafeInteger(bytes) || bytes <= 0))
        return false;
      const key = createHash("sha256")
        .update(bytes === undefined ? "event:" : "bytes:")
        .update(event.identity)
        .digest("hex");
      const previous = identities.get(key);
      if (previous !== undefined && (bytes === undefined || bytes <= previous))
        return false;
      if (previous === undefined && identities.size >= maximumIdentities) {
        identityOverflow = true;
        return false;
      }
      identities.set(key, bytes ?? 1);
      lastProgress = now();
      meaningfulCount = Math.min(Number.MAX_SAFE_INTEGER, meaningfulCount + 1);
      arm();
      return true;
    },
    snapshot() {
      return {
        lastProgressAgeMs: age(),
        activityCount,
        meaningfulCount,
        identityCount: identities.size,
        identityOverflow,
      };
    },
    close,
  };
}
