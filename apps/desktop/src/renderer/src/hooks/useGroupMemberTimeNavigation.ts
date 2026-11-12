import { useEffect, useRef } from 'react';
import type { ProfilePerson } from './useContactCard';
import type { CalendarNavigate } from '../lib/calendarNavigation';
import { client } from '../trpc/client';
import { useQQWriteSession } from './useQQWriteSession';
import { useToast } from '../components/Toast';

/** 仅在点击时读取一个目标；发言严格匹配成员及 QQ 记录的秒级时间。 */
export function useGroupMemberTimeNavigation(
  person: ProfilePerson,
  navigate: CalendarNavigate | null,
  onNavigate?: () => void,
) {
  const group = person.profileContext;
  const uid = person.uid || person.id;
  const session = useQQWriteSession(`member-time:${group?.groupCode}:${uid}`, true);
  const key = JSON.stringify([session.binding, group?.groupCode, uid]);
  const latest = useRef(key);
  latest.current = key;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const running = useRef(false);
  return async (field: 'joinedAt' | 'lastSpeakAt') => {
    if (!group || !navigate || !session.binding || running.current) return;
    const member = { ...person, ...group.member };
    const time = Math.floor(Date.parse(member[field] ?? '') / 1000);
    if (!Number.isSafeInteger(time) || time <= 0) return;
    const binding = session.binding;
    running.current = true;
    try {
      let anchor: { id: string; seq: string; time: number } | null = null;
      if (field === 'joinedAt') {
        const found = await client.account.conversationBoundary.query({
          ...binding,
          kind: 'group',
          conv: group.groupCode,
          start: time,
        });
        if (found) anchor = { id: found.msgId, seq: found.msgSeq, time: found.sendTime };
      } else {
        const page = await client.account.browseConversation.query({
          ...binding,
          kind: 'group',
          conv: group.groupCode,
          filter: { start: time, end: time, sender: uid },
          limit: 1,
        });
        const found = page.items[0];
        if (found && BigInt(found.msgSeq) > 0n)
          anchor = { id: found.msgId, seq: found.msgSeq, time: Number(found.sendTime) };
      }
      if (!mounted.current || latest.current !== key) return;
      if (!anchor) {
        useToast
          .getState()
          .push({
            tone: 'info',
            title:
              field === 'joinedAt'
                ? '本地没有入群时间之后的消息'
                : '本地未找到该成员这次发言的消息',
          });
        return;
      }
      onNavigate?.();
      navigate(
        {
          kind: 'group',
          conv: group.groupCode,
          name: group.groupName,
          avatar: null,
          ancestors: [],
        },
        anchor,
      );
    } catch (error) {
      if (mounted.current && latest.current === key)
        useToast
          .getState()
          .push({
            tone: 'error',
            title: '定位失败',
            detail: error instanceof Error ? error.message : String(error),
          });
    } finally {
      running.current = false;
    }
  };
}
