import type { QqDb } from '../qq_db';
import { decodeBody } from './util';
import { MsgType, SendStatus } from '@weq/codec/proto/msg/40900';

export interface DirectoryTimeRow {
  conversation: string;
  time: number;
  senderUid: string;
  senderUin: string;
}
/** rowid 游标保证乱序时间、同秒消息及非连续大整数键不漏读；每次最多解码 128 行。 */
export async function directoryTimePage(
  qq: QqDb,
  table: 'c2c_msg_table' | 'group_msg_table',
  before?: string,
) {
  const column = table === 'group_msg_table' ? '40027' : '40021';
  const limit = 128;
  const rows = await qq.query(
    `SELECT rowid,"${column}","40050","40020","40033","40011","40041","40800"
     FROM ${table}${before ? ' WHERE rowid<?' : ''} ORDER BY rowid DESC LIMIT ?`,
    [...(before ? [BigInt(before)] : []), BigInt(limit)],
  );
  const items: DirectoryTimeRow[] = [];
  for (const row of rows) {
    const time = Number(row[2]);
    if (!Number.isSafeInteger(time) || time <= 0 || !String(row[1] ?? '')) continue;
    if (Number(row[6]) !== SendStatus.SUCCESS) continue;
    if ([MsgType.UNKNOWN, MsgType.NULL, MsgType.GRAY_TIP].includes(Number(row[5]))) continue;
    const elements = decodeBody(row[7]);
    if (!elements.some((element) => !element.kind.startsWith('grayTip'))) continue;
    items.push({
      conversation: String(row[1]),
      time,
      senderUid: String(row[3] ?? ''),
      senderUin: String(row[4] ?? ''),
    });
  }
  return {
    items,
    cursor: rows.length ? String(rows.at(-1)![0]) : before,
    done: rows.length < limit,
  };
}
