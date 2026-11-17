import { dirname, join } from 'node:path';
import { algoFor, type AccountSession } from '@weq/account';
import type { NtHelperBinding } from '@weq/native';
import { CalendarMetadataDb, QqDb, type CalendarCursor, type CalendarTable } from '@weq/db';
import { mergeRoamingTimeline, timelineRowKey, type TimelineRow } from '../common/roaming_timeline';
import {
  calendarMonthDays,
  compareMessageIds,
  type CalendarBatch,
  type CalendarSource,
  type CalendarTarget,
  type CalendarKind,
} from './conversation_calendar';
import type { MsgService } from './msg';
import type { GapHistoryService } from './gap_history';
import type { AgentLabService } from './agentlab';
import type { AssistantService } from './assistant';

export interface CalendarSourceServices {
  assistant?: Pick<AssistantService, 'getConversation'>;
  msgs: Pick<MsgService, 'getHiddenDeletedMsgIds'>;
  gapHistory: Pick<
    GapHistoryService,
    'hasCalendarCache' | 'calendarConversations' | 'calendarPage'
  >;
  agentLab: Pick<
    AgentLabService,
    | 'listPersonaSessions'
    | 'listGroupSessions'
    | 'getConversation'
    | 'getPersonaSessionConversation'
    | 'getGroupMessages'
    | 'getGroupSessionConversation'
  >;
}
export interface CalendarSourceContext {
  session: AccountSession;
  services: CalendarSourceServices;
  targets: CalendarTarget[];
  readers: Map<CalendarKind, CalendarMetadataDb>;
}

const tableFor: Partial<Record<CalendarKind, CalendarTable>> = {
  c2c: 'c2c_msg_table',
  official: 'c2c_msg_table',
  group: 'group_msg_table',
  dataline: 'dataline_msg_table',
  service: 'service_assistant_msg_table',
  guild: 'guild_msg_table',
};

export function generatedMessages(
  services: CalendarSourceServices,
  target: CalendarTarget,
  sessionId: string | null,
) {
  const lab = services.agentLab;
  if (target.kind === 'assistant') {
    if (!services.assistant) throw new Error('助手会话读取服务尚未就绪');
    return services.assistant.getConversation(target.conv);
  }
  if (target.kind === 'persona')
    return sessionId === null
      ? lab.getConversation(target.conv)
      : lab.getPersonaSessionConversation(target.conv, sessionId);
  return sessionId === null
    ? lab.getGroupMessages(target.conv)
    : lab.getGroupSessionConversation(target.conv, sessionId);
}

