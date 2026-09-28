/**
 * `search_history` — QQ「最近搜索命中」列表（搜索框空着时下拉里显示的那一份）。
 *
 * 表本体只有两列：`"100210"` 自增主键 + `"100211"` protobuf BLOB，一行 = 一条命中：
 * 命中的实体（好友 / 群友 / 群 / 文件）加上命中的高亮片段。字段布局见
 * `@weq/codec/proto/msg/search_history`。
 *
 * 两个注意点：
 *   - **没有时间字段**。新旧只能靠 `"100210"` 推 —— QQ 会把被淘汰的行删掉，
 *     所以 rowid 不连续，`ORDER BY "100210" DESC` 就是「最近搜过的在前」。
 *   - 表很小（QQ 只留最近几条），整表读一次即可，不需要分页。
 */

import { ProtoMsg } from '@weq/codec';
import { sanitizeBytes } from '@weq/codec/raw';
import { SearchHistoryBody } from '@weq/codec/proto/msg/search_history';
import type { DatabaseAlgorithms, NtHelperBinding, SqlRow, SqlValue } from '@weq/native';
import { QqDb } from '../qq_db';

const historyCodec = new ProtoMsg(SearchHistoryBody);

/** 命中实体的种类 —— 对应 BLOB 里的 `100212` resultKind。 */
export type SearchHistoryKind = 'friend' | 'groupMember' | 'group' | 'file';

/** One decoded `search_history` row. 时间用 unix 秒；数字 id / uin 用 bigint。 */
export interface SearchHistoryEntry {
  kind: SearchHistoryKind;
  /** `100210` — 自增主键，越大越新（唯一可用的时间序）。 */
  histId: bigint;
  /** 人 / 文件的发送者 uid；群命中是群主之外的占位（样本里是同群成员）。 */
  uid: string;
  uin: bigint;
  /** 自定义 QQ 号（qid），没有时为空串。 */
  qid: string;
  /** 展示名：好友/群友 = 群名片或昵称，群 = 群名，文件 = 文件名。 */
  name: string;
  /** 原始昵称（好友 / 群友 / 文件发送者）。 */
  nick: string;
  /** 群名片（群友 = 该成员的名片；文件 = 发送者在该群的名片）。 */
  groupCard: string;
  /** 好友分组名（只有好友命中才有，如「我的好友」）。 */
  categoryName: string;
  /** 群号（群命中 = 该群；群友/文件命中 = 所属群）。 */
  groupCode: bigint;
  groupName: string;
  /** 命中所在会话类型：1 = 私聊，2 = 群。 */
  chatType: number;
  /** 文件命中才有：文件名 / 大小 / md5 / 源消息 id / 发送时间。 */
  fileName: string;
  fileSize: number;
  /** `200009` — 源消息的发送时间（unix 秒），只有文件命中才有。 */
  sendTime: bigint;
  /** `200015` — 源消息的 msgId，只有文件命中才有（可用来跳回原消息）。 */
  msgId: string;
  /** 命中的那一段名字片段（100338）。 */
  matchedText: string;
}

export interface SearchHistoryDbOptions {
  /** Absolute path to nt_msg.db. */
  dbPath: string;
  /** SQLCipher key. (omit for plain decrypted). */
  key?: string;
  /** Database algorithms (omit for plain decrypted). */
  algo?: DatabaseAlgorithms;
}

export class SearchHistoryDb {
  private readonly qq: QqDb;

  constructor(nt: NtHelperBinding, opts: SearchHistoryDbOptions) {
    this.qq = new QqDb(nt, { dbPath: opts.dbPath, key: opts.key, algo: opts.algo });
  }

  /**
   * Recent search hits, newest first. Rows whose `resultKind` we don't know (or
   * that fail to decode) are skipped rather than surfaced as junk.
   */
  async list(limit = 20): Promise<SearchHistoryEntry[]> {
    const rows = await this.qq.query(
      `SELECT "100210","100211" FROM search_history ORDER BY "100210" DESC LIMIT ?`,
      [BigInt(Math.max(1, Math.floor(limit)))],
    );
    const out: SearchHistoryEntry[] = [];
    for (const row of rows) {
      const entry = rowToEntry(row);
      if (entry) out.push(entry);
    }
    return out;
  }

