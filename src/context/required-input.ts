import type { ReviewRequest, ReviewRequestV3 } from "../protocol/schemas.js";

export interface RequiredInputDiagnostic {
  selector: string;
  code: "missing_required_input" | "invalid_required_input";
}

type ReadinessRequest = ReviewRequest | ReviewRequestV3;

function decodeSegment(value: string): string | undefined {
  if (/~(?:[^01]|$)/u.test(value)) return undefined;
  return value.replaceAll("~1", "/").replaceAll("~0", "~");
}

function pointerValue(
  root: unknown,
  selector: string,
): { found: boolean; value?: unknown } {
  if (!selector.startsWith("/") || selector === "/") return { found: false };
  let current = root;
  for (const encoded of selector.slice(1).split("/")) {
    const segment = decodeSegment(encoded);
    if (
      segment === undefined ||
      current === null ||
      typeof current !== "object" ||
      !Object.hasOwn(current, segment)
    ) {
      return { found: false };
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return { found: true, value: current };
}

function validHttpsUrl(value: unknown): boolean {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" && url.username === "" && url.password === ""
    );
  } catch {
    return false;
  }
}

function validWorkspaceReference(value: unknown): boolean {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  if (value.includes("://")) return validHttpsUrl(value);
  const segments = value.split("/");
  return (
    value.trim() === value &&
    !value.startsWith("/") &&
    !value.startsWith(":") &&
    !/^[A-Za-z]:/u.test(value) &&
    !value.includes(":") &&
    !value.includes("\\") &&
    segments.every(
      (segment) => segment !== "" && segment !== "." && segment !== "..",
    ) &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function validOptionalUrl(value: unknown): boolean {
  return value === undefined || validHttpsUrl(value);
}

function validWorkItems(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        item !== null &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        typeof (item as { id?: unknown }).id === "string" &&
        (item as { id: string }).id.trim().length > 0 &&
        validOptionalUrl((item as { url?: unknown }).url),
    )
  );
}

function validValidation(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        item !== null &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        typeof (item as { name?: unknown }).name === "string" &&
        (item as { name: string }).name.trim().length > 0 &&
        ["passed", "failed", "not_run"].includes(
          String((item as { status?: unknown }).status),
        ) &&
        validOptionalUrl((item as { url?: unknown }).url),
    )
  );
}

function validContractImpact(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const contract = value as {
    status?: unknown;
    summary?: unknown;
    references?: unknown;
  };
  return (
    ["none", "changed", "unknown"].includes(String(contract.status)) &&
    typeof contract.summary === "string" &&
    contract.summary.trim().length > 0 &&
    (contract.references === undefined ||
      (Array.isArray(contract.references) &&
        contract.references.every(validWorkspaceReference)))
  );
}

function valueIsValid(selector: string, value: unknown): boolean {
  if (typeof value === "string") {
    if (value.trim().length === 0) return false;
    return selector.endsWith("/url") ? validHttpsUrl(value) : true;
  }
  if (selector.endsWith("/work_items")) return validWorkItems(value);
  if (selector.endsWith("/validation")) return validValidation(value);
  if (selector.endsWith("/contract_impact")) return validContractImpact(value);
  return value !== null && value !== undefined;
}

export function evaluateRequiredInput(
  request: ReadinessRequest,
  selectors: readonly string[],
): RequiredInputDiagnostic[] {
  const root = {
    request,
    context: request.context,
  };
  const diagnostics: RequiredInputDiagnostic[] = [];
  for (const selector of selectors) {
    const result = pointerValue(root, selector);
    if (!result.found) {
      diagnostics.push({ selector, code: "missing_required_input" });
    } else if (!valueIsValid(selector, result.value)) {
      diagnostics.push({ selector, code: "invalid_required_input" });
    }
  }
  return diagnostics;
}