function generatedSource(
  kind: 'persona' | 'cloneGroup' | 'assistant',
  targets: CalendarTarget[],
  services: CalendarSourceServices,
  check: () => void,
): CalendarSource {
  const buckets = targets.flatMap((target) => {
    if (kind === 'assistant') return [{ target, sessionId: target.conv as string | null }];
    const list =
      kind === 'persona'
        ? services.agentLab.listPersonaSessions(target.conv)
        : services.agentLab.listGroupSessions(target.conv);
    return [
      { target, sessionId: null as string | null },
      ...list.map((session) => ({ target, sessionId: session.id as string | null })),
    ];
  });
  // 仅缓存每日计数和最早锚点，容量预先计入任务预算，不保留正文或无界逐条索引。
  const capacity = 128 * 1024;
  type Summary = { rows: Map<number, CalendarBatch['rows'][number]>; bytes: number };
  let summaries = new Map<string, Summary>();
  let bytes = 0;
  const dayStart = (time: number) => Math.floor((time + 28800) / 86400) * 86400 - 28800;
  return {
    kind,
    cacheCapacityBytes: capacity,
    invalidate() {
      summaries = new Map();
      bytes = 0;
    },
    async page(start, end, raw, limit) {
      const cursor = (raw ?? { bucket: 0, offset: 0 }) as { bucket: number; offset?: number };
      const aligned = start === dayStart(start) && end === start + 86400;
      const month = calendarMonthDays(new Date((start + 28800) * 1000).toISOString().slice(0, 7));
      const rows: CalendarBatch['rows'] = [];
      let index = cursor.bucket;
      let began = performance.now();
      for (; index < Math.min(buckets.length, cursor.bucket + limit); index++) {
        check();
        const bucket = buckets[index]!;
        const offset = index === cursor.bucket ? (cursor.offset ?? 0) : 0;
        const key = `${month[0]!.day}:${index}`;
        let summary = aligned && !offset ? summaries.get(key) : undefined;
        if (!summary) {
          const cache = summaries;
          summary = { rows: new Map(), bytes: 128 };
          const hidden = new Set(bucket.target.hiddenIds?.[bucket.sessionId ?? 'draft']);
          const messages = generatedMessages(services, bucket.target, bucket.sessionId);
          for (let position = offset; position < messages.length; position++) {
            if (performance.now() - began >= 4) {
              await new Promise<void>((done) => setTimeout(done, 0));
              check();
              began = performance.now();
            }
            const message = messages[position]!;
            const time = message.ts / 1000;
            if (
              !message.id ||
              hidden.has(message.id) ||
              !Number.isFinite(time) ||
              time < (aligned ? month[0]!.start : start) ||
              time >= (aligned ? month.at(-1)!.end : end)
            )
              continue;
            const stamp = dayStart(time);
            const previous = summary.rows.get(stamp);
            const anchor = { id: message.id, seq: '', time, sessionId: bucket.sessionId };
            if (previous) {
              previous.count = (previous.count ?? 1) + 1;
              if (
                time < previous.time ||
                (time === previous.time && compareMessageIds(message.id, previous.anchor.id) < 0)
              ) {
                previous.time = time;
                previous.anchor = anchor;
              }
            } else {
              summary.rows.set(stamp, { conv: bucket.target.conv, time, anchor, count: 1 });
              summary.bytes +=
                256 +
                (bucket.target.conv.length + message.id.length + (bucket.sessionId?.length ?? 0)) *
                  2;
            }
          }
          if (aligned && !offset && cache === summaries && summary.bytes <= capacity) {
            while (bytes + summary.bytes > capacity && summaries.size) {
              const first = summaries.keys().next().value!;
              bytes -= summaries.get(first)!.bytes;
              summaries.delete(first);
            }
            summaries.set(key, summary);
            bytes += summary.bytes;
          }
        }
        rows.push(
          ...[...summary.rows.values()].filter((row) => row.time >= start && row.time < end),
        );
      }
      return {
        rows,
        cursor: { bucket: index, offset: 0 },
        done: index >= buckets.length,
        progress: {
          phase: '生成对话月汇总',
          processed: index,
          total: buckets.length,
          unit: '个会话',
        },
      };
    },
  };
}

