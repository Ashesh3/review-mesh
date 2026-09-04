import type { FileHandle } from "node:fs/promises";
import { MAX_REVIEWER_RESULT_BYTES } from "../results/sanitize.js";

export const MAX_RUN_RECORD_LINE_BYTES =
  MAX_REVIEWER_RESULT_BYTES + 2 * 1024 * 1024;
export const MAX_RUN_RECORDS = 16_384;
const READ_CHUNK_BYTES = 64 * 1024;

export async function* readRunRecordLines(
  handle: FileHandle,
): AsyncGenerator<{ line: number; encoded: string; terminated: boolean }> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let carry = "";
  let line = 0;
  let position = 0;
  for (;;) {
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
    if (bytesRead === 0) break;
    position += bytesRead;
    carry += decoder.decode(chunk.subarray(0, bytesRead), { stream: true });
    for (;;) {
      const newline = carry.indexOf("\n");
      if (newline < 0) break;
      const encoded = carry.slice(0, newline).replace(/\r$/u, "");
      carry = carry.slice(newline + 1);
      line += 1;
      if (line > MAX_RUN_RECORDS)
        throw new Error("The persisted run record contains too many records.");
      if (Buffer.byteLength(encoded, "utf8") > MAX_RUN_RECORD_LINE_BYTES)
        throw new Error(
          "The persisted run record contains an oversized JSONL record.",
        );
      yield { line, encoded, terminated: true };
    }
    if (Buffer.byteLength(carry, "utf8") > MAX_RUN_RECORD_LINE_BYTES)
      throw new Error(
        "The persisted run record contains an oversized JSONL record.",
      );
  }
  carry += decoder.decode();
  if (carry.length > 0) {
    line += 1;
    if (line > MAX_RUN_RECORDS)
      throw new Error("The persisted run record contains too many records.");
    if (Buffer.byteLength(carry, "utf8") > MAX_RUN_RECORD_LINE_BYTES)
      throw new Error(
        "The persisted run record contains an oversized JSONL record.",
      );
    yield {
      line,
      encoded: carry.replace(/\r$/u, ""),
      terminated: false,
    };
  }
}
