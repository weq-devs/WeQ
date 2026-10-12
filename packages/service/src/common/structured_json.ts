/** Preserve native bigint and byte values in private JSON ledgers. */
export function encodeStructured(value: unknown): unknown {
  if (typeof value === 'bigint') return { $bigint: value.toString() };
  if (value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString('base64') };
  if (Array.isArray(value)) return value.map(encodeStructured);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, field]) => [key, encodeStructured(field)]),
    );
  return value;
}
export function decodeStructured(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeStructured);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length === 1 &&
    typeof record.$bigint === 'string' &&
    /^-?\d+$/.test(record.$bigint)
  )
    return BigInt(record.$bigint);
  if (Object.keys(record).length === 1 && typeof record.$bytes === 'string')
    return new Uint8Array(Buffer.from(record.$bytes, 'base64'));
  return Object.fromEntries(
    Object.entries(record).map(([key, field]) => [key, decodeStructured(field)]),
  );
}
