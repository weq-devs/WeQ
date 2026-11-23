import { hashQueryKey, type DehydratedState, type QueryClient } from '@tanstack/react-query';
import superjson from 'superjson';
import type { MessageWire } from '../views/workspace/types';
import { conversationWindowKey, type ConversationWindow } from './conversationWindowCache';
import { IS_WEB } from './target.shared';
import { isRemoteClient } from './remoteClient';

export const recentMessageCacheTag = 'weq-recent-message-windows-v1';
export const recentMessageIndexTag = 'index';
export const recentMessageWindowTag = 'window';
const queryKey = (scope: string) => [recentMessageCacheTag, scope] as const;
const indexKey = (scope: string) => [...queryKey(scope), recentMessageIndexTag] as const;
const windowKey = (scope: string, key: string) =>
  [...queryKey(scope), recentMessageWindowTag, key] as const;
const TTL = 24 * 60 * 60_000;
const MAX_BYTES = 512 * 1024;

type Entry = {
  key: string;
  rows: MessageWire[];
  savedAt: number;
  bytes: number;
  hasOlder: boolean;
};

function validMessageRow(row: MessageWire | null | undefined): row is MessageWire {
  return (
    !!row &&
    typeof row.msgId === 'string' &&
    typeof row.msgSeq === 'string' &&
    typeof row.senderUid === 'string' &&
    typeof row.senderUin === 'string' &&
    typeof row.sendTime === 'string' &&
    Array.isArray(row.elements) &&
    row.elements.every(
      (element) =>
        !!element &&
        typeof element === 'object' &&
        'type' in element &&
        typeof element.type === 'string',
    ) &&
    (row.setEmojiList === undefined || Array.isArray(row.setEmojiList))
  );
}

function validEntry(entry: Entry | null | undefined): entry is Entry {
  return (
    !!entry &&
    typeof entry.key === 'string' &&
    Number.isFinite(entry.savedAt) &&
    Number.isFinite(entry.bytes) &&
    typeof entry.hasOlder === 'boolean' &&
    Array.isArray(entry.rows)
  );
}

/** 原生桥仍收单份消息快照，跨页面来源也能继续读取旧格式。 */
export function legacyRecentMessageState(state: DehydratedState): DehydratedState {
  const index = state.queries.find(({ queryKey }) => queryKey[2] === recentMessageIndexTag);
  if (!index || !Array.isArray(index.state.data)) return state;
  const windows = new Map(
    state.queries
      .filter(({ queryKey }) => queryKey[2] === recentMessageWindowTag)
      .map((query) => [query.queryKey[3], query]),
  );
  const entries = [];
  let dataUpdatedAt = index.state.dataUpdatedAt;
  for (const id of index.state.data) {
    const window = windows.get(id);
    if (!window) continue;
    entries.push(window.state.data);
    dataUpdatedAt = Math.max(dataUpdatedAt, window.state.dataUpdatedAt);
  }
  const key = index.queryKey.slice(0, 2);
  return {
    mutations: [],
    queries: [
      {
        queryKey: key,
        queryHash: hashQueryKey(key),
        state: { ...index.state, data: entries, dataUpdatedAt },
      },
    ],
  };
}

export function readRecentMessageCache(
  client: QueryClient,
  scope: string,
  key: string,
): ConversationWindow<MessageWire> | undefined {
  if (!IS_WEB) return undefined;
  const index = client.getQueryData<string[]>(indexKey(scope));
  const legacy = client.getQueryData<Entry[]>(queryKey(scope));
  const entry = Array.isArray(index)
    ? index.includes(key)
      ? client.getQueryData<Entry>(windowKey(scope, key))
      : undefined
    : Array.isArray(legacy)
      ? legacy.find((entry) => entry?.key === key)
      : undefined;
  if (!validEntry(entry) || (!isRemoteClient() && entry.savedAt + TTL < Date.now()))
    return undefined;
  const rows = entry.rows.filter(validMessageRow);
  if (!rows.length) return undefined;
  return {
    rows,
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
  const key = conversationWindowKey(scope, kind, conv);
  const index = client.getQueryData<string[]>(indexKey(scope));
  const legacy = client.getQueryData<Entry[]>(queryKey(scope));
  const existing = Array.isArray(index)
    ? index.flatMap((id) => {
        const entry = client.getQueryData<Entry>(windowKey(scope, id));
        return entry ? [entry] : [];
      })
    : Array.isArray(legacy)
      ? legacy
      : [];
  const savedAt = Date.now();
  const keepOffline = isRemoteClient();
  const retained = existing.filter(
    (entry) =>
      validEntry(entry) && entry.key !== key && (keepOffline || entry.savedAt + TTL >= savedAt),
  );
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
  const next = bounded.map((entry) => entry.key);
  for (const entry of bounded) {
    const key = windowKey(scope, entry.key);
    if (client.getQueryData(key) !== entry) client.setQueryData(key, entry);
  }
  client.setQueryData(indexKey(scope), next);
  for (const id of Array.isArray(index) ? index : [])
    if (!next.includes(id)) client.removeQueries({ queryKey: windowKey(scope, id), exact: true });
  client.removeQueries({ queryKey: queryKey(scope), exact: true });
}