  /** 表里现有几行（QQ 只留最近几条，通常个位数）。 */
  async count(): Promise<number> {
    const rows = await this.qq.query(`SELECT COUNT(*) FROM search_history`);
    return Number(rows[0]?.[0] ?? 0);
  }

  /** Drop the cached native connection. Call on account switch / shutdown. */
  close(): void {
    this.qq.close();
  }
}

// ---------- row → SearchHistoryEntry --------------------------------------

function rowToEntry(row: SqlRow): SearchHistoryEntry | null {
  const histId = toBigint(row[0]);
  const blob = row[1];
  if (!(blob instanceof Uint8Array)) return null;
  try {
    const decoded = historyCodec.decode(sanitizeBytes(blob, SearchHistoryBody));
    const entry = decoded.entry;
    if (!entry) return null;

    const base = {
      histId,
      uid: '',
      uin: 0n,
      qid: '',
      name: '',
      nick: '',
      groupCard: '',
      categoryName: '',
      groupCode: 0n,
      groupName: '',
      chatType: 0,
      fileName: '',
      fileSize: 0,
      sendTime: 0n,
      msgId: '',
      matchedText: '',
    };

    switch (entry.resultKind) {
      case 1: {
        const person = entry.person;
        if (!person) return null;
        if (person.personKind === 2 && person.groupMember) {
          const m = person.groupMember;
          return {
            ...base,
            kind: 'groupMember',
            uid: m.uid ?? '',
            uin: m.uin ?? 0n,
            qid: '',
            nick: m.nick ?? '',
            groupCard: m.groupCard ?? '',
            // 群里优先显示群名片。
            name: m.groupCard || m.nick || '',
            groupCode: m.groupCode ?? 0n,
            groupName: m.groupName ?? '',
            chatType: 1,
            ...matchFields(m.highlight?.matchedText, m.highlight?.matchLength),
          };
        }
        const b = person.buddy;
        if (!b) return null;
        return {
          ...base,
          kind: 'friend',
          uid: b.uid ?? '',
          uin: b.uin ?? 0n,
          qid: b.qid ?? '',
          nick: b.nick ?? '',
          categoryName: b.name ?? '',
          name: b.nick || b.qid || '',
          chatType: b.chatType ?? 1,
          ...matchFields(b.highlight?.matchedText, b.highlight?.matchLength),
        };
      }
      case 2: {
        const g = entry.group?.group;
        if (!g) return null;
        return {
          ...base,
          kind: 'group',
          groupCode: g.groupCode ?? 0n,
          groupName: g.groupName ?? '',
          name: g.groupName ?? '',
          chatType: 2,
          ...matchFields(g.highlight?.matchedText, g.highlight?.matchLength),
        };
      }
      case 4: {
        const f = entry.file?.file;
        if (!f) return null;
        return {
          ...base,
          kind: 'file',
          uid: f.uid ?? '',
          uin: 0n,
          nick: f.nick ?? '',
          groupCard: f.groupCard ?? '',
          name: f.fileName ?? '',
          fileName: f.fileName ?? '',
          fileSize: f.fileSize ?? 0,
          groupCode: f.groupCode ?? 0n,
          groupName: f.groupName ?? '',
          chatType: f.chatType ?? 2,
          sendTime: toBigintFromNum(f.sendTime),
          msgId: f.msgId ?? '',
          ...matchFields(f.highlight?.matchedText, f.highlight?.matchLength),
        };
      }
      default:
        // Unknown kind (a future QQ may add more) — don't guess.
        return null;
    }
  } catch (e) {
    console.error('[SearchHistoryDb] failed to decode 100211 blob:', e);
    return null;
  }
}

/** `matchedText` / `matchLength` 是命中的那一段名字；缺失时给空值。 */
function matchFields(
  matchedText: string | undefined,
  matchLength: number | undefined,
): { matchedText: string; matchLength: number } {
  const text = matchedText ?? '';
  return { matchedText: text, matchLength: matchLength ?? text.length };
}

function toBigintFromNum(v: number | undefined): bigint {
  return v === undefined ? 0n : BigInt(v);
}

function toBigint(v: SqlValue | undefined): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  if (typeof v === 'string' && v !== '') return BigInt(v);
  return 0n;
}
