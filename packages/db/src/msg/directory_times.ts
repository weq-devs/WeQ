import type { SqlRow, SqlValue } from '@weq/native';
import { ChatType } from '@weq/codec';
import type { QqDb } from '../qq_db';
import { decodeBody } from './util';
import { MsgType, SendStatus } from '@weq/codec/proto/msg/40900';

export interface DirectoryTimeRow {
  conversation: string;
  time: number;
  senderUid: string;
  senderUin: string;
}

const directoryColumns = (alias: string) =>
  ['40050', '40020', '40033', '40011', '40041', '40800']
    .map((column) => `${alias}."${column}"`)
    .join(',');

function validDirectoryTime(row: SqlRow, offset: number): number | undefined {
  const time = Number(row[offset]);
  if (!Number.isSafeInteger(time) || time <= 0) return;
  if (Number(row[offset + 4]) !== SendStatus.SUCCESS) return;
  if ([MsgType.UNKNOWN, MsgType.NULL, MsgType.GRAY_TIP].includes(Number(row[offset + 3]))) return;
  if (decodeBody(row[offset + 5]).some((element) => !element.kind.startsWith('grayTip')))
    return time;
}

function isMine(row: SqlRow, offset: number, selfUid: string, selfUin: string): boolean {
  const uid = String(row[offset + 1] ?? '');
  return selfUid && uid ? uid === selfUid : Boolean(selfUin && String(row[offset + 2]) === selfUin);
}

/** 会话摘要只作为首屏候选。按群号、序号、消息 ID 和时间核对原消息。 */
export async function recentGroupDirectoryTimes(
  qq: QqDb,
  groupCodes: readonly string[],
  selfUid: string,
  selfUin: string,
) {
  const rows = await qq.query(
    `SELECT r."40021",${directoryColumns('m')} FROM recent_contact_v3_table r
     JOIN group_msg_table m ON m."40027"=r."40021" AND m."40003"=r."40003"
       AND m."40001"=r."40001" AND m."40050"=r."40050"
     WHERE r."40010"=${ChatType.KCHATTYPEGROUP} AND r."40021" IN (SELECT value FROM json_each(?))
     ORDER BY r."40050" DESC LIMIT 128`,
    [JSON.stringify(groupCodes)],
  );
  const result: Record<string, { time: number; mine?: number }> = Object.create(null);
  for (const row of rows) {
    const time = validDirectoryTime(row, 1);
    if (time === undefined) continue;
    const code = String(row[0]);
    result[code] ??= { time };
    const entry = result[code];
    entry.time = Math.max(entry.time, time);
    if (isMine(row, 1, selfUid, selfUin)) entry.mine = Math.max(entry.mine ?? 0, time);
  }
  return result;
}

/** 只读目标群。先按时间取少量候选行，再解码正文；时间与行号可能乱序。 */
export async function groupDirectoryTimes(
  qq: QqDb,
  groupCode: string,
  selfUid: string,
  selfUin: string,
) {
  const lookup = async (onlyMine: boolean): Promise<SqlRow | undefined> => {
    const conditions = [
      '"40027"=?',
      '"40050" BETWEEN 1 AND 9007199254740991',
      `"40041"=${SendStatus.SUCCESS}`,
      `"40011" NOT IN (${MsgType.UNKNOWN},${MsgType.NULL},${MsgType.GRAY_TIP})`,
    ];
    const params: SqlValue[] = [groupCode];
    if (onlyMine) {
      if (selfUid && selfUin) {
        conditions.push('("40020"=? OR (COALESCE("40020",\'\')=\'\' AND "40033"=?))');
        params.push(selfUid, BigInt(selfUin));
      } else {
        conditions.push(selfUid ? '"40020"=?' : '"40033"=?');
        params.push(selfUid || BigInt(selfUin));
      }
    }
    const limit = 16;
    let cursor: SqlValue[] = [];
    while (true) {
      const rows = await qq.query(
        `SELECT c.rowid,${directoryColumns('m')} FROM (
           SELECT rowid,"40050" FROM group_msg_table WHERE ${conditions.join(' AND ')}
           ${cursor.length ? 'AND ("40050",rowid)<(?,?)' : ''}
           ORDER BY "40050" DESC,rowid DESC LIMIT ${limit}
         ) c CROSS JOIN group_msg_table m ON m.rowid=c.rowid
         ORDER BY c."40050" DESC,c.rowid DESC`,
        [...params, ...cursor],
      );
      const found = rows.find((row) => validDirectoryTime(row, 1) !== undefined);
      if (found || rows.length < limit) return found;
      const last = rows.at(-1)!;
      cursor = [last[1]!, last[0]!];
    }
  };
  const last = await lookup(false);
  if (!last) return { time: null, mine: null };
  const mine = isMine(last, 1, selfUid, selfUin)
    ? last
    : selfUid || selfUin
      ? await lookup(true)
      : undefined;
  return { time: Number(last[1]), mine: mine ? Number(mine[1]) : null };
}

/** rowid 游标保证乱序时间、同秒消息及非连续大整数键不漏读；每次最多解码 128 行。 */
export async function directoryTimePage(qq: QqDb, before?: string) {
  const limit = 128;
  const rows = await qq.query(
    `SELECT rowid,"40021","40050","40020","40033","40011","40041","40800"
     FROM c2c_msg_table${before ? ' WHERE rowid<?' : ''} ORDER BY rowid DESC LIMIT ?`,
    [...(before ? [BigInt(before)] : []), BigInt(limit)],
  );
  const items: DirectoryTimeRow[] = [];
  for (const row of rows) {
    const time = validDirectoryTime(row, 2);
    if (time === undefined || !String(row[1] ?? '')) continue;
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
