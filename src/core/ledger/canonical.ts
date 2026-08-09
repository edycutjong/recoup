/**
 * Canonical JSON for hashing: recursively sorted object keys, no whitespace,
 * JSON string escaping, and a hard rejection of anything that would make the
 * encoding ambiguous (undefined, NaN/Infinity, BigInt, functions, symbols).
 */

export class CanonicalJsonError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'CanonicalJsonError';
  }
}

export function canonicalJson(value: unknown): string {
  return encode(value, new Set());
}

function encode(v: unknown, seen: Set<object>): string {
  if (v === null) return 'null';
  const t = typeof v;
  switch (t) {
    case 'string':
      return JSON.stringify(v);
    case 'boolean':
      return v ? 'true' : 'false';
    case 'number': {
      const n = v as number;
      if (!Number.isFinite(n)) throw new CanonicalJsonError(`non-finite number: ${n}`);
      return JSON.stringify(n);
    }
    case 'undefined':
      throw new CanonicalJsonError('undefined is not canonicalizable');
    case 'bigint':
      throw new CanonicalJsonError('bigint is not canonicalizable');
    case 'function':
    case 'symbol':
      throw new CanonicalJsonError(`${t} is not canonicalizable`);
    case 'object': {
      const obj = v as object;
      if (seen.has(obj)) throw new CanonicalJsonError('circular reference');
      seen.add(obj);
      try {
        if (Array.isArray(obj)) {
          return `[${obj.map((x) => encode(x, seen)).join(',')}]`;
        }
        const rec = obj as Record<string, unknown>;
        const keys = Object.keys(rec).sort();
        const parts: string[] = [];
        for (const k of keys) {
          const val = rec[k];
          if (val === undefined) continue; // absent and undefined encode identically: absent
          parts.push(`${JSON.stringify(k)}:${encode(val, seen)}`);
        }
        return `{${parts.join(',')}}`;
      } finally {
        seen.delete(obj);
      }
    }
    default:
      throw new CanonicalJsonError(`unhandled type ${t}`);
  }
}
