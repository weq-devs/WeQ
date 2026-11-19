import type { AccountServices } from '../../context/app_context';
import { mergeRoamingTimeline, timelineRowKey } from '../../../shared/roaming_timeline';
import { roamingMsgToWire } from '../roaming_message_wire';
import { c2cMsgToWire, groupMsgToWire, type ChatMsgWire } from '../serde';

export interface MessageHistoryCursor {
  time: number;
  id: string;
  roaming: boolean;
}

function compare(a: MessageHistoryCursor, b: MessageHistoryCursor) {
  return (
    b.time - a.time ||
    Number(a.roaming) - Number(b.roaming) ||
    (a.id > b.id ? -1 : a.id < b.id ? 1 : 0)
  );
}

export async function readMessageHistoryPage(
  { msgs, gapHistory }: AccountServices,
  input: {
    record: 'recalled' | 'deleted';
    kind: 'group' | 'c2c';
    conv: string;
    limit: number;
    before?: MessageHistoryCursor;
  },
) {
  const { record, kind, conv, limit, before } = input;
  const localBefore = before && { time: before.time, id: before.roaming ? undefined : before.id };
  const candidate = (
    row: Pick<ChatMsgWire, 'msgId' | 'sendTime'> & { recall?: ChatMsgWire['recall'] },
    wire?: ChatMsgWire,
  ) => ({
    key: {
      time: (record === 'recalled' ? row.recall?.recallTs : Number(row.sendTime)) || 0,
      id: wire ? timelineRowKey(wire) : row.msgId,
      roaming: Boolean(wire),
    },
    wire,
  });
  let candidates: ReturnType<typeof candidate>[];
  if (record === 'recalled') {
    const cached = (await gapHistory.cachedRecalls(kind, conv)).map(roamingMsgToWire);
    // 缓存版本可能与原库同一条消息但撤回时间不同，必须先去重，再应用分页游标。
    const local = await msgs.listRecallRefs(
      kind,
      conv,
      cached.length ? undefined : limit + 1,
      cached.length ? undefined : localBefore,
    );
    const merged = mergeRoamingTimeline<(typeof local)[number] | ChatMsgWire>(kind, local, cached);
    const content = new Map(cached.map((row) => [timelineRowKey(row), row]));
    candidates = merged.map((row) => candidate(row, content.get(timelineRowKey(row))));
  } else {
    const [local, cached] = await Promise.all([
      msgs.listDeletedRefs(kind, conv, limit + 1, localBefore),
      gapHistory.cachedDeleted(kind, conv, msgs.getDeletedMsgIds(kind, conv)),
    ]);
    candidates = [
      ...local.map((row) => candidate(row)),
      ...cached.map((row) => candidate(row, { ...roamingMsgToWire(row), deletedKind: 'weq' })),
    ];
  }
  const keys = new Map(candidates.map((entry) => [entry.key.id, entry]));
  const ordered = [...keys.values()]
    .filter(({ key }) => !before || compare(key, before) > 0)
    .sort((a, b) => compare(a.key, b.key));
  const page = ordered.slice(0, limit);
  const rows = await msgs.readHistoryRecordBodies(
    kind,
    conv,
    page.flatMap(({ key }) => (key.roaming ? [] : [BigInt(key.id)])),
  );
  const local = new Map(
    (kind === 'group'
      ? (rows as Parameters<typeof groupMsgToWire>[0][]).map(groupMsgToWire)
      : (rows as Parameters<typeof c2cMsgToWire>[0][]).map(c2cMsgToWire)
    ).map((row) => [row.msgId, row]),
  );
  return {
    rows: page.flatMap(({ key, wire }) => {
      const row = wire ?? local.get(key.id);
      return (record === 'recalled' ? row?.recall : row?.deletedKind) && row ? [row] : [];
    }),
    nextBefore: ordered.length > limit ? page.at(-1)!.key : null,
  };
}
