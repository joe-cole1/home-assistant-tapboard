import { isObviousSecretKey } from "./errors.ts";

/** Values accepted by the small, deterministic JSON encoder used by durable boundaries. */
export type CanonicalJsonPrimitive = string | number | boolean | null;
export type CanonicalJsonValue =
  | CanonicalJsonPrimitive
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

export interface CanonicalJsonOptions {
  /** Maximum container nesting below the root (default: 16). */
  readonly maxDepth?: number;
  /** Maximum number of own string keys in each object (default: 64). */
  readonly maxKeys?: number;
  /** Alias for maxKeys retained to make call sites self-documenting. */
  readonly maxObjectKeys?: number;
  /** Maximum number of elements in each array (default: 64). */
  readonly maxArrayItems?: number;
  /** Maximum UTF-8 encoded size of the resulting JSON (default: 16 KiB). */
  readonly maxBytes?: number;
}

const DEFAULT_MAX_DEPTH = 16;
const DEFAULT_MAX_KEYS = 64;
const DEFAULT_MAX_ARRAY_ITEMS = 64;
const DEFAULT_MAX_BYTES = 16_384;

interface NormalizedOptions {
  readonly maxDepth: number;
  readonly maxKeys: number;
  readonly maxArrayItems: number;
  readonly maxBytes: number;
}

function invalid(reason: string): TypeError {
  return new TypeError(`Invalid canonical JSON value: ${reason}`);
}

function boundedOption(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw invalid(`${name} must be a non-negative safe integer`);
  }
  return result;
}

function normalizeOptions(options: CanonicalJsonOptions): NormalizedOptions {
  const configuredKeys = options.maxKeys ?? options.maxObjectKeys;
  return {
    maxDepth: boundedOption(options.maxDepth, DEFAULT_MAX_DEPTH, "maxDepth"),
    maxKeys: boundedOption(configuredKeys, DEFAULT_MAX_KEYS, "maxKeys"),
    maxArrayItems: boundedOption(options.maxArrayItems, DEFAULT_MAX_ARRAY_ITEMS, "maxArrayItems"),
    maxBytes: boundedOption(options.maxBytes, DEFAULT_MAX_BYTES, "maxBytes"),
  };
}

function quoteString(value: string): string {
  const quoted = JSON.stringify(value);
  if (quoted === undefined) {
    throw invalid("unsupported string");
  }
  return quoted;
}

function encode(
  value: unknown,
  options: NormalizedOptions,
  depth: number,
  seen: Set<object>,
): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
      return quoteString(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw invalid("numbers must be finite");
      return JSON.stringify(value);
    case "undefined":
      throw invalid("undefined is not supported");
    case "bigint":
      throw invalid("bigint is not supported");
    case "symbol":
      throw invalid("symbol is not supported");
    case "function":
      throw invalid("functions are not supported");
    case "object":
      break;
    default:
      throw invalid("unsupported value");
  }

  if (seen.has(value)) throw invalid("cyclic values are not supported");
  if (depth > options.maxDepth) throw invalid("maximum depth exceeded");
  seen.add(value);

  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw invalid("arrays must have the standard array prototype");
      }
      if (value.length > options.maxArrayItems) {
        throw invalid("maximum array item count exceeded");
      }
      if (Object.getOwnPropertySymbols(value).length > 0) {
        throw invalid("symbol keys are not supported");
      }
      const ownNames = Object.getOwnPropertyNames(value);
      if (
        ownNames.length !== value.length + 1 ||
        !ownNames.includes("length") ||
        ownNames.some((key) => key !== "length" && !/^\d+$/.test(key))
      ) {
        throw invalid("arrays must not have holes or extra properties");
      }
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw invalid("arrays must not have holes");
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !("value" in descriptor)) {
          throw invalid("accessor properties are not supported");
        }
        items.push(encode(descriptor.value, options, depth + 1, seen));
      }
      return `[${items.join(",")}]`;
    }

    const prototype: unknown = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw invalid("objects must have a plain prototype");
    }
    const symbols = Object.getOwnPropertySymbols(value);
    if (symbols.length > 0) throw invalid("symbol keys are not supported");

    const keys = Object.keys(value).sort();
    if (Object.getOwnPropertyNames(value).length !== keys.length) {
      throw invalid("non-enumerable properties are not supported");
    }
    if (keys.length > options.maxKeys) throw invalid("maximum object key count exceeded");

    const properties: string[] = [];
    for (const key of keys) {
      if (isObviousSecretKey(key)) throw invalid("secret-like keys are not supported");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) {
        throw invalid("accessor properties are not supported");
      }
      properties.push(`${quoteString(key)}:${encode(descriptor.value, options, depth + 1, seen)}`);
    }
    return `{${properties.join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

/**
 * Encode a JSON-safe value with lexicographically sorted object keys and explicit resource limits.
 * The function intentionally rejects values that native JSON.stringify would silently discard.
 */
export function canonicalizeJson(value: unknown, options: CanonicalJsonOptions = {}): string {
  const normalized = normalizeOptions(options);
  const encoded = encode(value, normalized, 0, new Set<object>());
  const bytes = Buffer.byteLength(encoded, "utf8");
  if (bytes > normalized.maxBytes) throw invalid("maximum serialized byte count exceeded");
  return encoded;
}

export const canonicalJson = canonicalizeJson;
