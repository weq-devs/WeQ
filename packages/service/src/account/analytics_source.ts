import type { AccountSession } from '@weq/account';
import type { BrowseCursor, BrowseFilter, C2cMsg, GroupMsg } from '@weq/db';
import { mergeRoamingTimeline, timelineRowKey, type TimelineRow } from '../common/roaming_timeline';
import { validateAnalyticsRange, type AnalyticsRange } from '../common/analytics_time';
import type { GapFetchedMessage } from './gap_history';

export interface AnalyticsCacheSource {
  cachedForExport(kind: 'c2c' | 'group', conv: string): Promise<GapFetchedMessage[]>;
  cachedConversations(): Promise<
    Array<{ kind: 'c2c' | 'group'; conv: string; lastMessageTime: number }>
  >;
}

/** 仅保留即时分析实际读取的元素字段，不将渲染元素冒充原始协议元素。 */
export interface AnalyticsMessage {
  msgId: bigint;
  msgSeq: bigint;
  sendTime: bigint;
  senderUid: string;
  senderUin: bigint;
  targetUin?: bigint;
  elements: Array<{ kind: string; textContent?: unknown; faceId?: unknown; faceText?: unknown }>;
}

function localTimeline(row: C2cMsg | GroupMsg): TimelineRow {
  return {
    msgId: String(row.msgId),
    msgSeq: String(row.msgSeq),
    msgRandom: String(row.msgRandom ?? 0),
    senderUid: row.senderUid,
    sendTime: String(row.sendTime),
  };
}

/** 共用聊天时间线身份规则；本地消息保持有界分页，缓存只在单次分析内读取。 */
export class AnalyticsMessageSource {
  constructor(
    private readonly session: AccountSession,
    private readonly cache?: AnalyticsCacheSource,
  ) {}

  async cachedConversations() {
    return this.cache?.cachedConversations() ?? [];
  }

  async cachedMessages(kind: 'c2c' | 'group', conv: string) {
    return ((await this.cache?.cachedForExport(kind, conv)) ?? []).filter(
      (row) =>
        row.kind === kind && row.conv === conv && (kind === 'group' || row.ntSeqVerified === true),
    );
  }

  async latestTime(kind: 'c2c' | 'group', conv: string, localTime: number) {
    const cached = await this.cachedMessages(kind, conv);
    return cached.reduce((latest, row) => Math.max(latest, Number(row.sendTime) || 0), localTime);
  }

