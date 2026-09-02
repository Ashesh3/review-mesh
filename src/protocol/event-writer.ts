import { publicEventSchema, type PublicEvent } from "./schemas.js";

export interface EventSink {
  write(
    chunk: string | Uint8Array,
    callback: (error?: Error | null) => void,
  ): boolean;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "drain", listener: () => void): unknown;
  removeListener(event: "error", listener: (error: Error) => void): unknown;
  removeListener(event: "drain", listener: () => void): unknown;
}

export type EventDraft = PublicEvent extends infer Event
  ? Event extends PublicEvent
    ? Omit<
        Event,
        "schema_version" | "run_id" | "request_id" | "seq" | "timestamp"
      >
    : never
  : never;

export interface EventWriter {
  emit(draft: EventDraft): Promise<PublicEvent>;
  close(): Promise<void>;
}

export interface CreateEventWriterOptions {
  output: EventSink;
  runId: string;
  requestId?: string;
  now?: () => Date;
  onEvent?: (event: PublicEvent) => Promise<void>;
  onMirrorClose?: () => Promise<void>;
  onWarning?: (error: Error) => void;
  mirrorFlushTimeoutMs?: number;
  mirrorMaxPendingEvents?: number;
  mirrorMaxPendingBytes?: number;
}

interface PendingMirrorEvent {
  event: PublicEvent;
  bytes: number;
}

