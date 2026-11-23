import {
  dehydrate,
  hydrate,
  type DehydratedState,
  type QueryClient,
  type QueryKey,
} from '@tanstack/react-query';
import {
  legacyRecentMessageState,
  recentMessageCacheTag,
  recentMessageIndexTag,
  recentMessageWindowTag,
} from './recentMessageCache';
import superjson from 'superjson';
import {
  boundedBridgeReply,
  remoteCacheBridge,
  remoteCacheSupportsRecords,
  sharedAccountScope,
} from './remoteCacheBridge';
import {
  MESSAGE_SCOPE_PREFIX,
  isMessageScope,
  localBusinessCache,
  type BusinessCacheDelta,
  type BusinessCacheStore,
  type BusinessSnapshot,
} from './webBusinessCacheStore';

export type { BusinessCacheStore, BusinessSnapshot } from './webBusinessCacheStore';

const MAX_ROWS = 10_000;
const MAX_QUERIES = 160;
const writerId = Math.random().toString(36).slice(2);
let commitSequence = 0;
function nativeScope(scope: string) {
  return isMessageScope(scope)
    ? {
        kind: 'messages' as const,
        account: sharedAccountScope(scope.slice(MESSAGE_SCOPE_PREFIX.length)),
      }
    : { kind: 'business' as const, account: sharedAccountScope(scope) };
}
const procedures = new Set([
  'getSelfProfile',
  'listBuddies',
  'listCategories',
  'listProfiles',
  'listAllGroups',
  'listRecentContacts',
  'listTopContacts',
  'listHiddenSessions',
  'listDeletedSessions',
  'listOfficialAccounts',
  'listServiceAccounts',
  'guildDirectListSessions',
  'botUids',
  'listAgentLabPersonas',
  'listAgentLabGroups',
  'listAssistantSessions',
]);
const additionalProcedures = [
  'getSystemFaces',
  'listBuddyRequests',
  'listGroupNotifies',
  'specialCare',
  'contactMetrics.snapshot',
  'emojiPanel.overview',
  'emojiPanel.catalog',
  'emojiPanel.favorites',
  'emojiPanel.marketPackages',
  'emojiPanel.marketPackDetail',
  'emojiPanel.relatedGifs',
  'emojiPanel.showEmojiCatalog',
  'emojiPanel.customEmojiRecent',
  'emojiPanel.recentReactions',
  'marketEmoji.searchCatalog',
  'qqActions.favorites',
] as const;
const additionalPaths = new Set<string>(additionalProcedures);
const browsedPaths = new Set([
  'emojiPanel.marketPackDetail',
  'emojiPanel.relatedGifs',
  'marketEmoji.searchCatalog',
]);

/** 仅 Web 使用：恢复的数据立即可见，过期后在实际打开对应面板时后台刷新。 */
export function configureBusinessCache(client: QueryClient): void {
  for (const path of additionalProcedures)
    client.setQueryDefaults([['account', ...path.split('.')]], {
      staleTime: 60_000,
      refetchOnMount: true,
    });
}

export const resolvedProfilesKey = ['weq-business-resolved-profiles'] as const;

function nativeSnapshot(payload: unknown): BusinessSnapshot | undefined {
  if (typeof payload === 'string') return superjson.parse<BusinessSnapshot>(payload);
  if (!payload || typeof payload !== 'object') return undefined;
  const value = payload as { scope?: unknown; savedAt?: unknown; records?: unknown };
  if (
    typeof value.scope !== 'string' ||
    typeof value.savedAt !== 'number' ||
    !Array.isArray(value.records) ||
    value.records.length > MAX_QUERIES
  )
    return undefined;
  const queries: SavedQuery[] = [];
  const keys = new Set<string>();
  for (const record of value.records) {
    if (
      typeof record?.key !== 'string' ||
      typeof record.payload !== 'string' ||
      keys.has(record.key)
    )
      return undefined;
    const query = superjson.parse<SavedQuery>(record.payload);
    if (query?.queryHash !== record.key) return undefined;
    keys.add(record.key);
    queries.push(query);
  }
  return { scope: value.scope, savedAt: value.savedAt, state: { mutations: [], queries } };
}

