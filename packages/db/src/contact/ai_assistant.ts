/**
 * `ai_session_table` / `ai_assistant_msg_table` — QQ AI 助手（小Q）。
 *
 * 这两张表**不属于** c2c 家族：会话键是 sessionId（40021），小Q 主入口的
 * sessionId 固定为 `10000`（`AI_ASSISTANT_MAIN_SESSION`）。会话列表里只有
 * 小Q 主入口会出现在 `recent_contact_v3_table`（chatType 45）；点进去之后
 * 的子会话只能从这里列。
 *
 * 列语义（实测样本，见 docs/database/nt_msg/ai-assistant.md）：
 *   ai_session_table
 *     40021  sessionId       （主键之一；10000 = 小Q 主入口）
 *     40055  chatType        （主键之一，恒 45）
 *     40094  title           会话标题
 *     40003  消息条数
 *     40050  最后消息时间（unix 秒）
 *     40051  预览（repeated PreviewElementWire，与 recent_contact 同构）
 *     41150  会话状态 `{41156: 2, 41157: 10|20}`，语义未定
 *   ai_assistant_msg_table
 *     列布局同 c2c（见 msg/c2c.ts），但：
 *       40021 = 40027 = sessionId（不是 uid + sortNo 的组合）
 *       40013  1/2 = 我发的，0 = AI 发的
 *       40020  我 = 本账号 uid；AI = sessionId 数字（或 10000）
 *
 * 本文件只做读取：AI 助手会话不支持发送消息（同公众号/服务号的只读语义）。
 */

import type { DatabaseAlgorithms, NtHelperBinding, SqlRow } from '@weq/native';
import { ProtoMsg, decodePreviewElement, type Element } from '@weq/codec';
import { RecentContactBody } from '@weq/codec/proto/msg/40051';
import { decodeBody, decodeDress, decodeEmoji } from '../msg/util';
import { readMessageSourceRows } from '../msg/export_source';
import type { AiAssistantSession } from './types';
import { QqDb } from '../qq_db';

export interface AiAssistantDbOptions {
  /** Absolute path to nt_msg.db. */
  dbPath: string;
  /** SQLCipher key (omit for plain decrypted). */
  key?: string;
  /** Database algorithms (omit for plain decrypted). */
  algo?: DatabaseAlgorithms;
}

const previewCodec = new ProtoMsg(RecentContactBody);

export class AiAssistantDb {
  private readonly qq: QqDb;

  constructor(nt: NtHelperBinding, opts: AiAssistantDbOptions) {
    this.qq = new QqDb(nt, { dbPath: opts.dbPath, key: opts.key, algo: opts.algo });
  }

  /** 表是否存在。旧版 QQ 没有这两张表，调用方按空列表处理即可。 */
  async hasTables(): Promise<boolean> {
    return (
      (await this.qq.hasTable('ai_session_table')) &&
      (await this.qq.hasTable('ai_assistant_msg_table'))
    );
  }

  /**
   * 全部 AI 助手会话，最新在前。小Q 主入口（10000）通常排第一，但它只是
   * 一个 sessionId —— 排序完全交给 40050。
   */
  async listSessions(): Promise<AiAssistantSession[]> {
    const rows = await this.qq.query(
      `SELECT "40021","40094","40003","40050","40051","41150"
         FROM ai_session_table
        ORDER BY "40050" DESC`,
    );
    return rows.map(rowToSession);
  }

  /** 单个会话。找不到时返回 null。 */
  async getSession(sessionId: string): Promise<AiAssistantSession | null> {
    const rows = await this.qq.query(
      `SELECT "40021","40094","40003","40050","40051","41150"
         FROM ai_session_table
        WHERE "40021" = ?`,
      [sessionId],
    );
    return rows[0] ? rowToSession(rows[0]) : null;
  }

  /**
   * 一个会话的全部消息，按会话内序号正序。
   *
   * AI 会话体量很小（实测单会话 2–15 条），一次性读完比游标翻页简单可靠。
   * 会话内 40003 从 1 递增，直接用它排序。
   */
  async listMessages(sessionId: string): Promise<
    Array<{
      msgId: bigint;
      msgSeq: bigint;
      sendTime: bigint;
      sendType: bigint;
      senderUid: string;
      elements: Element[];
    }>
  > {
    const rows = await this.qq.query(
      `SELECT "40001","40003","40050","40013","40020","40800"
         FROM ai_assistant_msg_table
        WHERE "40021" = ?
        ORDER BY "40003" ASC, "40050" ASC, "40001" ASC`,
      [sessionId],
    );
    return rows.map((row) => ({
      msgId: toBigint(row[0]),
      msgSeq: toBigint(row[1]),
      sendTime: toBigint(row[2]),
      sendType: toBigint(row[3]),
      senderUid: toStr(row[4]),
      elements: decodeBody(row[5]),
    }));
  }

  /** 会话消息条数（用于「还没加载过」的空态判断）。 */
  async countMessages(sessionId: string): Promise<number> {
    const rows = await this.qq.query(
      `SELECT COUNT(*) FROM ai_assistant_msg_table WHERE "40021" = ?`,
      [sessionId],
    );
    return Number(rows[0]?.[0] ?? 0);
  }

  async getMessageRecord(sessionId: string, msgId: string) {
    const table = 'ai_assistant_msg_table';
    const fields = [...(await this.qq.tableColumns(table))];
    if (!fields.length) return null;
    const [record] = await readMessageSourceRows(
      this.qq,
      table,
      '40021',
      sessionId,
      [msgId],
      fields,
    );
    if (!record) return null;
    return {
      ...record,
      message: {
        elements: decodeBody(record.columns['40800']),
        decoration: decodeDress(record.columns['40801']),
        setEmojiList: decodeEmoji(record.columns['40062']),
      },
    };
  }

  close(): void {
    this.qq.close();
  }
}

function rowToSession(row: SqlRow): AiAssistantSession {
  return {
    sessionId: toStr(row[0]),
    title: toStr(row[1]),
    messageCount: Number(toBigint(row[2])),
    lastTime: toBigint(row[3]),
    preview: decodePreview(row[4]),
    state: row[5] instanceof Uint8Array ? row[5] : null,
  };
}

function decodePreview(blob: unknown): Element[] {
  if (!(blob instanceof Uint8Array)) return [];
  try {
    const decoded = previewCodec.decode(blob);
    return (decoded.preview ?? []).map((wire) => decodePreviewElement(wire));
  } catch {
    return [];
  }
}

function toBigint(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  if (typeof v === 'string' && v !== '') {
    try {
      return BigInt(v);
    } catch {
      return 0n;
    }
  }
  return 0n;
}

function toStr(v: unknown): string {
  return typeof v === 'string' ? v : String(v ?? '');
}
