/**
 * `emoji_com_used_table` —— emoji.db 里「最近使用」表情。
 *
 * 只有一行（key = `emoji_com_used_key`），48902 列是可读写的 protobuf：
 *   { 48902 { 80751 updatedAt, 80760[] { 80770 faceId, 80772 sourceType,
 *              80773 usedAt, 80774 unicode, 80775 extra } } }
 * 见 `@weq/codec/proto/emoji/emoji_com_used`。
 *
 * ⚠️ 写入会改 QQ 自己的库（与 QQ 共用 emoji.db）。`record()` 读改写同一行，
 * 建议 QQ 关闭时使用；写不进时由上层兜底，不影响发送。
 */

import { ProtoMsg } from '@weq/codec';
import { EmojiComUsed } from '@weq/codec/proto/emoji/emoji_com_used';
import type { SqlRow } from '@weq/native';
import { QqDb } from '../qq_db';

const TABLE = 'emoji_com_used_table';
const ROW_KEY = 'emoji_com_used_key';
/** 最近使用最多保留多少条（QQ 自己约 30；留点余量）。 */
const MAX_ENTRIES = 60;

/** 一条最近使用的表情。 */
export interface RecentEmojiEntry {
  /** 表情 ID（↔ base_sys_emoji_table.81211）；unicode 表情可能是码点或 0。 */
  faceId: number;
  /** QQ 内部的来源/分类枚举，原样保留。 */
  sourceType: number;
  /** 使用时间（Unix 毫秒）。 */
  usedAt: number;
  /** 是否 unicode 字符表情（无本地图片，按字符渲染）。 */
  unicode: boolean;
  /** 附加字节解码后的文本：unicode 表情为字符本身，否则多为空串 / faceId 字符串。 */
  extra: string;
}

export interface RecentEmojiState {
  /** 最后一次更新（Unix 秒；0 表示缺失）。 */
  updatedAt: number;
  entries: RecentEmojiEntry[];
}

/** 记录一条最近使用时需要的字段（时间由本方法生成）。 */
export interface RecentEmojiInput {
  faceId: number;
  sourceType: number;
  unicode: boolean;
  extra?: string;
}

export class EmojiComUsedDb extends QqDb {
  private readonly proto = new ProtoMsg(EmojiComUsed);

  /** 读取全部最近使用记录（最新在前）。表/行缺失返回空状态。 */
  async list(): Promise<RecentEmojiState> {
    let rows: SqlRow[];
    try {
      rows = await this.query(`SELECT "48901", "48902" FROM ${TABLE} WHERE "48901" = ? LIMIT 1`, [
        ROW_KEY,
      ]);
    } catch {
      return { updatedAt: 0, entries: [] };
    }
    const blob = rows[0]?.[1];
    if (!(blob instanceof Uint8Array)) return { updatedAt: 0, entries: [] };
    return decodeState(this.proto, blob);
  }

  /**
   * 记一条最近使用：同一条（unicode 按字符、图片按 faceId）去重后置顶，
   * 整体裁剪到 {@link MAX_ENTRIES}，读改写同一行。已完成即返回。
   */
  async record(input: RecentEmojiInput): Promise<void> {
    const state = await this.list();
    const entry: RecentEmojiEntry = {
      faceId: input.faceId,
      sourceType: input.sourceType,
      usedAt: Date.now(),
      unicode: input.unicode,
      extra: input.extra ?? '',
    };
    const key = entryKey(entry);
    const next = [entry, ...state.entries.filter((e) => entryKey(e) !== key)].slice(0, MAX_ENTRIES);

    const bytes = this.proto.encode({
      info: {
        updatedAt: BigInt(Math.floor(Date.now() / 1000)),
        items: next.map(toWire),
      },
    });

    const updated = await this.write(`UPDATE ${TABLE} SET "48902" = ? WHERE "48901" = ?`, [
      bytes,
      ROW_KEY,
    ]);
    if (updated === 0) {
      await this.write(`INSERT INTO ${TABLE} ("48901", "48902") VALUES (?, ?)`, [ROW_KEY, bytes]);
    }
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

/** 去重键：unicode 表情用字符，图片表情用 faceId。 */
function entryKey(entry: RecentEmojiEntry): string {
  return entry.unicode ? `u:${entry.extra}` : `f:${entry.faceId}`;
}

type WireEntry = NonNullable<
  NonNullable<ReturnType<ProtoMsg<typeof EmojiComUsed>['decode']>['info']>['items']
>[number];

function toWire(entry: RecentEmojiEntry): WireEntry {
  return {
    faceId: entry.faceId >>> 0,
    sourceType: entry.sourceType >>> 0,
    usedAt: BigInt(entry.usedAt),
    unicode: entry.unicode ? 1 : 0,
    extra: new TextEncoder().encode(entry.extra),
  };
}

function decodeState(proto: ProtoMsg<typeof EmojiComUsed>, blob: Uint8Array): RecentEmojiState {
  let decoded: ReturnType<ProtoMsg<typeof EmojiComUsed>['decode']>;
  try {
    decoded = proto.decode(blob);
  } catch {
    return { updatedAt: 0, entries: [] };
  }
  const inner = decoded.info;
  const entries = (inner?.items ?? []).map(fromWire).filter((e): e is RecentEmojiEntry => !!e);
  return {
    updatedAt: inner?.updatedAt !== undefined ? Number(inner.updatedAt) : 0,
    entries,
  };
}

function fromWire(item: WireEntry): RecentEmojiEntry | null {
  const faceId = item.faceId ?? 0;
  const unicode = (item.unicode ?? 0) === 1;
  const extra = item.extra ? safeDecodeUtf8(item.extra) : '';
  if (!unicode && faceId === 0 && !extra) return null;
  return {
    faceId: faceId >>> 0,
    sourceType: item.sourceType ?? 0,
    usedAt: item.usedAt !== undefined ? Number(item.usedAt) : 0,
    unicode,
    extra,
  };
}

function safeDecodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder().decode(bytes);
  } catch {
    return '';
  }
}
