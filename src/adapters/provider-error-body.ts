import {
  sanitizePublicText,
  type AdapterFailureDiagnostics,
} from "./errors.js";

const MAX_ERROR_BYTES = 16 * 1024;
const MAX_ERROR_WAIT_MS = 1_000;
const DIAGNOSTIC_WORDS = new Set(
  "a an the and or to of in for from with without request response context token tokens limit limits exceeded exceeds too large maximum length unsupported invalid error code model provider gateway timeout unavailable not is are was be this that".split(
    " ",
  ),
);

/** Read only a small diagnostic response, never the original request or headers. */
export async function providerErrorBody(
  response: Response,
  signal: AbortSignal,
  requestBody: string | undefined,
  apiKey: string,
): Promise<Partial<AdapterFailureDiagnostics>> {
  if (!response.body) return { error_body_unavailable: true };
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  let unavailable = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(new Error("Diagnostic body read cancelled."));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    timer = setTimeout(abort, MAX_ERROR_WAIT_MS);
  });
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), cancelled]);
      if (next.done) break;
      const remaining = MAX_ERROR_BYTES - bytes;
      parts.push(next.value.subarray(0, remaining));
      bytes += Math.min(remaining, next.value.byteLength);
      if (next.value.byteLength >= remaining) {
        truncated = true;
        break;
      }
    }
  } catch {
    unavailable = true;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (abort !== undefined) signal.removeEventListener("abort", abort);
    // Cancellation itself may be backed by an uncooperative remote stream.
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  let text = Buffer.concat(parts).toString("utf8");
  let code: unknown;
  try {
    const json = JSON.parse(text);
    const error =
      typeof json?.error === "object" && json.error !== null
        ? json.error
        : json;
    code = error?.code ?? error?.type;
    text =
      typeof error?.message === "string"
        ? error.message
        : typeof json?.error === "string"
          ? json.error
          : "";
  } catch {
    if (
      /text\/html/i.test(response.headers.get("content-type") ?? "") ||
      /<\s*(?:!doctype|html)\b/i.test(text)
    ) {
      // Gateway HTML often embeds scripts, request URLs or account details.
      text = /<title[^>]*>([^<]{0,256})<\/title>/i.exec(text)?.[1] ?? "";
    }
  }
  const redact = (value: unknown, limit: number): string | undefined => {
    if (typeof value !== "string") return undefined;
    // Only the diagnostic prefix can be published. Bound echo matching work
    // independently from request size and do not scan arbitrary full bodies.
    let safe = value.replaceAll(apiKey, "[redacted]").slice(0, 2048);
    // Remove request fragments before the normal credential redactor. Checking
    // short contiguous windows also catches partial source/prompt echoes.
    if (requestBody) {
      const requestStrings: string[] = [requestBody];
      const exactValues = new Set<string>();
      const collect = (value: unknown, depth = 0): void => {
        if (depth > 8) return;
        if (typeof value === "string") {
          requestStrings.push(value);
          if (value.length > 0 && value.length <= 2048) exactValues.add(value);
          // Tool responses are JSON strings, and host snapshots carry a short
          // prose prefix. Decode both before suppressing source fragments.
          const objectStart = value.indexOf("{");
          if (objectStart >= 0)
            try {
              collect(JSON.parse(value.slice(objectStart)), depth + 1);
            } catch {
              /* Ordinary source text. */
            }
        } else if (Array.isArray(value)) {
          for (const item of value) collect(item, depth + 1);
        } else if (value !== null && typeof value === "object") {
          for (const item of Object.values(value)) collect(item, depth + 1);
          const encoded = value as { encoding?: unknown; content?: unknown };
          if (
            encoded.encoding === "base64" &&
            typeof encoded.content === "string"
          )
            collect(
              Buffer.from(encoded.content, "base64").toString("utf8"),
              depth + 1,
            );
        }
      };
      try {
        const body = JSON.parse(requestBody);
        for (const message of body.messages ?? []) collect(message.content);
      } catch {
        /* Request encoding is already validated by the caller. */
      }
      for (const exact of [...exactValues].sort(
        (left, right) => right.length - left.length,
      ))
        if (safe.includes(exact))
          safe = safe.replaceAll(exact, "[request content redacted]");
      const spans: Array<[number, number]> = [];
      for (let index = 0; index <= safe.length - 16; index++) {
        const fragment = safe.slice(index, index + 16);
        if (
          fragment.trim().length >= 8 &&
          requestStrings.some((request) => request.includes(fragment))
        )
          spans.push([index, index + 16]);
      }
      // Short identifiers can themselves be sensitive even when only a small
      // part of a larger source message is echoed by the provider.
      for (const match of safe.matchAll(/[\p{L}\p{N}_$.-]{3,}/gu)) {
        const token = match[0];
        if (
          !DIAGNOSTIC_WORDS.has(token.toLowerCase()) &&
          requestStrings.some((request) => request.includes(token))
        )
          spans.push([match.index!, match.index! + token.length]);
      }
      spans.sort((left, right) => left[0] - right[0]);
      for (let index = spans.length - 1; index >= 0;) {
        let [start, end] = spans[index--]!;
        while (index >= 0 && spans[index]![1] >= start)
          start = spans[index--]![0];
        safe =
          safe.slice(0, start) + "[request content redacted]" + safe.slice(end);
      }
    }
    return sanitizePublicText(safe, limit);
  };
  const message = redact(text, 512);
  const errorCode = redact(code, 128);
  return {
    ...(message === undefined ? {} : { provider_error_message: message }),
    ...(errorCode === undefined ? {} : { provider_error_code: errorCode }),
    error_body_truncated: truncated,
    ...(unavailable ? { error_body_unavailable: true } : {}),
  };
}
