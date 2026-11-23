import type { QueryClient } from '@tanstack/react-query';
import superjson from 'superjson';
import type { MessageWire } from '../views/workspace/types';
import { conversationWindowKey, type ConversationWindow } from './conversationWindowCache';
import { IS_WEB } from './target.shared';
import { reportVerifiedRemoteChat } from './remoteInstantBridge';

export const recentMessageCacheTag = 'weq-recent-message-windows-v1';
const queryKey = (scope: string) => [recentMessageCacheTag, scope] as const;
const TTL = 24 * 60 * 60_000;
const MAX_BYTES = 512 * 1024;

type Entry = {
  key: string;
  rows: MessageWire[];
  savedAt: number;
  bytes: number;
  hasOlder: boolean;
};

export function recentMessageEntries(client: QueryClient, scope: string, now = Date.now()) {
  return (client.getQueryData<Entry[]>(queryKey(scope)) ?? []).flatMap((entry) => {
    const expiresAt = entry.savedAt + TTL;
    return Array.isArray(entry.rows) && expiresAt >= now ? [{ ...entry, expiresAt }] : [];
  });
}

export function readRecentMessageCache(
  client: QueryClient,
  scope: string,
  key: string,
): ConversationWindow<MessageWire> | undefined {
  if (!IS_WEB) return undefined;
  const entry = client.getQueryData<Entry[]>(queryKey(scope))?.find((entry) => entry.key === key);
  if (
    !entry ||
    entry.savedAt + TTL < Date.now() ||
    !Array.isArray(entry.rows) ||
    !entry.rows.length
  )
    return undefined;
  return {
    rows: entry.rows,
    anchored: true,
    hasOlder: entry.hasOlder,
    hasNewer: false,
    revision: 0,
    dirty: true,
    storedAt: Date.now(),
    verifiedAt: 0,
  };
}

/** Only verified, actually opened windows are persisted, with no prefetched or optimistic rows. */
export function rememberRecentMessageCache(
  client: QueryClient,
  scope: string,
  kind: 'c2c' | 'group',
  conv: string,
  rows: MessageWire[],
  hasOlder: boolean,
) {
  if (!IS_WEB || !scope) return;
  reportVerifiedRemoteChat();
  const key = conversationWindowKey(scope, kind, conv);
  const existing = client.getQueryData<Entry[]>(queryKey(scope)) ?? [];
  const savedAt = Date.now();
  const retained = existing.filter((entry) => entry.key !== key && entry.savedAt + TTL >= savedAt);
  const tail = rows.slice(-50);
  const bytes = new TextEncoder().encode(superjson.stringify(tail)).byteLength;
  if (tail.length && bytes <= MAX_BYTES)
    retained.unshift({
      key,
      rows: tail,
      savedAt,
      bytes,
      hasOlder: hasOlder || rows.length > tail.length,
    });
  let total = 0;
  const bounded = retained.slice(0, 6).filter((entry) => {
    total += entry.bytes;
    return total <= MAX_BYTES;
  });
  client.setQueryData(queryKey(scope), bounded);
}
