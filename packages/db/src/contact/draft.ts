/**
 * `draft_storage_table_v1` — 会话草稿（输入了但还没点发送的内容）。
 *
 * 列：
 *   43001  storageKey（TEXT，主键）—— `0_{chatType}__{targetUid}`
 *   43002  entry     （BLOB）—— protobuf `{43002: DraftEntry}`，
 *                               见 `@weq/codec/proto/msg/43002_draft`
 *
 * 表结构与字段含义见 `docs/database/nt_msg/draft-storage.md`。43002 的 40800
 * **直接是 `ElementWire`**（可重复，一条草稿可以带文本 + 图片 + 表情等多个元素），
 * 与消息行的 `{40800: {40800: ElementWire}}` 差一层 —— 读写都按这个形状来。
 *
 * 写入注意（与文档一致的实测结论）：QQ 保存草稿是**整行覆盖**，它只认自己进程内
 * 的状态。WeQ 写进去的行 QQ 界面不会即时读取，但下次 QQ 自己编辑该会话草稿时会把
 * 整行重写掉。因此这里不做任何「合并既有草稿」的兜底 —— 写就是整行写。
 */

import { ProtoMsg, decodeElement, encodeElement, type Element } from '@weq/codec';
import { sanitizeBytes } from '@weq/codec/raw';
import { DraftBody } from '@weq/codec/proto/msg/43002_draft';
import type { DatabaseAlgorithms, NtHelperBinding, SqlRow } from '@weq/native';
import { QqDb } from '../qq_db';

const bodyCodec = new ProtoMsg(DraftBody);

/** 会话类型 → 行键前缀。c2c=1、群=2（`ChatType` 的两个主值）。 */
export function draftStorageKey(chatType: number, targetUid: string): string {
  return `0_${chatType}__${targetUid}`;
}

/** 一行草稿解码后的形状。 */
export interface Draft {
  /** 43001 — 行主键。 */
  storageKey: string;
  /** 40010 — 会话类型（ChatType 原始数字）。 */
  chatType: number;
  /** 40021 — 会话标识：c2c 是对端 uid，群是群号。 */
  targetUid: string;
  /** 40050 — 草稿写入时间，unix 秒。 */
  sendTime: bigint;
  /**
   * 40800 — 草稿正文，**按 40800 全量解析**：文本 / @ / 表情 / 图片 / 视频 /
   * 文件 / markdown / ark / 引用…… 所有 element 类型都原样解出来，不做裁剪。
   */
  elements: Element[];
}

/** 写一行草稿需要的内容（storageKey 由 {@link draftStorageKey} 拼）。 */
export interface DraftWriteInput {
  chatType: number;
  targetUid: string;
  /** unix 秒；缺省取当前时间。 */
  sendTime?: bigint;
  elements: Element[];
}

export interface DraftDbOptions {
  /** Absolute path to nt_msg.db. */
  dbPath: string;
  /** SQLCipher key. (omit for plain decrypted). */
  key?: string;
  /** Database algorithms (omit for plain decrypted). */
  algo?: DatabaseAlgorithms;
}

export class DraftDb {
  private readonly qq: QqDb;

  constructor(nt: NtHelperBinding, opts: DraftDbOptions) {
    this.qq = new QqDb(nt, { dbPath: opts.dbPath, key: opts.key, algo: opts.algo });
  }

  /** 整表读取。这张表只有几行，不需要分页。 */
  async listDrafts(): Promise<Draft[]> {
    const rows = await this.qq.query(`SELECT "43001","43002" FROM draft_storage_table_v1`);
    const out: Draft[] = [];
    for (const row of rows) {
      const draft = rowToDraft(row);
      if (draft) out.push(draft);
    }
    return out;
  }

  /** 读单个会话的草稿；没有（或解不出来）返回 null。 */
  async getDraft(chatType: number, targetUid: string): Promise<Draft | null> {
    const key = draftStorageKey(chatType, targetUid);
    const rows = await this.qq.query(
      `SELECT "43001","43002" FROM draft_storage_table_v1 WHERE "43001" = ?`,
      [key],
    );
    const row = rows[0];
    return row ? rowToDraft(row) : null;
  }

  /**
   * 整行写一份草稿（INSERT OR REPLACE）。调用方负责同步
   * `recent_contact_v3_table` 的 41108 / 41136 —— 见 `RecentContactDb.setDraftTime`。
   */
  async saveDraft(input: DraftWriteInput): Promise<void> {
    const storageKey = draftStorageKey(input.chatType, input.targetUid);
    const sendTime = input.sendTime ?? BigInt(Math.floor(Date.now() / 1000));
    const body = bodyCodec.encode({
      entry: {
        msgId: 0n,
        chatType: input.chatType,
        targetUid: input.targetUid,
        reserved40022: '',
        sendTime,
        elements: input.elements.map((el) => encodeElement(el)),
        reserved49079: 0,
      },
    });
    await this.qq.write(
      `INSERT OR REPLACE INTO draft_storage_table_v1 ("43001","43002") VALUES (?,?)`,
      [storageKey, body],
    );
  }

  /** 删掉一个会话的草稿行。没有该行时是 no-op。 */
  async deleteDraft(chatType: number, targetUid: string): Promise<void> {
    await this.qq.write(`DELETE FROM draft_storage_table_v1 WHERE "43001" = ?`, [
      draftStorageKey(chatType, targetUid),
    ]);
  }

  close(): void {
    this.qq.close();
  }
}

function rowToDraft(row: SqlRow): Draft | null {
  const storageKey = typeof row[0] === 'string' ? row[0] : String(row[0] ?? '');
  const blob = row[1];
  if (!(blob instanceof Uint8Array)) return null;
  try {
    // 先过 sanitizeBytes 容错：一行烂掉的草稿不该拖垮整个读取路径。
    const decoded = bodyCodec.decode(sanitizeBytes(blob, DraftBody));
    const entry = decoded.entry;
    if (!entry) return null;
    return {
      storageKey,
      chatType: entry.chatType ?? 0,
      targetUid: entry.targetUid ?? '',
      sendTime: entry.sendTime ?? 0n,
      elements: decodeElements(entry.elements),
    };
  } catch (e) {
    console.error('[DraftDb] failed to decode 43002 body:', e);
    return null;
  }
}

/**
 * 40800 已经是 element 本体（不套 MsgBody），所以这里逐个 `decodeElement` 即可；
 * 未观测过的 elementType 会落到 `UnknownElement`（保留原始 wire，可原样写回）。
 */
function decodeElements(wires: unknown): Element[] {
  if (!Array.isArray(wires)) return [];
  try {
    return wires.map((w) => decodeElement(w as never));
  } catch (e) {
    console.error('[DraftDb] failed to decode draft elements:', e);
    return [];
  }
}
