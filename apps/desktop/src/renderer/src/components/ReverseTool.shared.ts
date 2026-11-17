import { tryDecodeAuto, type RvNode } from '@weq/codec/raw';

// ---------------------------------------------------------------------------
// 复用出口（ntqq 抓包等面板）
// ---------------------------------------------------------------------------

/**
 * 把一段字节解析成 `{tag: value}` 树：先自动剥离 QQ 长度前缀，再 protobuf，
 * 最后 JCE（见 {@link tryDecodeAuto}）。全部失败返回 null。
 */
export function decodeAnyBytes(
  bytes: Uint8Array,
): { nodes: RvNode[]; kind: 'protobuf' | 'jce' } | null {
  const hit = tryDecodeAuto(bytes);
  return hit ? { nodes: hit.nodes, kind: hit.kind } : null;
}
