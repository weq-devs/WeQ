/**
 * Decode the 40801 message-decoration column.
 *
 * The BLOB wraps a single MsgDressWire payload inside an outer tag-40801 field
 * (i.e. the full column bytes start with field key 40801). Only the three fields
 * confirmed from a full Android-library scan are surfaced in the public type;
 * the rest remain in the raw wire struct but are not exposed.
 */

import { ProtoMsg, type ProtoDecodeStructType } from '../../core';
import { MsgDressBody, MsgDressWire } from '../../proto/msg/40801';
import { sanitizeBytes } from '../../raw';

export type MsgDressRecord = ProtoDecodeStructType<typeof MsgDressWire>;

/** DB 列 40801 形态：外层 tag 40801 包一层 MsgDressWire。 */
const dressCodec = new ProtoMsg(MsgDressBody);
/** 40900 内 proto40801 形态：直接就是 MsgDressWire 的原始 payload，无外层包。 */
const dressWireCodec = new ProtoMsg(MsgDressWire);

/**
 * Decoded per-message decoration data from column 40801.
 *
 * Only fields confirmed against real data are included; others remain opaque.
 *
 * 除了给显示用的 itemId（`bubbleId` / `fontId` / `widgetId`），这里**同时保留**
 * 字体两个槽位的**原始 wire 值**（{@link fontId1Raw} / {@link fontId2Raw}）。原因：
 * 40801 的字段与消息元素（PushMsgBody）里的装扮是**恒等映射**（真机实测
 * `41531 = 116182` 与 `elem generalFlags.font.fontId2 = 116182` 完全相等），转发
 * 已有消息时必须原样回写，绝不能「解码出 itemId 再自己编码」——那会把 bit 16 丢掉
 * （见 {@link fontId2Raw} 的说明）。
 */
export interface MsgDecoration {
  /** Bubble skin itemId (41510)。**原值**，与 elem `bubble.id` 恒等。0 = no bubble. */
  bubbleId: number;
  /**
   * 解码后的聊天字体 itemId（41525 优先，否则 41531 低 16 位字节序交换）。
   * 仅用于显示 / 资源解析，**不要拿它反推 wire 值**（那会丢 bit 16）。
   * 0 = no custom font.
   */
  fontId: number;
  /** Widget (挂件) itemId (41528)。**原值**，与 elem `generalFlags.widgetId` 恒等。0 = no widget. */
  widgetId: number;
  /**
   * 41525 的**原始 wire 值**（0 = 未设置）→ elem `generalFlags.font.fontId1`(tag 56)，
   * 原样写、不换算。
   */
  fontId1Raw: number;
  /**
   * 41531 的**原始 wire 值**（0 = 未设置）→ elem `generalFlags.font.fontId2`(tag 15)，
   * 原样写、**不做字节交换**。
   *
   * 低 16 位是字节交换过的 itemId，bit 16 是标志位（真机每条 40801 都置位；
   * `65536` = 只有标志位、其实没有字体）。{@link fontId} 把标志位掩掉（显示需要），
   * 这里保留原值，转发时标志位才不会丢。
   */
  fontId2Raw: number;
}

/** Decode the fallback font itemId stored in tag 41531 (byte-swapped uint16). */
function decodeFallbackFontId(stored: number | undefined): number {
  if (stored == null || stored === 0) return 0;
  return ((stored & 0xff) << 8) | ((stored >>> 8) & 0xff);
}

/** Lift one decoded MsgDressWire into the public shape, or null when all-zero. */
function dressToDecoration(d: MsgDressRecord): MsgDecoration | null {
  const bubbleId = d.bubbleId ?? 0;
  // 两个槽位都留原值；`fontId` 只做「给人看 / 查资源」的解码。
  const fontId1Raw = d.fontId ?? 0;
  const fontId2Raw = d.flag41531 ?? 0;
  const fontId = fontId1Raw !== 0 ? fontId1Raw : decodeFallbackFontId(fontId2Raw);
  const widgetId = d.widgetId ?? 0;
  if (bubbleId === 0 && fontId === 0 && widgetId === 0) return null;
  return { bubbleId, fontId, widgetId, fontId1Raw, fontId2Raw };
}

/** DB 列 40801 形态（外层 tag 40801 包 MsgDressWire）。 */
export function decodeMsgDressColumn(blob: unknown): MsgDecoration | null {
  if (!(blob instanceof Uint8Array) || blob.byteLength === 0) return null;
  try {
    const outer = dressCodec.decode(sanitizeBytes(blob, MsgDressBody));
    const d = outer.dress;
    if (!d) return null;
    return dressToDecoration(d);
  } catch {
    return null;
  }
}

/**
 * 40900 内 proto40801 形态：字段 tag 40801 的原始 payload 直接就是 MsgDressWire
 * （合并转发每条子消息的装扮），没有 DB 列那层外层包。解码失败 / 全零 → null。
 */
export function decodeMsgDressWire(blob: unknown): MsgDecoration | null {
  if (!(blob instanceof Uint8Array) || blob.byteLength === 0) return null;
  try {
    const d = dressWireCodec.decode(sanitizeBytes(blob, MsgDressWire));
    return dressToDecoration(d);
  } catch {
    return null;
  }
}
