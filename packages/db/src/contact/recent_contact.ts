/**
 * `recent_contact_v3_table` — the recent-conversations list.
 *
 * Column map (subset we read):
 *   40003  msgSeq              (INTEGER)
 *   40010  chatType            (INTEGER → mapped ChatType)
 *   40020  senderUid           (TEXT)
 *   40021  targetUid           (TEXT)
 *   40050  sendTime            (INTEGER, unix seconds)
 *   40051  preview             (BLOB — protobuf {repeated 40051: PreviewElementWire})
 *   40090  senderDisplayName   (TEXT, mainly group card)
 *   40093  senderNick          (TEXT)
 *   40094  targetDisplayName   (TEXT, conversation name)
 *   40095  senderRemark        (TEXT)
 *   41110  targetAvatar        (TEXT)
 *   41135  targetRemark        (TEXT, conversation remark)
 *   41148  targetGroupNick     (TEXT, peer's group card — temp c2c-from-group rows)
 *   41220  notifyLevel         (INTEGER — message-notify level; 1 = notify
 *                               normally, other values (observed 4) = 免打扰/muted)
 *   60001  tempSourceGroupCode (INTEGER — the group a temp c2c conversation was
 *                               started from; 0 when not applicable)
 *
 * The 40051 column is decoded by `@weq/codec`; chatType is mapped through the
 * codec's ChatType enum. Everything is assembled into `RecentContact`.
 */

import { ProtoMsg, decodePreviewElement, enumName, ChatType } from '@weq/codec';
import type { PreviewElement } from '@weq/codec';
import { sanitizeBytes } from '@weq/codec/raw';
import { RecentContactBody } from '@weq/codec/proto/msg/40051';
import type { DatabaseAlgorithms, NtHelperBinding, SqlRow, SqlValue } from '@weq/native';
import type { RecentContact } from './types';
import { QqDb } from '../qq_db';

const SELECT_COLUMNS = `"40003","40010","40020","40021","40030","40050","40051","40090","40093","40094","40095","41110","41135","41148","41220","60001"`;
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
  /** SQLCipher key. (omit for plain decrypted). */
  key?: string;
  /** Database algorithms (omit for plain decrypted). */
  algo?: DatabaseAlgorithms;
}

/** One conversation's seq watermark, read straight from `recent_contact_v3_table`. */
export interface RecentContactSeq {
  /** 40021 — conversation key (peer uid for c2c, group code for group). */
  targetUid: string;
  /** 40010 — raw numeric chat type (classify via `classifyChatType`). */
  chatType: number;
  /** 40003 — latest message seq in this conversation. */
  msgSeq: bigint;
  /** 40050 — latest message sendTime (unix seconds). */
  sendTime: bigint;
}

export class RecentContactDb {
  private readonly qq: QqDb;

  constructor(nt: NtHelperBinding, opts: RecentContactDbOptions) {
    this.qq = new QqDb(nt, { dbPath: opts.dbPath, key: opts.key, algo: opts.algo });
  }

