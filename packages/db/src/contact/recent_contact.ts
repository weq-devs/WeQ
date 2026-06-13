/**
 * `recent_contact_v3_table` — the recent-conversations list.
 *
 * Column map (subset we read):
 *   40010  chatType            (INTEGER → mapped ChatType)
 *   40020  senderUid           (TEXT)
 *   40021  targetUid           (TEXT)
 *   40050  sendTime            (INTEGER, unix seconds)
 *   40051  preview             (BLOB — protobuf {40051: PreviewElementWire})
 *   40090  senderDisplayName   (TEXT, mainly group card)
 *   40093  senderNick          (TEXT)
 *   40094  targetDisplayName   (TEXT, conversation name)
 *   40095  senderRemark        (TEXT)
 *   41110  targetAvatar        (TEXT)
 *   41135  targetRemark        (TEXT, conversation remark)
 *
 * The 40051 column is decoded by `@weq/codec`; chatType is mapped through the
 * codec's ChatType enum. Everything is assembled into `RecentContact`.
 */

import { ProtoMsg, decodePreviewElement, enumName, ChatType } from '@weq/codec';
import { sanitizeBytes } from '@weq/codec/raw';
import { RecentContactBody } from '@weq/codec/proto/msg/40051';
import type { NtHelperBinding, SqlRow, SqlValue } from '@weq/native';
import type { RecentContact } from './types';
import { QqDb } from '../qq_db';

const SELECT_COLUMNS = `"40010","40020","40021","40030","40050","40051","40090","40093","40094","40095","41110","41135"`;
const contactCodec = new ProtoMsg(RecentContactBody);

/**
 * Chat types excluded from the recent-contact list. Guild/channel rows use a
 * completely different column layout (name in 40091, preview nested in 41150,
 * no 40051/avatar) and aren't meaningfully renderable here, so we drop them.
 * Values are ChatType enum numbers — interpolated into SQL (never user input).
 */
const BLOCKED_CHAT_TYPES: readonly number[] = [ChatType.KCHATTYPEGUILDMETA];

export interface RecentContactDbOptions {
  /** Absolute path to nt_msg.db. */
  dbPath: string;
  /** SQLCipher key. */
  key: string;
}

export class RecentContactDb {
  private readonly qq: QqDb;

  constructor(nt: NtHelperBinding, opts: RecentContactDbOptions) {
    this.qq = new QqDb(nt, { dbPath: opts.dbPath, key: opts.key });
  }

  /**
   * Recent conversations, newest first. Defaults to 200 — the recent-chats
   * list is small, so a single ordered LIMIT over the 40050 index is cheap.
   */
  async getRecentContact(limit = 200, offset = 0): Promise<RecentContact[]> {
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM recent_contact_v3_table
        WHERE "40010" NOT IN (${BLOCKED_CHAT_TYPES.join(',')})
        ORDER BY "40050" DESC
        LIMIT ? OFFSET ?`,
      [BigInt(limit), BigInt(offset)],
    );
    return rows.map(rowToRecentContact);
  }

  /** Drop the cached native connection. Call on account switch / shutdown. */
  close(): void {
    this.qq.close();
  }
}

// ---------- row → RecentContact ------------------------------------------

function rowToRecentContact(row: SqlRow): RecentContact {
  return {
    chatType: enumName(ChatType, toNum(row[0])),
    senderUid: toStr(row[1]),
    targetUid: toStr(row[2]),
    targetUin: toBigint(row[3]),
    sendTime: toBigint(row[4]),
    preview: decodePreview(row[5]),
    senderDisplayName: toStr(row[6]),
    senderNick: toStr(row[7]),
    targetDisplayName: toStr(row[8]),
    senderRemark: toStr(row[9]),
    targetAvatar: toStr(row[10]),
    targetRemark: toStr(row[11]),
  };
}

function decodePreview(blob: SqlValue | undefined): RecentContact['preview'] {
  if (!(blob instanceof Uint8Array)) return null;
  try {
    // Sanitize first so one mis-declared tag can't derail the decode.
    const decoded = contactCodec.decode(sanitizeBytes(blob, RecentContactBody));
    return decoded.preview ? decodePreviewElement(decoded.preview) : null;
  } catch (e) {
    console.error(`[RecentContactDb] failed to decode 40051 preview:`, e);
    return null;
  }
}

function toBigint(v: SqlValue | undefined): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  if (typeof v === 'string' && v !== '') return BigInt(v);
  return 0n;
}

function toNum(v: SqlValue | undefined): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function toStr(v: SqlValue | undefined): string {
  return typeof v === 'string' ? v : String(v ?? '');
}