async function putNativeRecords(
  bridge: NonNullable<ReturnType<typeof remoteCacheBridge>>,
  account: string,
  kind: 'business' | 'messages',
  snapshot: BusinessSnapshot,
  delta?: BusinessCacheDelta,
): Promise<void> {
  const queries = snapshot.state.queries;
  const revision = delta?.revision ?? `${writerId}:${++commitSequence}`;
  const keys = queries.map(({ queryHash }) => queryHash);
  const write = (base?: string) =>
    bridge.postMessage({
      action: 'putRecords',
      kind,
      scope: account,
      savedAt: snapshot.savedAt,
      revision,
      ...(base === undefined ? {} : { base }),
      keys,
      records: queries
        .filter((query) => !base || delta?.changed.has(query.queryHash))
        .map((query) => ({ key: query.queryHash, payload: superjson.stringify(query) })),
    });
  const result = await write(delta?.base);
  if (delta?.base && result === 'needsFull') await write();
}

export const businessCacheStore: BusinessCacheStore = {
  async get(scope) {
    const local = localBusinessCache.get(scope);
    const bridge = remoteCacheBridge();
    const { account, kind } = nativeScope(scope);
    if (!bridge || !account) return local;
    const current = await local.catch(() => undefined);
    const payload = await boundedBridgeReply(
      bridge.postMessage({
        action: remoteCacheSupportsRecords() ? 'getRecords' : 'get',
        kind,
        scope: account,
        newerThan: current?.savedAt ?? 0,
      }),
    );
    if (!payload) return current;
    try {
      const read = nativeSnapshot(payload);
      if (
        read?.scope === account &&
        Number.isFinite(read.savedAt) &&
        read.savedAt > (current?.savedAt ?? 0)
      ) {
        const restored = { ...read, scope };
        void localBusinessCache.put(restored).catch(() => undefined);
        return restored;
      }
    } catch {
      /* An unreadable mirror doesn't replace IndexedDB. */
    }
    return current;
  },
  async put(snapshot, delta) {
    const bridge = remoteCacheBridge();
    const { account, kind } = nativeScope(snapshot.scope);
    await Promise.all([
      localBusinessCache.put(snapshot, delta),
      bridge &&
        account &&
        Promise.resolve()
          .then(() =>
            remoteCacheSupportsRecords()
              ? putNativeRecords(bridge, account, kind, snapshot, delta)
              : bridge.postMessage({
                  action: 'put',
                  kind,
                  scope: account,
                  savedAt: snapshot.savedAt,
                  payload: superjson.stringify({
                    ...snapshot,
                    scope: account,
                    state:
                      kind === 'messages'
                        ? legacyRecentMessageState(snapshot.state)
                        : snapshot.state,
                  }),
                }),
          )
          .catch(() => undefined),
    ]);
  },
};

function persisted(key: QueryKey, scope: string): boolean {
  const path = key[0];
  if (isMessageScope(scope)) {
    const directory = scope.slice(MESSAGE_SCOPE_PREFIX.length);
    return (
      path === recentMessageCacheTag && key[1] === (sharedAccountScope(directory) ?? directory)
    );
  }
  return (
    key[0] === resolvedProfilesKey[0] ||
    (Array.isArray(path) &&
      path[0] === 'account' &&
      ((path.length === 2 && procedures.has(path[1])) ||
        additionalPaths.has(path.slice(1).join('.'))))
  );
}

export async function restoreBusinessCache(
  client: QueryClient,
  scope: string,
  store = businessCacheStore,
  current = () => true,
): Promise<void> {
  const restore = async (scope: string) => {
    const value = await store.get(scope);
    if (!current() || value?.scope !== scope || !Array.isArray(value.state?.queries)) return;
    // 仅恢复明确允许的目录项，不恢复 mutation、错误或账号配置。
    const queries = value.state.queries.filter(
      (query) =>
        Array.isArray(query.queryKey) &&
        persisted(query.queryKey, scope) &&
        query.state?.status === 'success' &&
        Number.isFinite(query.state.dataUpdatedAt),
    );
    hydrate(client, { mutations: [], queries });
  };
  // 任一存储损坏时，另一份快照仍可以恢复。
  await Promise.allSettled([restore(scope), restore(MESSAGE_SCOPE_PREFIX + scope)]);
}

function boundedData(data: unknown): unknown {
  if (Array.isArray(data)) return data.length > MAX_ROWS ? data.slice(0, MAX_ROWS) : data;
  if (data && typeof data === 'object' && 'pages' in data && Array.isArray(data.pages)) {
    let rows = 0;
    const pages = data.pages.filter((page: { items?: unknown[] }) => {
      if (rows >= MAX_ROWS) return false;
      rows += page.items?.length ?? 0;
      return true;
    });
    return {
      ...data,
      pages,
      ...('pageParams' in data && Array.isArray(data.pageParams)
        ? { pageParams: data.pageParams.slice(0, pages.length) }
        : {}),
    };
  }
  return data;
}