  /**
   * Recent conversations, newest first. Defaults to 200 — the recent-chats
   * list is small, so a single ordered LIMIT over the 40050 index is cheap.
   */
  async getRecentContact(
    limit = 200,
    offset = 0,
    opts: { excludeChatTypes?: readonly number[] } = {},
  ): Promise<RecentContact[]> {
    const excluded = [...BLOCKED_CHAT_TYPES, ...(opts.excludeChatTypes ?? [])];
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM recent_contact_v3_table
        WHERE "40010" NOT IN (${excluded.join(',')})
        ORDER BY "40050" DESC
        LIMIT ? OFFSET ?`,
      [BigInt(limit), BigInt(offset)],
    );
    return rows.map(rowToRecentContact);
  }

  /** Total rows visible to {@link getRecentContact} (same exclusion rules). */
  async countRecentContact(opts: { excludeChatTypes?: readonly number[] } = {}): Promise<number> {
    const excluded = [...BLOCKED_CHAT_TYPES, ...(opts.excludeChatTypes ?? [])];
    const rows = await this.qq.query(
      `SELECT COUNT(*) FROM recent_contact_v3_table
        WHERE "40010" NOT IN (${excluded.join(',')})`,
    );
    return Number(rows[0]?.[0] ?? 0);
  }

  /**
   * Which of the given targetUids (40021) currently have a row in
   * `recent_contact_v3_table` — an exact, unbounded existence check.
   *
   * Callers that need "is this conversation still in the recent-chats list"
   * (e.g. hidden-session resolution, where the answer must not depend on
   * whether the row happens to fall inside `getRecentContact`'s LIMIT 200
   * page) must use this instead of scanning the capped list.
   */
  async hasTargetUids(targetUids: readonly string[]): Promise<Set<string>> {
    const unique = [...new Set(targetUids.filter((uid) => uid))];
    if (unique.length === 0) return new Set();
    const placeholders = unique.map(() => '?').join(',');
    const rows = await this.qq.query(
      `SELECT DISTINCT "40021" FROM recent_contact_v3_table WHERE "40021" IN (${placeholders})`,
      unique,
    );
    return new Set(rows.map((row) => toStr(row[0])));
  }

  /**
   * Every conversation's current seq watermark (40021 -> 40003). The table is
   * small (the recent-chats list), so re-reading it whole per poll is cheap and
   * never touches the big msg tables. Drives the new-message watcher: a grown
   * 40003 means new rows landed in that conversation's msg table.
   */
  async listSeqWatermarks(): Promise<RecentContactSeq[]> {
    const rows = await this.qq.query(
      `SELECT "40021","40010","40003","40050" FROM recent_contact_v3_table`,
    );
    return rows.map((row) => ({
      targetUid: toStr(row[0]),
      chatType: toNum(row[1]),
      msgSeq: toBigint(row[2]),
      sendTime: toBigint(row[3]),
    }));
  }
  /**
   * Search conversations by display name (column 40094), newest first.
   * The recent-contact table is small (hundreds of rows), so the LIKE scan
   * over it is cheap; `total` counts every match for pagination.
   */
  async searchByName(
    keyword: string,
    limit = 20,
    offset = 0,
  ): Promise<{ items: RecentContact[]; total: number }> {
    const needle = keyword.trim();
    if (!needle) return { items: [], total: 0 };
    const like = `%${escapeLike(needle)}%`;
    const blocked = BLOCKED_CHAT_TYPES.join(',');
    const [countRows, rows] = await Promise.all([
      this.qq.query(
        `SELECT COUNT(*) FROM recent_contact_v3_table
          WHERE "40094" LIKE ? ESCAPE '\\' AND "40094" != ''
            AND "40010" NOT IN (${blocked})`,
        [like],
      ),
      this.qq.query(
        `SELECT ${SELECT_COLUMNS} FROM recent_contact_v3_table
          WHERE "40094" LIKE ? ESCAPE '\\' AND "40094" != ''
            AND "40010" NOT IN (${blocked})
          ORDER BY "40050" DESC
          LIMIT ? OFFSET ?`,
        [like, BigInt(limit), BigInt(offset)],
      ),
    ]);
    return {
      items: rows.map(rowToRecentContact),
      total: Number(countRows[0]?.[0] ?? 0),
    };
  }

  /**
   * Recent-conversation rows for the given target uids (40021), newest first.
   * Used to resolve a buddy FTS 40027 partition back to a display name /
   * avatar / chatType without one query per conversation.
   */
  async getByTargetUids(targetUids: readonly string[]): Promise<RecentContact[]> {
    const unique = [...new Set(targetUids.filter((uid) => uid))];
    if (unique.length === 0) return [];
    const placeholders = unique.map(() => '?').join(',');
    const rows = await this.qq.query(
      `SELECT ${SELECT_COLUMNS} FROM recent_contact_v3_table
        WHERE "40021" IN (${placeholders})
        ORDER BY "40050" DESC`,
      unique,
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
    msgSeq: toBigint(row[0]),
    chatType: enumName(ChatType, toNum(row[1])),
    senderUid: toStr(row[2]),
    targetUid: toStr(row[3]),
    targetUin: toBigint(row[4]),
    sendTime: toBigint(row[5]),
    preview: decodePreview(row[6]),
    senderDisplayName: toStr(row[7]),
    senderNick: toStr(row[8]),
    targetDisplayName: toStr(row[9]),
    senderRemark: toStr(row[10]),
    targetAvatar: toStr(row[11]),
    targetRemark: toStr(row[12]),
    targetGroupNick: toStr(row[13]),
    notifyLevel: toNum(row[14]),
    tempSourceGroupCode: toBigint(row[15]),
  };
}

function decodePreview(blob: SqlValue | undefined): RecentContact['preview'] {
  if (!(blob instanceof Uint8Array)) return null;
  try {
    // Sanitize first so one mis-declared tag can't derail the decode.
    const decoded = contactCodec.decode(sanitizeBytes(blob, RecentContactBody));
    // 40051 现在可能重复出现（机器人 markdown 消息 = [markdown, text] 两个元素），
    // 逐个解出后挑一个最能代表列表预览的。
    const elements = (decoded.preview ?? [])
      .map((wire) => (wire ? decodePreviewElement(wire) : null))
      .filter((el): el is PreviewElement => el !== null);
    return pickPreviewElement(elements);
  } catch (e) {
    console.error(`[RecentContactDb] failed to decode 40051 preview:`, e);
    return null;
  }
}

/**
 * 40051 含多个元素时选「列表该显示的那一个」：优先纯文本元素（textContent 就是
 * 正文，markdown 机器人消息的兜底），其次挑带 displayText 的，最后退回第一个。
 */
function pickPreviewElement(elements: PreviewElement[]): PreviewElement | null {
  if (elements.length === 0) return null;
  const textEl = elements.find((el) => el.kind === 'text' && hasVisibleText(el.textContent));
  if (textEl) return textEl;
  return elements.find((el) => hasVisibleText(el.displayText)) ?? elements[0]!;
}

/** 是否含至少一个可见字符（与渲染层 conversationPreview 的判定保持一致）。 */
function hasVisibleText(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c > 0x20 && c !== 0x7f && !(c >= 0x80 && c <= 0x9f)) return true;
  }
  return false;
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

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `${m}`);
}