  async *messages(
    kind: 'c2c' | 'group',
    conv: string,
    scope: AnalyticsRange & Pick<BrowseFilter, 'sender' | 'senderUin'> = {},
    headersOnly = false,
  ): AsyncGenerator<AnalyticsMessage> {
    const range = validateAnalyticsRange(scope);
    if (range.messageIds?.length === 0) return;
    const sortNo = kind === 'c2c' ? this.session.uidMap.sortNoByUid(conv) : undefined;
    const part = sortNo === undefined ? { uid: conv } : { sortNo };
    const cached = await this.cachedMessages(kind, conv);
    const localMatches = new Map<string, C2cMsg | GroupMsg>();
    // 查缓存身份对应的本地行，去重不依赖时间戳相同，也不受选区或时间过滤影响。
    for (let offset = 0; offset < cached.length; offset += 200) {
      const page = cached.slice(offset, offset + 200);
      const seqs = [...new Set(page.map((row) => BigInt(row.msgSeq)))];
      const ids = [...new Set(page.map((row) => BigInt(row.msgId)))];
      const rows =
        kind === 'c2c'
          ? [
              ...(await this.session.c2cMsgs.listBySeqsInPartition(part, seqs)),
              ...(await this.session.c2cMsgs.listByMsgIds(ids)),
            ]
          : [
              ...(await this.session.groupMsgs.listBySeqsInPartition(conv, seqs)),
              ...(await this.session.groupMsgs.listByMsgIds(ids)),
            ];
      for (const row of rows) {
        if ('targetUid' in row ? row.targetUid === conv : row.targetGroupCode === conv)
          localMatches.set(String(row.msgId), row);
      }
    }
    const local = [...localMatches.values()].map(localTimeline);
    const roaming = cached.map((row) => ({ ...row, source: 'roaming' as const }));
    const merged = mergeRoamingTimeline<TimelineRow>(kind, local, roaming);
    const retainedLocal = new Set(
      merged.filter((row) => row.source !== 'roaming').map((row) => row.msgId),
    );
    const suppressedLocal = new Set(
      local.filter((row) => !retainedLocal.has(row.msgId)).map((row) => row.msgId),
    );
    const retainedCache = new Set(
      merged.filter((row) => row.source === 'roaming').map(timelineRowKey),
    );
    const selected = range.messageIds === undefined ? undefined : new Set(range.messageIds);
    const localIds = selected
      ? new Set([...selected].filter((id) => !id.startsWith('roaming:')))
      : undefined;
    // 已选缓存随后同步入 QQ 时，沿用同一消息的本地副本，不把它漏掉。
    if (selected) {
      for (const row of roaming) {
        if (!selected.has(timelineRowKey(row)) || retainedCache.has(timelineRowKey(row))) continue;
        const counterpart =
          (row.sourceFormat === 'protocol' && row.msgRandom && row.msgRandom !== '0'
            ? local.find(
                (item) =>
                  item.msgSeq === row.msgSeq &&
                  item.msgRandom === row.msgRandom &&
                  item.senderUid === row.senderUid,
              )
            : undefined) ??
          local.find((item) => item.msgId === row.msgId) ??
          (!row.sourceFormat ? local.find((item) => item.msgSeq === row.msgSeq) : undefined);
        if (counterpart) localIds!.add(counterpart.msgId);
      }
    }
    const inRange = (time: bigint) =>
      (range.startTime === undefined || time >= BigInt(range.startTime)) &&
      (range.endTime === undefined || time <= BigInt(range.endTime));
    const matchesSender = (row: GapFetchedMessage) =>
      (!scope.sender && !scope.senderUin) ||
      (scope.sender && row.senderUid === scope.sender) ||
      (scope.senderUin && row.senderUin === scope.senderUin);
    const incoming = roaming
      .filter(
        (row) =>
          retainedCache.has(timelineRowKey(row)) &&
          (!selected || selected.has(timelineRowKey(row))) &&
          inRange(BigInt(row.sendTime)) &&
          matchesSender(row),
      )
      .map(
        (row): AnalyticsMessage => ({
          msgId: BigInt(row.msgId),
          msgSeq: BigInt(row.msgSeq),
          sendTime: BigInt(row.sendTime),
          senderUid: row.senderUid,
          senderUin: BigInt(row.senderUin || '0'),
          targetUin: 0n,
          elements: row.elements.map((element) => ({ ...element.data, kind: element.type })),
        }),
      )
      .sort((a, b) => (a.sendTime < b.sendTime ? -1 : a.sendTime > b.sendTime ? 1 : 0));
    let index = 0;
    let cursor: BrowseCursor | undefined;
    const filter = {
      start: range.startTime,
      end: range.endTime,
      messageIds: localIds ? [...localIds] : undefined,
      sender: scope.sender,
      senderUin: scope.senderUin,
    };
    for (;;) {
      const batch =
        kind === 'c2c'
          ? await this.session.c2cMsgs.browse(part, filter, cursor, 500, 'newer')
          : headersOnly
            ? await this.session.groupMsgs.browseAnalysisHeaders(conv, filter, cursor, 500)
            : await this.session.groupMsgs.browse(conv, filter, cursor, 500, 'newer');
      for (const { message } of batch) {
        while (index < incoming.length && incoming[index]!.sendTime < message.sendTime)
          yield incoming[index++]!;
        if (!suppressedLocal.has(String(message.msgId))) yield message;
      }
      if (batch.length < 500) break;
      const last = batch.at(-1)!;
      cursor = { time: last.message.sendTime, rowId: last.rowId };
    }
    while (index < incoming.length) yield incoming[index++]!;
  }
}
