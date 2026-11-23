import type { QueryClient } from '@tanstack/react-query';
import type { Conversation } from '../im-template/template/types';
import { timelineRowKey } from '../../../shared/roaming_timeline';
import { messageBody } from '../views/workspace/messageProjection';
import { conversationRowName } from './conversationViews';
import { recentMessageCacheTag, recentMessageEntries } from './recentMessageCache';
import {
  clearRemoteInstant,
  instantNativeNotify,
  type InstantSnapshot,
} from './remoteInstantBridge';

export function instantChatEligible(row: Conversation): boolean {
  return (
    row.type !== 'merged' &&
    !row.generated &&
    !row.hidden &&
    !row.deleted &&
    (!row.directoryKind || row.directoryKind === 'qq')
  );
}

export function instantChatRows(
  cache: QueryClient,
  scope: string,
  conversations: readonly Conversation[],
  selfUin: string,
  selfUid?: string,
): InstantSnapshot['chats'] {
  const windows = recentMessageEntries(cache, scope);
  const byKey = new Map<string, Conversation>();
  if (!windows.length) return;
  for (const row of conversations) {
    if (instantChatEligible(row))
      byKey.set(JSON.stringify([scope, row.type === 'group' ? 'group' : 'c2c', row.id]), row);
  }
  return windows.slice(0, 6).flatMap(({ key, rows, expiresAt }) => {
    const conversation = byKey.get(key);
    if (!conversation) return [];
    const ids = new Set<string>();
    const preview = rows.slice(-24).flatMap((row) => {
      if (row.deletedKind || row.recall || !Array.isArray(row.elements)) return [];
      const text = messageBody(row.elements).trim().slice(0, 360);
      const id = timelineRowKey(row);
      if (!text || ids.has(id)) return [];
      ids.add(id);
      return [
        {
          id,
          text,
          mine: row.senderUin === selfUin || Boolean(selfUid && row.senderUid === selfUid),
        },
      ];
    });
    return preview.length
      ? [
          {
            id: conversation.id,
            title: conversationRowName(conversation).slice(0, 120),
            expiresAt,
            rows: preview,
          },
        ]
      : [];
  });
}

export function watchRemoteInstant(
  cache: QueryClient,
  scope: string | null,
  project: () => InstantSnapshot['chats'],
): (() => void) | undefined {
  const notify = instantNativeNotify();
  if (!notify) return;
  const publish = (next: InstantSnapshot) => {
    window.weqRemoteInstantSnapshot = next;
    notify();
  };
  if (!scope) {
    clearRemoteInstant();
    return;
  }
  if (window.weqRemoteInstantSnapshot?.scope !== scope) publish({ scope });
  let encoded = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    const chats = project();
    if (!chats) return;
    const value = JSON.stringify(chats);
    if (value !== encoded) {
      encoded = value;
      publish({ scope, chats });
    }
  };
  const stop = cache.getQueryCache().subscribe((event) => {
    if (event.query.queryKey[0] !== recentMessageCacheTag || event.query.queryKey[1] !== scope)
      return;
    timer ??= setTimeout(flush, 300);
  });
  timer = setTimeout(flush, 0);
  window.addEventListener('pagehide', flush);
  const visibility = () => {
    if (document.visibilityState === 'hidden') flush();
  };
  document.addEventListener('visibilitychange', visibility);
  return () => {
    clearTimeout(timer);
    stop();
    window.removeEventListener('pagehide', flush);
    document.removeEventListener('visibilitychange', visibility);
  };
}
