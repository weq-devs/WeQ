import type { SqlValue } from '@weq/native';
import type { QqDb } from '../qq_db';
import { databaseRequestSignal, withDatabasePriority } from '../query_schedule';
import {
  readSenderNames,
  type GroupSenderName,
  type GroupSenderNameFilter,
  type SenderNameObservation,
} from './group_sender_history';

type ProfileNameFilter = Pick<
  GroupSenderNameFilter,
  'groupCode' | 'limit' | 'offset' | 'signal'
> & {
  senderUid: string;
};

type NameRange = {
  block: number;
  groupCode: string;
  kind: GroupSenderName['kind'];
  start: number;
  end: number;
};

function compareObservations(a: SenderNameObservation, b: SenderNameObservation): number {
  const time = a.sendTime - b.sendTime;
  if (time) return time;
  const left = BigInt(a.msgId);
  const right = BigInt(b.msgId);
  return left < right ? -1 : left > right ? 1 : 0;
}

function prepareRanges(summaries: readonly GroupSenderName[]) {
  const byScope = new Map<string | null, GroupSenderName[]>();
  for (const row of summaries) {
    const groupCode = row.groupCode;
    if (!groupCode || !/^[1-9]\d*$/.test(groupCode)) continue;
    const scope = row.kind === 'display' ? groupCode : null;
    const observations = {
      ...row,
      groupCode: scope,
      first: { ...row.first, groupCode },
      last: { ...row.last, groupCode },
    };
    const rows = byScope.get(scope);
    if (rows) rows.push(observations);
    else byScope.set(scope, [observations]);
  }

  const periods: GroupSenderName[] = [];
  const ranges: NameRange[] = [];
  // 同一范围只有一个称呼时，索引的首末消息足以确定这一段。
  // 不同称呼的范围交叠时，回查该范围内的消息以找出真实切换点。
  function collect(rows: readonly GroupSenderName[], last: SenderNameObservation) {
    const first = rows[0]!;
    if (rows.every((row) => row.name === first.name)) {
      periods.push({ ...first, last });
      return;
    }
    const block = ranges.length;
    const byGroup = new Map<string, NameRange>();
    for (const row of rows) {
      const groupCode = row.first.groupCode!;
      const range = byGroup.get(groupCode);
      if (range) range.end = Math.max(range.end, row.last.sendTime);
      else
        byGroup.set(groupCode, {
          block,
          groupCode,
          kind: row.kind,
          start: row.first.sendTime,
          end: row.last.sendTime,
        });
    }
    ranges.push(...byGroup.values());
  }

  for (const rows of byScope.values()) {
    rows.sort((a, b) => compareObservations(a.first, b.first));
    let start = 0;
    let last = rows[0]!.last;
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i]!;
      if (row.first.sendTime > last.sendTime) {
        collect(rows.slice(start, i), last);
        start = i;
        last = row.last;
      } else if (compareObservations(last, row.last) < 0) {
        last = row.last;
      }
    }
    collect(rows.slice(start), last);
  }
  return { periods, ranges };
}

async function readPeriods(
  qq: QqDb,
  filter: ProfileNameFilter,
  ranges?: readonly NameRange[],
): Promise<GroupSenderName[]> {
  const columns = await qq.tableColumns('group_msg_table');
  const display = columns.has('40090');
  const nickname = !filter.groupCode && columns.has('40093');
  if (!display && !nickname) return [];

  const kinds = [...(display ? ["('display')"] : []), ...(nickname ? ["('nickname')"] : [])];
  const from = ranges
    ? 'json_each(?) AS ranges CROSS JOIN group_msg_table AS m'
    : 'group_msg_table AS m CROSS JOIN kinds';
  const kind = ranges ? "json_extract(ranges.value,'$.kind')" : 'kinds.kind';
  const block = ranges ? "json_extract(ranges.value,'$.block')" : '0';
  const params: SqlValue[] = ranges ? [JSON.stringify(ranges)] : [];
  params.push(filter.senderUid);
  const where = ['m."40020"=?', 'm."40011">1', 'm."40011"<>5', 'm."40050">0'];
  if (ranges) {
    where.push(
      'm."40027"=json_extract(ranges.value,\'$.groupCode\')',
      "m.\"40050\" BETWEEN json_extract(ranges.value,'$.start') AND json_extract(ranges.value,'$.end')",
    );
  } else if (filter.groupCode) {
    where.push('m."40027"=?');
    params.push(filter.groupCode);
  } else {
    where.push('CAST(m."40027" AS INTEGER)>0');
  }
  const field = (column: string) => (columns.has(column) ? `trim(m."${column}")` : 'NULL');
  const rows = await qq.query(
    `WITH kinds(kind) AS (VALUES ${kinds.join(',')}), observations AS (
      SELECT CASE WHEN ${kind}='display' THEN m."40027" END AS groupCode,
        m."40020" AS uid, m."40033" AS uin, ${kind} AS kind, ${block} AS block,
        CASE WHEN ${kind}='display' THEN ${field('40090')} ELSE ${field('40093')} END AS name,
        printf('%020d:%020d:%020d:%s',m."40050",m."40001",m."40003",m."40027") AS evidence
      FROM ${from} WHERE ${where.join(' AND ')}
    ), changes AS (
      SELECT *, name IS NOT LAG(name) OVER timeline AS starts,
        name IS NOT LEAD(name) OVER timeline AS ends
      FROM observations WHERE name <> ''
      WINDOW timeline AS (PARTITION BY block,kind,groupCode ORDER BY evidence)
    ), boundaries AS (
      SELECT *, LEAD(evidence) OVER (PARTITION BY block,kind,groupCode ORDER BY evidence) AS following
      FROM changes WHERE starts OR ends
    )
    SELECT groupCode,uid,uin,name,kind,evidence,CASE WHEN ends THEN evidence ELSE following END
    FROM boundaries WHERE starts`,
    params,
  );
  return readSenderNames(rows);
}

export function profileSenderNamePeriods(
  qq: QqDb,
  filter: ProfileNameFilter,
  summaries?: readonly GroupSenderName[],
) {
  return withDatabasePriority(
    'background',
    async () => {
      const { periods: known, ranges } = summaries
        ? prepareRanges(summaries)
        : { periods: [], ranges: [] };
      const periods =
        !summaries || ranges.length
          ? known.concat(await readPeriods(qq, filter, summaries ? ranges : undefined))
          : known;

      periods.sort((a, b) => compareObservations(a.first, b.first));
      const latestByScope = new Map<string | null, GroupSenderName>();
      const merged: GroupSenderName[] = [];
      for (const period of periods) {
        const previous = latestByScope.get(period.groupCode);
        if (previous?.name === period.name) previous.last = period.last;
        else {
          latestByScope.set(period.groupCode, period);
          merged.push(period);
        }
      }
      const offset = filter.offset ?? 0;
      return merged
        .sort(
          (a, b) =>
            Number(a.groupCode !== null) - Number(b.groupCode !== null) ||
            compareObservations(b.last, a.last),
        )
        .slice(offset, offset + filter.limit);
    },
    filter.signal ?? databaseRequestSignal(),
  );
}
