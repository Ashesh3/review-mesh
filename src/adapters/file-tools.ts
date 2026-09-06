import type { ChangeCoverageLedger } from "../context/change-coverage.js";

const MAX_LIST_RESULTS = 2_000;
const MAX_SEARCH_RESULTS = 200;
const MAX_SEARCH_LINE_BYTES = 2_000;

export function createReadOnlyFileTools(options: {
  ledger: ChangeCoverageLedger;
  /** Human-readable UTF-8 where exact decoding is possible; other adapters keep base64. */
  readable?: boolean;
}) {
  return {
    coverageStatus() {
      return options.ledger.status();
    },
    async readFile(input: {
      path: string;
      offset?: number;
      byteCount?: number;
    }) {
      const read = await options.ledger.readFile(input);
      if (!read.ok)
        return {
          response: read,
          acknowledgeDelivered(_admittedSerializedResponse: string) {
            return false;
          },
        };
      const response = {
        ok: true as const,
        path: read.path,
        encoding: "base64" as "base64" | "utf8",
        offset: read.offset,
        byte_count: read.byteCount,
        total_byte_count: read.totalByteCount,
        content: Buffer.from(read.bytes).toString("base64"),
        sha256: read.sha256,
        snapshot_digest: read.snapshotDigest,
        eof: read.eof,
      };
      if (options.readable) {
        try {
          const text = new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: true,
          }).decode(read.bytes);
          if (Buffer.from(text, "utf8").equals(Buffer.from(read.bytes))) {
            response.encoding = "utf8";
            response.content = text;
          }
        } catch {
          // Arbitrary model ranges may divide a Unicode code point. Preserve
          // those exact bytes as base64 instead of crediting replacement text.
        }
      }
      const expectedSerializedResponse = JSON.stringify(response);
      let credited = false;
      return {
        response,
        acknowledgeDelivered(admittedSerializedResponse: string): boolean {
          if (admittedSerializedResponse !== expectedSerializedResponse)
            return false;
          if (credited) return true;
          read.acknowledgeDelivered();
          credited = true;
          return true;
        },
      };
    },
    async listFiles(input: { path?: string } = {}) {
      const prefix = normalizedPrefix(input.path);
      if (prefix === undefined) return invalidPath();
      const files = options.ledger
        .snapshotFiles()
        .filter(
          (file) =>
            prefix === "" ||
            file.path === prefix ||
            file.path.startsWith(`${prefix}/`),
        );
      return {
        files: files
          .slice(0, MAX_LIST_RESULTS)
          .map((file) => ({ path: file.path, byte_count: file.byteCount })),
        truncated: files.length > MAX_LIST_RESULTS,
      };
    },
    async searchText(input: {
      query: string;
      path?: string;
      caseSensitive?: boolean;
    }) {
      const prefix = normalizedPrefix(input.path);
      if (prefix === undefined) return invalidPath();
      const needle =
        input.caseSensitive === true
          ? input.query
          : input.query.toLocaleLowerCase("en-US");
      const matches: Array<{ path: string; line: number; text: string }> = [];
      for (const file of options.ledger.snapshotFiles()) {
        if (
          prefix !== "" &&
          file.path !== prefix &&
          !file.path.startsWith(`${prefix}/`)
        )
          continue;
        const text = new TextDecoder("utf-8", { fatal: true }).decode(
          file.bytes,
        );
        for (const [index, line] of text.split(/\r?\n/u).entries()) {
          const haystack =
            input.caseSensitive === true
              ? line
              : line.toLocaleLowerCase("en-US");
          if (!haystack.includes(needle)) continue;
          matches.push({
            path: file.path,
            line: index + 1,
            text: Buffer.from(line)
              .subarray(0, MAX_SEARCH_LINE_BYTES)
              .toString("utf8"),
          });
          if (matches.length >= MAX_SEARCH_RESULTS)
            return { matches, truncated: true };
        }
      }
      return { matches, truncated: false };
    },
  };
}

function invalidPath() {
  return {
    error: "Use a relative workspace path without parent traversal.",
    reason: "invalid_path" as const,
    retryable: true as const,
  };
}

function normalizedPrefix(value: string | undefined): string | undefined {
  if (value === undefined || value === "" || value === ".") return "";
  const normalized = value.replaceAll("\\", "/").normalize("NFC");
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:/u.test(normalized) ||
    /[\u0000-\u001f\u007f]/u.test(normalized) ||
    normalized.split("/").some((part) => part === "..")
  ) {
    return undefined;
  }
  return normalized
    .split("/")
    .filter((part) => part !== "" && part !== ".")
    .join("/");
}
