// Source Kit 0.1.0 — deterministic JSON canonicalization for signing
// Written with AI assistance. Verification: docs/PROVENANCE.md.
/**
 * Deterministic JSON canonicalization: object keys sorted recursively, no
 * whitespace, so a signature covers a byte-for-byte reproducible encoding.
 * Same rules as JSON Canonicalization Scheme (RFC 8785) for our value types.
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export function canonicalize(value: JsonValue): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number': {
      if (!Number.isFinite(value)) throw new Error('Non-finite number in attestation');
      return JSON.stringify(value);
    }
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return '[' + value.map(canonicalize).join(',') + ']';
      }
      const keys = Object.keys(value).sort();
      const parts = keys.map(
        (k) => JSON.stringify(k) + ':' + canonicalize((value as Record<string, JsonValue>)[k])
      );
      return '{' + parts.join(',') + '}';
    }
    default:
      throw new Error(`Unsupported value type in attestation: ${typeof value}`);
  }
}
