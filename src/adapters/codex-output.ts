type Schema = Record<string, unknown>;
const record = (value: unknown): value is Schema =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Preserve internal optionality at Codex's required, nullable strict-schema boundary. */
export function codexOutputBoundary(input: Schema): {
  schema: Schema;
  normalize(value: unknown): unknown;
} {
  const original = structuredClone(input);
  const properties = original.properties;
  if (
    record(properties) &&
    Object.hasOwn(properties, "native_scope_attestation")
  ) {
    delete properties.coverage_attestation;
    if (Array.isArray(original.required))
      original.required = original.required.filter(
        (key) => key !== "coverage_attestation",
      );
  }

  function project(source: Schema): Schema {
    const target: Schema = {};
    for (const [key, value] of Object.entries(source)) {
      if (
        key === "$schema" ||
        key.startsWith("x-") ||
        key === "additionalItems"
      )
        continue;
      if (key === "const") {
        target.enum = [value];
        continue;
      }
      if (key === "properties" && record(value)) {
        const required = new Set(
          Array.isArray(source.required) ? source.required : [],
        );
        target.properties = Object.fromEntries(
          Object.entries(value).map(([name, child]) => {
            if (!record(child))
              throw new Error(
                "Codex output properties require object schemas.",
              );
            const projected = project(child);
            return [
              name,
              required.has(name)
                ? projected
                : { anyOf: [projected, { type: "null" }] },
            ];
          }),
        );
        target.required = Object.keys(value);
        target.additionalProperties = false;
      } else if (key === "required" || key === "additionalProperties") {
        if (!record(source.properties)) target[key] = value;
      } else if (key === "items" && Array.isArray(value)) {
        if (value.length !== 0 || source.maxItems !== 0)
          throw new Error("Codex output does not support tuple schemas.");
        target.items = { type: "null" };
      } else if (
        ["anyOf", "oneOf", "allOf", "prefixItems"].includes(key) &&
        Array.isArray(value)
      ) {
        if (key !== "anyOf")
          throw new Error("Unsupported Codex output schema composition.");
        target[key] = value.map((child) => {
          if (!record(child)) throw new Error("Invalid Codex output union.");
          return project(child);
        });
      } else if ((key === "$defs" || key === "definitions") && record(value)) {
        target[key] = Object.fromEntries(
          Object.entries(value).map(([name, child]) => {
            if (!record(child))
              throw new Error("Invalid Codex output definition.");
            return [name, project(child)];
          }),
        );
      } else if (record(value)) target[key] = project(value);
      else target[key] = value;
    }
    if (source.type === "object") {
      target.properties ??= {};
      target.required ??= [];
      target.additionalProperties = false;
    }
    return target;
  }

  function normalize(source: Schema, value: unknown): unknown {
    if (Array.isArray(value) && record(source.items))
      return value.map((item) => normalize(source.items as Schema, item));
    if (record(value) && record(source.properties)) {
      const required = new Set(
        Array.isArray(source.required) ? source.required : [],
      );
      const properties = source.properties;
      return Object.fromEntries(
        Object.entries(value).flatMap(([name, item]) => {
          const child = properties[name];
          if (!record(child)) return [[name, item]];
          if (item === null && !required.has(name)) return [];
          return [[name, normalize(child, item)]];
        }),
      );
    }
    return value;
  }
  return {
    schema: project(original),
    normalize: (value) => normalize(original, value),
  };
}
