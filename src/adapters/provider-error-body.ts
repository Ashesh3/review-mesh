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

/** Extract only provider-owned semantics; never reuse arbitrary request text. */
function contextLimitDiagnostics(
  code: unknown,
  message: string,
  fields: Record<string, unknown> | undefined,
): Partial<AdapterFailureDiagnostics> {
  const knownCode =
    typeof code === "string" &&
    /^(?:context_length_exceeded|model_max_prompt_tokens_exceeded|prompt_too_long|input_too_long|context_window_exceeded)$/iu.test(
      code,
    );
  const knownText =
    /(?:request|prompt|input)[\s\S]{0,80}(?:exceeds?|exceeded|too (?:long|large))[\s\S]{0,80}(?:context|token)|(?:context (?:window|length|limit))[\s\S]{0,80}(?:exceeds?|exceeded)|\d[\d,]*\s+tokens?\s*>\s*\d/iu.test(
      message,
    );
  if (!knownCode && !knownText) return {};
  const number = (value: string | undefined) => {
    if (value === undefined) return undefined;
    const result = Number(value.replaceAll(",", ""));
    return Number.isSafeInteger(result) && result >= 0 ? result : undefined;
  };
  let input: number | undefined;
  let limit: number | undefined;
  const comparison =
    /([\d,]+)\s+tokens?\s*>\s*([\d,]+)\s*(?:maximum|max|limit)/iu.exec(
      message,
    ) ??
    /(?:prompt|input)\s+token\s+(?:count\s+)?(?:of\s+)?([\d,]+)\s+exceeds?\s+(?:the\s+)?(?:limit|maximum)(?:\s+of)?\s+([\d,]+)/iu.exec(
      message,
    );
  if (comparison) {
    input = number(comparison[1]);
    limit = number(comparison[2]);
  } else {
    limit = number(
      /maximum\s+context\s+length\s+(?:is\s+)?([\d,]+)\s+tokens?/iu.exec(
        message,
      )?.[1],
    );
    input = number(
      /(?:requested|resulted\s+in)\s+([\d,]+)\s+tokens?/iu.exec(message)?.[1],
    );
  }
  if (limit === 0) limit = undefined;
  const integer = (value: unknown) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? value
      : undefined;
  input ??= integer(fields?.input_tokens) ?? integer(fields?.prompt_tokens);
  limit ??=
    integer(fields?.limit_tokens) ??
    integer(fields?.context_window_tokens) ??
    integer(fields?.max_context_tokens);
  if (limit === 0) limit = undefined;
  return {
    failure_code: "context_length_exceeded",
    context_error_class: "context_too_large",
    ...(input === undefined ? {} : { input_tokens: input }),
    ...(limit === undefined ? {} : { limit_tokens: limit }),
    provider_error_message:
      input !== undefined && limit !== undefined
        ? `Model context limit exceeded: input ${input} tokens; limit ${limit} tokens.`
        : "Model context limit exceeded.",
  };
}

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
  let fields: Record<string, unknown> | undefined;
  try {
    const json = JSON.parse(text);
    const error =
      typeof json?.error === "object" && json.error !== null
        ? json.error
        : json;
    code = error?.code ?? error?.type;
    fields = typeof error === "object" && error !== null ? error : undefined;
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
  const contextDiagnostic = contextLimitDiagnostics(code, text, fields);
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
      const spans: Array<[number, number]> = [];
      // Find every match in the original text and replace once. Rescanning the
      // replacement itself turns ordinary errors into nested redaction noise.
      for (const exact of exactValues) {
        let index = safe.indexOf(exact);
        while (index >= 0) {
          spans.push([index, index + exact.length]);
          index = safe.indexOf(exact, index + exact.length);
        }
      }
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
    ...contextDiagnostic,
    error_body_truncated: truncated,
    ...(unavailable ? { error_body_unavailable: true } : {}),
  };
}
