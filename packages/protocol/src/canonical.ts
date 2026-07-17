/** Values accepted by Zine's deterministic JSON boundary. */
export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function encodeCanonical(value: unknown, path: string): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new TypeError(`${path} contains a non-finite number`);
    }
    if (typeof value === "string" && hasUnpairedSurrogate(value)) {
      throw new TypeError(`${path} contains an unpaired Unicode surrogate`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => encodeCanonical(item, `${path}[${index}]`)).join(",")}]`;
  }
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${path} is not an I-JSON value`);
  }
  const entries = Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return `{${entries.map(([key, item]) => {
    if (hasUnpairedSurrogate(key)) {
      throw new TypeError(`${path} contains an object key with an unpaired Unicode surrogate`);
    }
    return `${JSON.stringify(key)}:${encodeCanonical(item, `${path}.${key}`)}`;
  }).join(",")}}`;
}

/**
 * Deterministically encode one I-JSON value with recursively sorted object
 * keys. This kernel helper is not applied to existing event content in this
 * behavior-preserving extraction; callers opt in only at reviewed boundaries.
 */
export function canonicalJson(value: CanonicalJsonValue): string {
  return encodeCanonical(value, "$root");
}

export function canonicalBytes(value: CanonicalJsonValue): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

export function utf8Bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}
