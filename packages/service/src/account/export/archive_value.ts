import { typedValue, type Json, type JsonObject } from './archive';

/** 来源值逐叶编码，大整数和字节不先经过 JSON.stringify。 */
export function sourceValue(value: unknown): Json {
  if (value === undefined) throw new Error('来源含未定义值');
  if (typeof value === 'bigint' || value instanceof Uint8Array) return typedValue(value);
  if (Array.isArray(value))
    return value.map((item) => (item === undefined ? null : sourceValue(item)));
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .map(([key, child]) => [key, sourceValue(child)]),
    );
  if (
    typeof value === 'number' &&
    (!Number.isFinite(value) || (!Number.isSafeInteger(value) && Number.isInteger(value)))
  )
    throw new Error('来源包含不可无损导出的数值');
  return value as Json;
}
export function nativeValue(value: unknown): JsonObject {
  return typeof value === 'bigint' || value instanceof Uint8Array
    ? typedValue(value)
    : typedValue(sourceValue(value));
}
export function unixTime(value: bigint | number | string, milliseconds = false): JsonObject | null {
  const raw = String(value);
  if (!/^-?\d+$/.test(raw)) return null;
  if (!milliseconds) return { unixSeconds: raw, precision: 'second' };
  const integer = BigInt(raw),
    negative = integer < 0n,
    absolute = negative ? -integer : integer;
  return {
    unixSeconds: `${negative ? '-' : ''}${absolute / 1000n}.${String(absolute % 1000n).padStart(3, '0')}`,
    precision: 'millisecond',
  };
}
