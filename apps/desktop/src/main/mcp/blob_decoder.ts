/**
 * Blob → AI-readable view for protobuf / JCE reverse engineering.
 *
 * MCP-side twin of WeQ's "Protobuf/JCE 逆向" panel: exposes the shared
 * `@weq/codec/raw` decoders (strict protobuf / JCE with recursive nesting +
 * schema-free guess fallback) plus the global tag → field-name dictionary, so
 * a model can decode hex it gets back from `execute_sql` without local tooling.
 *
 * Output deliberately mirrors CyberChef's "Protobuf Decode": a plain JSON tree
 * keyed by field number, nested messages inline, no per-value type wrappers and
 * no byte offsets. Readable text stays a string; other bytes become `0x…`;
 * tags the QQ dictionary knows are listed separately in `names` so the tree
 * itself stays short.
 */

import {
  decode as rawDecodeGuess,
  newJsonRenderCtx,
  parseInput,
  bytesToHex,
  rawFieldsToJsonView,
  rvNodesToJsonView,
  tryDecodeAfterLengthPrefix,
  tryDecodeJce,
  tryDecodeProtobuf,
  type JsonValue,
  type RvInputFormat,
} from '@weq/codec/raw';
import { lookupTag } from '@weq/codec/dictionary';

export type BlobFormat = 'auto' | 'protobuf' | 'jce';
export type BlobEncoding = RvInputFormat;
export type { JsonValue };

export interface BlobDecodeResult {
  ok: boolean;
  /** Which decoder produced the tree. */
  kind: 'protobuf' | 'jce' | 'guess' | 'none';
  bytes: number;
  /** Decoded tree: `{ "<tag>": value }`, repeated tags become arrays. */
  fields: { [k: string]: JsonValue };
  /** tag → QQ field name, only for tags that actually appear (≥1001). */
  names?: { [tag: string]: string | string[] };
  /** Set when a bytes value was too large to print in full. */
  truncatedHex?: boolean;
  /** Human note for the schema-free fallback. */
  guessNote?: string;
  /** 自动识别并剥离的长度前缀（QQ 数据包常见的 `00 00 00 D5 …` 开头）。 */
  prefix?: {
    width: number;
    endian: 'be' | 'le';
    value: number;
    declared: 'total' | 'payload';
    bytes: string;
  };
  error?: string;
}

/** 只列树里真正出现过的 tag，避免把整个词典塞进回复。 */
function namesOf(tags: Set<number>): { [tag: string]: string | string[] } | undefined {
  const out: { [tag: string]: string | string[] } = {};
  for (const tag of [...tags].sort((a, b) => a - b)) {
    const lookup = lookupTag(tag);
    if (lookup.status === 'known') {
      const name = lookup.names[0]?.name;
      if (name) out[String(tag)] = name;
    } else if (lookup.status === 'ambiguous') {
      out[String(tag)] = lookup.names.map((n) => n.name);
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// ── public API ──────────────────────────────────────────────────────────────

/** Decode already-parsed bytes with strict protobuf/JCE, then guess fallback. */
export function decodeBlobBytes(buf: Uint8Array, format: BlobFormat): BlobDecodeResult {
  if (buf.length === 0) {
    return { ok: false, kind: 'none', bytes: 0, fields: {}, error: '输入为空' };
  }

  const finish = (
    kind: 'protobuf' | 'jce' | 'guess',
    nodes: Parameters<typeof rvNodesToJsonView>[0],
    prefix?: BlobDecodeResult['prefix'],
  ): BlobDecodeResult => {
    const ctx = newJsonRenderCtx();
    const fields = rvNodesToJsonView(nodes, ctx);
    const names = namesOf(ctx.tags);
    return {
      ok: true,
      kind,
      bytes: buf.length,
      fields,
      ...(names ? { names } : {}),
      ...(ctx.truncatedHex ? { truncatedHex: true } : {}),
      ...(prefix ? { prefix } : {}),
    };
  };

  /**
   * 先自动识别 / 剥离 QQ 数据包开头的长度前缀（如 `00 00 00 D5 …`），只有剥完
   * 能**完整解析**才采用；否则回退到原字节。宽度 / 字节序列由数据自证，不硬编码。
   */
  const prefixed = (want: 'protobuf' | 'jce' | 'auto'): BlobDecodeResult | null => {
    const hit = tryDecodeAfterLengthPrefix(buf);
    if (!hit) return null;
    if (want !== 'auto' && hit.kind !== want) return null;
    return finish(hit.kind, hit.nodes, {
      width: hit.prefix.width,
      endian: hit.prefix.endian,
      value: hit.prefix.value,
      declared: hit.prefix.declared,
      bytes: bytesToHex(hit.prefix.bytes),
    });
  };

  if (format === 'protobuf') {
    const nodes = tryDecodeProtobuf(buf);
    if (nodes) return finish('protobuf', nodes);
    const stripped = prefixed('protobuf');
    if (stripped) return stripped;
    return {
      ok: false,
      kind: 'none',
      bytes: buf.length,
      fields: {},
      error: '无法按 protobuf 完整解析（可能需要剥离外层长度头/信封，或改用 auto 看猜测树）。',
    };
  }
  if (format === 'jce') {
    const nodes = tryDecodeJce(buf);
    if (nodes) return finish('jce', nodes);
    const stripped = prefixed('jce');
    if (stripped) return stripped;
    return {
      ok: false,
      kind: 'none',
      bytes: buf.length,
      fields: {},
      error: '无法按 JCE 完整解析（可能需要剥离外层长度头/信封，或改用 auto 看猜测树）。',
    };
  }

  const proto = tryDecodeProtobuf(buf);
  if (proto) return finish('protobuf', proto);
  const jce = tryDecodeJce(buf);
  if (jce) return finish('jce', jce);

  const stripped = prefixed('auto');
  if (stripped) return stripped;

  // Schema-free decoder always returns something for non-empty input; mark the
  // result honestly as a guess so models don't treat field numbers as fact.
  const ctx = newJsonRenderCtx();
  const raw = rawDecodeGuess(buf);
  const names = namesOf(ctx.tags);
  return {
    ok: true,
    kind: raw.length ? 'guess' : 'none',
    bytes: buf.length,
    fields: rawFieldsToJsonView(raw, ctx),
    ...(names ? { names } : {}),
    ...(ctx.truncatedHex ? { truncatedHex: true } : {}),
    guessNote:
      '未能按 protobuf 或 JCE 完整解析，以下是 schema-free 猜测：字段号按 wire 原样保留，值的类型取最可能的一种。',
  };
}

/** Decode user-supplied hex/base64 text (separators and 0x prefixes allowed). */
export function decodeBlobText(
  text: string,
  encoding: BlobEncoding,
  format: BlobFormat,
): BlobDecodeResult {
  try {
    const buf = parseInput(text, encoding);
    return decodeBlobBytes(buf, format);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, kind: 'none', bytes: 0, fields: {}, error: `输入解析失败：${message}` };
  }
}

/** Decode a hex string already produced by DbExplorer (blob cells). */
export function decodeBlobHex(hex: string, format: BlobFormat): BlobDecodeResult {
  return decodeBlobText(hex, 'hex', format);
}
