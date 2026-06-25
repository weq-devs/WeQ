/** Serialization helpers shared by the JSON / JSONL exporters. */

/** JSON.stringify replacer: bigint → string (JSON has no bigint literal). */
export function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}
