import type { CopilotSession, MessageOptions } from "@github/copilot-sdk";

/**
 * Own the completion wait so cancellation releases its timer and subscription.
 * The SDK's sendAndWait timer survives session disconnect until its full timeout.
 */
export async function sendCopilotReviewAndWait(
  session: Pick<CopilotSession, "send" | "on">,
  message: MessageOptions,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let sent = false;
    let idle = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      unsubscribe?.();
      complete();
    };
    const abort = () =>
      finish(() => reject(signal.reason ?? new Error("Cancelled")));
    unsubscribe = session.on((event) => {
      if (event.type === "session.idle") {
        idle = true;
        if (sent) finish(resolve);
      } else if (event.type === "session.error") {
        finish(() => reject(new Error(event.data.message)));
      }
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    timer = setTimeout(
      () =>
        finish(() =>
          reject(
            new Error(`Timeout after ${timeoutMs}ms waiting for session.idle`),
          ),
        ),
      timeoutMs,
    );
    try {
      void session.send(message).then(
        () => {
          sent = true;
          if (idle) finish(resolve);
        },
        (error: unknown) => finish(() => reject(error)),
      );
    } catch (error) {
      finish(() => reject(error));
    }
  });
}