export function createEventWriter({
  output,
  runId,
  requestId,
  now = () => new Date(),
  onEvent,
  onMirrorClose,
  onWarning,
  mirrorFlushTimeoutMs = 1_000,
  mirrorMaxPendingEvents = 256,
  mirrorMaxPendingBytes = 1024 * 1024,
}: CreateEventWriterOptions): EventWriter {
  if (
    !Number.isSafeInteger(mirrorMaxPendingEvents) ||
    mirrorMaxPendingEvents < 1
  ) {
    throw new Error("mirrorMaxPendingEvents must be a positive safe integer");
  }
  if (
    !Number.isSafeInteger(mirrorMaxPendingBytes) ||
    mirrorMaxPendingBytes < 1
  ) {
    throw new Error("mirrorMaxPendingBytes must be a positive safe integer");
  }
  let closed = false;
  let sequence = 0;
  let tail = Promise.resolve();
  let streamError: Error | undefined;
  let mirrorEnabled = onEvent !== undefined;
  let mirrorQueue: PendingMirrorEvent[] = [];
  let mirrorQueuedBytes = 0;
  let mirrorInFlightBytes = 0;
  let mirrorPump: Promise<void> | undefined;
  let mirrorWarningIssued = false;
  let mirrorClose: Promise<void> | undefined;

  const rememberError = (error: Error) => {
    streamError ??= error;
  };
  const rememberStreamError = (error: Error) => {
    rememberError(error);
    output.once("error", rememberStreamError);
  };
  output.once("error", rememberStreamError);

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const disableMirror = (error: unknown) => {
    mirrorEnabled = false;
    mirrorQueue = [];
    mirrorQueuedBytes = 0;
    if (mirrorWarningIssued) return;
    mirrorWarningIssued = true;
    try {
      onWarning?.(error instanceof Error ? error : new Error(String(error)));
    } catch {
      // A warning sink must not change the foreground outcome.
    }
  };

  const startMirrorPump = () => {
    if (mirrorPump !== undefined || onEvent === undefined) return;
    const pump = (async () => {
      while (mirrorEnabled) {
        const pending = mirrorQueue.shift();
        if (pending === undefined) return;
        mirrorQueuedBytes -= pending.bytes;
        mirrorInFlightBytes = pending.bytes;
        try {
          await onEvent(pending.event);
        } catch (error) {
          disableMirror(error);
          return;
        } finally {
          mirrorInFlightBytes = 0;
        }
      }
    })();
    mirrorPump = pump.finally(() => {
      mirrorPump = undefined;
      if (mirrorEnabled && mirrorQueue.length > 0) startMirrorPump();
    });
  };

  const enqueueMirror = (event: PublicEvent, bytes: number) => {
    if (!mirrorEnabled || onEvent === undefined) return;
    const pendingEvents =
      mirrorQueue.length + (mirrorInFlightBytes > 0 ? 1 : 0);
    const pendingBytes = mirrorQueuedBytes + mirrorInFlightBytes;
    if (
      pendingEvents >= mirrorMaxPendingEvents ||
      bytes > mirrorMaxPendingBytes - pendingBytes
    ) {
      disableMirror(
        new Error("Run record persistence queue capacity exceeded."),
      );
      return;
    }
    mirrorQueue.push({ event, bytes });
    mirrorQueuedBytes += bytes;
    startMirrorPump();
  };

  const scheduleMirrorClose = (): Promise<void> => {
    mirrorClose ??= (async () => {
      const pump = mirrorPump;
      if (pump !== undefined) {
        await pump;
      }
      if (onMirrorClose !== undefined) await onMirrorClose();
    })().catch((error: unknown) => {
      disableMirror(error);
    });
    return mirrorClose;
  };

  const flushMirror = async (): Promise<void> => {
    const flush = scheduleMirrorClose();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = globalThis.setTimeout(
        () => resolve("timeout"),
        mirrorFlushTimeoutMs,
      );
    });
    const completed = flush.then(() => "complete" as const);
    const outcome = await Promise.race([completed, timeout]);
    if (timer !== undefined) globalThis.clearTimeout(timer);
    if (outcome === "timeout")
      disableMirror(new Error("Run record persistence timed out."));
  };

  const writeLine = (line: string): Promise<void> =>
    new Promise((resolve, reject) => {
      let callbackSettled = false;
      let drainSettled = false;
      let writeReturned = false;
      let settled = false;

      const cleanup = () => {
        output.removeListener("error", onError);
        output.removeListener("drain", onDrain);
      };
      const rejectOnce = (error: Error) => {
        rememberError(error);
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const resolveIfSettled = () => {
        if (settled || !writeReturned || !callbackSettled || !drainSettled) {
          return;
        }
        if (streamError !== undefined) {
          rejectOnce(streamError);
          return;
        }
        settled = true;
        cleanup();
        resolve();
      };
      const onError = (error: Error) => rejectOnce(error);
      const onDrain = () => {
        drainSettled = true;
        resolveIfSettled();
      };
      const onWrite = (error?: Error | null) => {
        if (error !== undefined && error !== null) {
          rejectOnce(error);
          return;
        }
        callbackSettled = true;
        resolveIfSettled();
      };

      output.once("error", onError);
      try {
        const accepted = output.write(line, onWrite);
        writeReturned = true;
        drainSettled = accepted;
        if (!accepted && !settled) output.once("drain", onDrain);
        resolveIfSettled();
      } catch (error) {
        rejectOnce(error instanceof Error ? error : new Error(String(error)));
      }
    });

  return {
    emit(draft) {
      if (closed) {
        return Promise.reject(new Error("Event writer is closed"));
      }
      if (streamError !== undefined) {
        return Promise.reject(streamError);
      }

      return enqueue(async () => {
        if (streamError !== undefined) {
          throw streamError;
        }

        const event = publicEventSchema.parse({
          ...draft,
          schema_version: "3",
          run_id: runId,
          ...(requestId === undefined ? {} : { request_id: requestId }),
          seq: ++sequence,
          timestamp: now().toISOString(),
        });
        const line = JSON.stringify(event) + "\n";

        await writeLine(line);

        enqueueMirror(event, Buffer.byteLength(line, "utf8"));

        return event;
      });
    },

    close() {
      closed = true;
      return tail.then(async () => {
        try {
          await flushMirror();
        } finally {
          if (streamError !== undefined) throw streamError;
        }
      });
    },
  };
}