type SavedQuery = DehydratedState['queries'][number];
function normalizedQuery(query: SavedQuery): SavedQuery {
  return {
    ...query,
    state: {
      ...query.state,
      data: boundedData(query.state.data),
      status: 'success',
      fetchStatus: 'idle',
      error: null,
      fetchFailureCount: 0,
      fetchFailureReason: null,
    },
  };
}

export function watchBusinessCache(
  client: QueryClient,
  scope: string,
  store = businessCacheStore,
): () => Promise<void> {
  const stopDirectory = watchSnapshot(client, scope, store);
  const stopMessages = watchSnapshot(client, MESSAGE_SCOPE_PREFIX + scope, store);
  return async () => {
    await Promise.all([stopDirectory(), stopMessages()]);
  };
}

/** 正文和目录分开写盘，聊天更新不会重复拷贝整份联系人目录。 */
function watchSnapshot(client: QueryClient, scope: string, store: BusinessCacheStore) {
  const retained = new Map<string, { source: SavedQuery; saved?: SavedQuery }>(
    dehydrate(client, {
      shouldDehydrateQuery: (query) =>
        persisted(query.queryKey, scope) && query.state.data !== undefined,
    }).queries.map((query) => [query.queryHash, { source: query }]),
  );
  const trim = () => {
    while (retained.size > MAX_QUERIES) {
      // 先淘汰浏览记录，不让大量包详情或搜索挤掉联系人及表情主目录。
      const victim = [...retained.values()].find(({ source: query }) => {
        const path = query.queryKey[0];
        return Array.isArray(path) && browsedPaths.has(path.slice(1).join('.'));
      });
      retained.delete(victim?.source.queryHash ?? retained.keys().next().value!);
    }
  };
  trim();
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let idle: number | undefined;
  let writing = Promise.resolve();
  let base: string | undefined;
  let savedAt = 0;
  const flush = () => {
    if (timer !== undefined) clearTimeout(timer);
    if (idle !== undefined) window.cancelIdleCallback(idle);
    timer = undefined;
    idle = undefined;
    if (dirty) {
      if (isMessageScope(scope)) {
        const index = [...retained.values()].find(
          ({ source: query }) => query.queryKey[2] === recentMessageIndexTag,
        );
        if (Array.isArray(index?.source.state.data)) {
          const windows = new Set(index.source.state.data);
          for (const [hash, { source: query }] of retained) {
            if (
              query.queryKey.length === 2 ||
              (query.queryKey[2] === recentMessageWindowTag && !windows.has(query.queryKey[3]))
            )
              retained.delete(hash);
          }
        }
      }
      const changed = new Set<string>();
      const queries = [...retained.values()].map((item) => {
        if (!item.saved) {
          item.saved = normalizedQuery(item.source);
          changed.add(item.source.queryHash);
        }
        return item.saved;
      });
      const revision = `${writerId}:${++commitSequence}`;
      const delta = { base, revision, changed };
      base = revision;
      savedAt = Math.max(Date.now(), savedAt + 1);
      const snapshot = { scope, savedAt, state: { mutations: [], queries } };
      dirty = false;
      // 只有上一版本已提交才可增量写入；事务失败或其他页面抢先写入时重建索引。
      writing = writing.then(() => store.put(snapshot, delta)).catch(() => {});
    }
    return writing;
  };
  const unsubscribe = client.getQueryCache().subscribe((event) => {
    if (
      event.type !== 'updated' ||
      event.action.type !== 'success' ||
      !persisted(event.query.queryKey, scope)
    )
      return;
    const { queryHash, queryKey, state } = event.query;
    if (retained.get(queryHash)?.source.state.data === state.data) return;
    // 成功事件只保存该查询的状态，空闲时才裁剪、复制实际变动的查询。
    retained.delete(queryHash);
    retained.set(queryHash, {
      source: { queryHash, queryKey, state },
    });
    trim();
    dirty = true;
    if (timer === undefined)
      timer = setTimeout(() => {
        if (window.requestIdleCallback)
          idle = window.requestIdleCallback(
            () => {
              void flush();
            },
            { timeout: 2000 },
          );
        else void flush();
      }, 1000);
  });
  const onHide = () => {
    void flush();
  };
  window.addEventListener('pagehide', onHide);
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') void flush();
  };
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    unsubscribe();
    window.removeEventListener('pagehide', onHide);
    document.removeEventListener('visibilitychange', onVisibility);
    return flush();
  };
}
