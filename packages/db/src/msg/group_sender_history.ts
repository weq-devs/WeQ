import { AsyncLocalStorage } from 'node:async_hooks';
import type { SqlValue } from '@weq/native';
import type { QqDb } from '../qq_db';
import { withDatabasePriority } from '../query_schedule';
import type { SenderNameAtTime } from './types';

const recordedNames = new AsyncLocalStorage<true>();

export function withRecordedGroupSenderNames<T>(read: () => T): T {
  return recordedNames.run(true, read);
}

export function wantsRecordedGroupSenderNames() {
  return recordedNames.getStore() === true;
}

export const SENDER_NAME_COLUMNS = ['40090', '40093'] as const;

export function senderNameAtTime(
  display: unknown,
  nickname: unknown,
): SenderNameAtTime | undefined {
  const name = typeof display === 'string' ? display.trim() : '';
  if (name) return { name, kind: 'display' };
  const nick = typeof nickname === 'string' ? nickname.trim() : '';
  return nick ? { name: nick, kind: 'nickname' } : undefined;
}

export type SenderNameObservation = { msgId: string; msgSeq: string; sendTime: number };
export type GroupSenderName = SenderNameAtTime & {
  groupCode: string | null;
  senderUid: string;
  senderUin: string;
  first: SenderNameObservation;
  last: SenderNameObservation;
};

function evidence(value: SqlValue): SenderNameObservation {
  const [sendTime, msgId, msgSeq] = String(value).split(':');
  return {
    sendTime: Number(sendTime),
    msgId: BigInt(msgId!).toString(),
    msgSeq: BigInt(msgSeq!).toString(),
  };
}

export interface GroupSenderNameFilter {
  groupCode?: string;
  senderUid?: string;
  keyword?: string;
  distinctSenders?: boolean;
  /** 个人资料跨群合并 QQ 昵称，群内资料只查该群的群昵称。 */
  profileHistory?: boolean;
  offset?: number;
  limit: number;
  signal?: AbortSignal;
}

export async function groupSenderNames(
  qq: QqDb,
  filter: GroupSenderNameFilter,
): Promise<GroupSenderName[]> {
  const columns = await qq.tableColumns('group_msg_table');
  const present = SENDER_NAME_COLUMNS.filter(
    (column) =>
      columns.has(column) && !(filter.profileHistory && filter.groupCode && column === '40093'),
  );
  if (!present.length) return [];
  const params: SqlValue[] = [];
  const where = ['"40020" GLOB \'u_*\'', '"40011">1', '"40011"<>5', '"40050">0'];
  if (filter.groupCode) {
    where.push('"40027"=?');
    params.push(filter.groupCode);
  }
  if (filter.senderUid) {
    where.push('"40020"=?');
    params.push(filter.senderUid);
  }
  const alternatives = present.map((column) => (column === '40090' ? "'display'" : "'nickname'"));
  const field = (column: (typeof SENDER_NAME_COLUMNS)[number]) =>
    columns.has(column) ? `trim("${column}")` : 'NULL';
  const group = filter.profileHistory ? `CASE WHEN kind = 'display' THEN "40027" END` : '"40027"';
  const order = filter.profileHistory ? 'kind DESC,' : '';
  const sql = `WITH kinds(kind) AS (VALUES ${alternatives.map((kind) => `(${kind})`).join(',')}),
    observations AS (
      SELECT ${group} AS groupCode,"40020" AS senderUid,"40033" AS senderUin,
        CASE kind WHEN 'display' THEN ${field('40090')} ELSE ${field('40093')} END AS name,
        kind,printf('%020d:%020d:%020d',"40050","40001","40003") AS evidence
      FROM group_msg_table CROSS JOIN kinds WHERE ${where.join(' AND ')}
    ),
    grouped AS (
      SELECT groupCode,senderUid,MAX(senderUin) AS senderUin,name,kind,
        MIN(evidence) AS first,MAX(evidence) AS last
      FROM observations WHERE name <> '' ${filter.keyword ? 'AND instr(lower(name),lower(?)) > 0' : ''}
      GROUP BY groupCode,senderUid,name,kind
    )
    ${
      filter.distinctSenders
        ? `, ranked AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY ${filter.groupCode ? 'groupCode,senderUid' : 'senderUid'} ORDER BY last DESC,name,kind) AS rank
      FROM grouped
    )`
        : ''
    }
    SELECT groupCode,senderUid,senderUin,name,kind,first,last
      FROM ${filter.distinctSenders ? 'ranked WHERE rank=1' : 'grouped'}
      ORDER BY ${order}last DESC,groupCode,senderUid,name,kind LIMIT ? OFFSET ?`;
  const rows = await withDatabasePriority(
    'background',
    () =>
      qq.query(sql, [
        ...params,
        ...(filter.keyword ? [filter.keyword] : []),
        filter.limit,
        filter.offset ?? 0,
      ]),
    filter.signal,
  );
  return readSenderNames(rows);
}

export function readSenderNames(rows: readonly (readonly SqlValue[])[]): GroupSenderName[] {
  return rows.map(([groupCode, senderUid, senderUin, name, kind, first, last]) => ({
    groupCode: groupCode == null ? null : String(groupCode),
    senderUid: String(senderUid),
    senderUin: String(senderUin ?? ''),
    name: String(name),
    kind: kind === 'display' ? 'display' : 'nickname',
    first: evidence(first!),
    last: evidence(last!),
  }));
}
