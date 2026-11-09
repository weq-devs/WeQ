import { dirname, join } from 'node:path';
import { algoFor, type AccountSession } from '@weq/account';
import type { NtHelperBinding } from '@weq/native';
import { CalendarMetadataDb, QqDb, type CalendarCursor, type CalendarTable } from '@weq/db';
import { mergeRoamingTimeline, timelineRowKey, type TimelineRow } from '../common/roaming_timeline';
import type { CalendarSource, CalendarTarget, CalendarKind } from './conversation_calendar';
import type { MsgService } from './msg';
import type { GapHistoryService } from './gap_history';
import type { AgentLabService } from './agentlab';

export interface CalendarSourceServices {
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
  if (target.kind === 'persona')
    return sessionId === null
      ? lab.getConversation(target.conv)
      : lab.getPersonaSessionConversation(target.conv, sessionId);
  return sessionId === null
    ? lab.getGroupMessages(target.conv)
    : lab.getGroupSessionConversation(target.conv, sessionId);
}

function generatedSource(
  kind: 'persona' | 'cloneGroup',
  targets: CalendarTarget[],
  services: CalendarSourceServices,
): CalendarSource {
  const buckets = targets.flatMap((target) => {
    const list =
      kind === 'persona'
        ? services.agentLab.listPersonaSessions(target.conv)
        : services.agentLab.listGroupSessions(target.conv);
    return [
      { target, sessionId: null as string | null },
      ...list.map((session) => ({ target, sessionId: session.id as string | null })),
    ];
  });
  return {
    kind,
    async page(_start, _end, raw, limit) {
      const cursor = (raw ?? { bucket: 0, offset: 0 }) as { bucket: number; offset: number };
      const bucket = buckets[cursor.bucket];
      if (!bucket) return { rows: [], done: true };
      const messages = generatedMessages(services, bucket.target, bucket.sessionId);
      const rows = messages.slice(cursor.offset, cursor.offset + limit).flatMap((message) =>
        message.id && !bucket.target.hiddenIds?.[bucket.sessionId ?? 'draft']?.includes(message.id)
          ? [
              {
                conv: bucket.target.conv,
                time: message.ts / 1000,
                anchor: {
                  id: message.id,
                  seq: '',
                  time: message.ts / 1000,
                  sessionId: bucket.sessionId,
                },
              },
            ]
          : [],
      );
      const next =
        cursor.offset + limit < messages.length
          ? { ...cursor, offset: cursor.offset + limit }
          : { bucket: cursor.bucket + 1, offset: 0 };
      return { rows, cursor: next, done: next.bucket >= buckets.length };
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
    if (kind === 'persona' || kind === 'cloneGroup') {
      const source = generatedSource(kind, targets, value.services);
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
      | { phase: 'native'; native?: CalendarCursor }
      | {
          phase: 'cached';
          target: number;
          cached?: { msgSeq: number; sendTime: number; msgId: string };
        };
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
          const messages = await value.services.gapHistory.calendarPage(
            cacheKind,
            target.conv,
            limit,
            state.cached,
          );
          const local = await reader.localTimeline(
            target.conv,
            [...new Set(messages.map((message) => message.msgSeq))],
            kind === 'c2c' ? value.session.uidMap.sortNoByUid(target.conv) : undefined,
          );
          const identity = (message: { msgSeq: string; msgRandom?: string; senderUid?: string }) =>
            message.msgRandom && message.senderUid
              ? `${message.msgSeq}:${message.msgRandom}:${message.senderUid}`
              : '';
          const localIds = new Set(local.map((message) => message.msgId));
          const localIdentities = new Set(local.map(identity).filter(Boolean));
          const merged = mergeRoamingTimeline<TimelineRow>(cacheKind, local, messages).filter(
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
          };
        }
        const page = await reader.page(
          start,
          end,
          state?.phase === 'native' ? state.native : undefined,
          limit,
          ark,
        );
        return {
          cursor:
            page.done && cached
              ? { phase: 'cached', target: 0 }
              : { phase: 'native', native: page.cursor },
          done: page.done && !cached,
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