export function createCalendarSources(
  value: CalendarSourceContext,
  native: NtHelperBinding,
  check: () => void,
): CalendarSource[] {
  check();
  const kinds = [...new Set(value.targets.map((target) => target.kind))];
  return kinds.map((kind): CalendarSource => {
    const targets = value.targets.filter((target) => target.kind === kind);
    if (kind === 'persona' || kind === 'cloneGroup' || kind === 'assistant') {
      const source = generatedSource(kind, targets, value.services, check);
      return {
        ...source,
        page: (...args) => {
          check();
          return source.page(...args);
        },
      };
    }
    const table = tableFor[kind]!;
    const path =
      kind === 'guild'
        ? join(dirname(value.session.msgDbPath), 'guild_msg.db')
        : value.session.msgDbPath;
    const reader = new CalendarMetadataDb(
      new QqDb(native, {
        dbPath: path,
        key: value.session.context.dbKey,
        algo: algoFor(value.session.context, path),
      }),
      table,
    );
    value.readers.set(kind, reader);
    const convs = targets.map((target) => target.conv);
    const hidden = new Set(
      targets.flatMap((target) =>
        kind === 'c2c' || kind === 'group' || kind === 'dataline'
          ? value.services.msgs.getHiddenDeletedMsgIds(
              kind === 'group' ? 'group' : 'c2c',
              target.conv,
            )
          : [],
      ),
    );
    const ark = kind === 'official' || kind === 'service';
    const cached =
      (kind === 'c2c' || kind === 'group' || kind === 'dataline') &&
      value.services.gapHistory.hasCalendarCache();
    const cacheKind = kind === 'group' ? 'group' : 'c2c';
    let cachedTargets: Promise<CalendarTarget[]> | undefined;
    const getCachedTargets = () => {
      if (!cachedTargets)
        cachedTargets = value.services.gapHistory
          .calendarConversations()
          .then((rows) => {
            const ids = new Set(
              rows.filter((row) => row.kind === cacheKind).map((row) => row.conv),
            );
            return targets.filter((target) => ids.has(target.conv));
          })
          .catch((error: unknown) => {
            cachedTargets = undefined;
            throw error;
          });
      return cachedTargets;
    };
    type SourceCursor =
      | { phase: 'native'; native?: CalendarCursor; scanned?: number }
      | {
          phase: 'cached';
          target: number;
          cached?: { msgSeq: number; sendTime: number; msgId: string };
          scanned?: number;
        };
    let filterCachedDates = true;
    return {
      kind,
      ...(!ark
        ? {
            count: async (start: number, end: number) => {
              check();
              if (cached && (await getCachedTargets()).length) return null;
              return reader.count(convs, start, end, [...hidden]);
            },
          }
        : {}),
      async page(start, end, cursor, limit) {
        check();
        const state = cursor as SourceCursor | undefined;
        if (
          state?.phase === 'cached' &&
          (kind === 'c2c' || kind === 'group' || kind === 'dataline')
        ) {
          const cacheTargets = await getCachedTargets();
          const target = cacheTargets[state.target];
          if (!target) return { rows: [], done: true };
          const messages = await value.services.gapHistory
            .calendarPage(
              cacheKind,
              target.conv,
              limit,
              state.cached,
              filterCachedDates ? { start, end } : undefined,
            )
            .catch((error: unknown) => {
              // 缺少时间索引时空白日期可能扫过整个缓存；超预算后保持原游标走有界续查。
              if (!filterCachedDates || !String(error).includes('database_query_execution_timeout'))
                throw error;
              filterCachedDates = false;
              check();
              return value.services.gapHistory.calendarPage(
                cacheKind,
                target.conv,
                limit,
                state.cached,
              );
            });
          const matching = messages.filter(
            (message) => Number(message.sendTime) >= start && Number(message.sendTime) < end,
          );
          const local = matching.length
            ? await reader.localTimeline(
                target.conv,
                [...new Set(matching.map((message) => message.msgSeq))],
                kind === 'c2c' ? value.session.uidMap.sortNoByUid(target.conv) : undefined,
              )
            : [];
          const identity = (message: { msgSeq: string; msgRandom?: string; senderUid?: string }) =>
            message.msgRandom && message.senderUid
              ? `${message.msgSeq}:${message.msgRandom}:${message.senderUid}`
              : '';
          const localIds = new Set(local.map((message) => message.msgId));
          const localIdentities = new Set(local.map(identity).filter(Boolean));
          const merged = mergeRoamingTimeline<TimelineRow>(cacheKind, local, matching).filter(
            (message) =>
              message.source === 'roaming' &&
              !localIds.has(message.msgId) &&
              !localIdentities.has(identity(message)),
          );
          const last = messages.at(-1);
          const more = messages.length >= limit && last;
          const next: SourceCursor = more
            ? {
                phase: 'cached',
                target: state.target,
                cached: {
                  msgSeq: Number(last.msgSeq),
                  sendTime: Number(last.sendTime),
                  msgId: last.msgId,
                },
              }
            : { phase: 'cached', target: state.target + 1 };
          const scanned = (state.scanned ?? 0) + messages.length;
          next.scanned = scanned;
          return {
            rows: merged.map((message) => ({
              conv: target.conv,
              time: Number(message.sendTime),
              anchor: {
                id: timelineRowKey(message),
                seq: message.msgSeq,
                time: Number(message.sendTime),
              },
            })),
            cursor: next,
            done: next.target >= cacheTargets.length,
            progress: {
              phase: '漫游缓存',
              processed: next.target,
              total: cacheTargets.length,
              unit: '个会话',
              recordsScanned: scanned,
            },
          };
        }
        const page = await reader.page(
          start,
          end,
          state?.phase === 'native' ? state.native : undefined,
          limit,
          ark,
          convs.length === 1 ? convs[0] : undefined,
        );
        const scanned = (state?.phase === 'native' ? (state.scanned ?? 0) : 0) + page.scanned;
        return {
          cursor:
            page.done && cached
              ? { phase: 'cached', target: 0 }
              : { phase: 'native', native: page.cursor, scanned },
          done: page.done && !cached,
          progress: {
            phase: '本地元数据',
            processed: scanned,
            total: page.done ? scanned : undefined,
            unit: '条元数据',
          },
          rows: page.items
            .filter((row) => row.visible && !hidden.has(row.id))
            .map((row) => ({
              conv: row.conv,
              time: row.time,
              anchor: { id: row.id, seq: row.seq, time: row.time },
            })),
        };
      },
    };
  });
}
