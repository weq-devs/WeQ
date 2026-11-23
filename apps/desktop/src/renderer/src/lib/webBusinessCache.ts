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
import type { QQWriteBinding } from '../hooks/useQQWriteSession';
import { isProfileCacheQuery } from './profileQuery';
import {
  currentRemoteDataCacheStatus,
  getRemoteCacheQueries,
  putRemoteCacheQueries,
  remoteDataCacheStatus,
} from './remoteDataCache';
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
const qzoneHomePath = ['account', 'qqActions', 'qzoneHome'] as const;
export const PROFILE_SCOPE_PREFIX = 'profiles:';
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
  client.setQueryDefaults([qzoneHomePath], {
    refetchOnMount: (query) => query.state.isInvalidated,
  });
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

const legacyBusinessCacheStore: BusinessCacheStore = {
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

export const businessCacheStore: BusinessCacheStore = {
  async get(scope) {
    const status = await remoteDataCacheStatus();
    if (!status) return legacyBusinessCacheStore.get(scope);
    const queries = await getRemoteCacheQueries<SavedQuery>(scope);
    const migration = `weq.remote-cache.migrated:${scope}`;
    const migrated = () => {
      try {
        localStorage.setItem(migration, '1');
      } catch {}
      void localBusinessCache.remove(scope).catch(() => {});
    };
    let wasMigrated = false;
    try {
      wasMigrated = localStorage.getItem(migration) === '1';
    } catch {}
    if (queries?.length || status.cleared || wasMigrated) {
      if (!status.cleared && queries?.length) migrated();
      return queries?.length
        ? {
            scope,
            savedAt: Math.max(...queries.map((query) => query.state.dataUpdatedAt)),
            state: { queries, mutations: [] },
          }
        : undefined;
    }
    const legacy = await legacyBusinessCacheStore.get(scope);
    if (!legacy) {
      migrated();
      return undefined;
    }
    void putRemoteCacheQueries(
      scope,
      legacy.state.queries,
      (query) => query.queryHash,
      status,
    ).then((saved) => {
      if (saved) migrated();
    });
    return legacy;
  },
  async put(snapshot, delta) {
    const status = await remoteDataCacheStatus();
    if (!status) return legacyBusinessCacheStore.put(snapshot, delta);
    const queries = delta?.base
      ? snapshot.state.queries.filter((query) => delta.changed.has(query.queryHash))
      : snapshot.state.queries;
    await putRemoteCacheQueries(snapshot.scope, queries, (query) => query.queryHash, status);
  },
};

function scopeBinding(scope: string): QQWriteBinding | undefined {
  const account = sharedAccountScope(scope);
  if (!account) return undefined;
  try {
    const binding: unknown = JSON.parse(account);
    if (
      Array.isArray(binding) &&
      binding.length === 2 &&
      typeof binding[0] === 'string' &&
      typeof binding[1] === 'string'
    ) {
      return { expectedAccountUin: binding[0], expectedAccountConfigId: binding[1] };
    }
  } catch {
    /* Legacy scopes may be opaque. */
  }
  return undefined;
}

function isQzoneHomeQuery(key: QueryKey) {
  const [path, target] = key;
  return (
    Array.isArray(path) &&
    path.length === qzoneHomePath.length &&
    qzoneHomePath.every((part, index) => part === path[index]) &&
    (target as { type?: string } | undefined)?.type === 'infinite'
  );
}

function persistedQueries(scope: string) {
  const profileOnly = scope.startsWith(PROFILE_SCOPE_PREFIX);
  const binding = scopeBinding(profileOnly ? scope.slice(PROFILE_SCOPE_PREFIX.length) : scope);
  const profile = (key: QueryKey) => !!binding && isProfileCacheQuery(key, binding);
  if (isMessageScope(scope)) {
    const directory = scope.slice(MESSAGE_SCOPE_PREFIX.length);
    const account = sharedAccountScope(directory) ?? directory;
    return {
      profile,
      matches: (key: QueryKey) => key[0] === recentMessageCacheTag && key[1] === account,
    };
  }
  if (profileOnly) return { profile, matches: profile };
  return {
    profile,
    matches: (key: QueryKey) => {
      if (isQzoneHomeQuery(key)) {
        const { input } = key[1] as { input?: Partial<QQWriteBinding> & { hostUin?: string } };
        return (
          !!binding &&
          input?.hostUin === binding.expectedAccountUin &&
          input.expectedAccountUin === binding.expectedAccountUin &&
          input.expectedAccountConfigId === binding.expectedAccountConfigId
        );
      }
      const path = key[0];
      return (
        path === resolvedProfilesKey[0] ||
        (Array.isArray(path) &&
          path[0] === 'account' &&
          ((path.length === 2 && procedures.has(path[1])) ||
            additionalPaths.has(path.slice(1).join('.')))) ||
        profile(key)
      );
    },
  };
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
    const { matches, profile } = persistedQueries(scope);
    // 恢复成功数据，名片与本人空间主页打开时再校准旧值。
    const queries = value.state.queries
      .filter(
        (query) =>
          Array.isArray(query.queryKey) &&
          matches(query.queryKey) &&
          query.state?.status === 'success' &&
          Number.isFinite(query.state.dataUpdatedAt),
      )
      .map((query) =>
        profile(query.queryKey) || isQzoneHomeQuery(query.queryKey)
          ? { ...query, state: { ...query.state, isInvalidated: true } }
          : query,
      );
    hydrate(client, { mutations: [], queries });
  };
  // 任一存储损坏时，另一份快照仍可以恢复。
  await Promise.allSettled(
    scope.startsWith(PROFILE_SCOPE_PREFIX)
      ? [restore(scope)]
      : [restore(scope), restore(MESSAGE_SCOPE_PREFIX + scope)],
  );
}

function boundedData(data: unknown, pageLimit = Number.POSITIVE_INFINITY): unknown {
  const maxRows = currentRemoteDataCacheStatus() ? Number.POSITIVE_INFINITY : MAX_ROWS;
  if (Array.isArray(data)) return data.length > maxRows ? data.slice(0, maxRows) : data;
  if (data && typeof data === 'object' && 'pages' in data && Array.isArray(data.pages)) {
    let rows = 0;
    const pages = data.pages.filter((page: { items?: unknown[] }, index) => {
      if (index >= pageLimit || rows >= maxRows) return false;
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
      // 只恢复主页首屏，重新加载时无需顺序回源所有历史页。
      data: boundedData(query.state.data, isQzoneHomeQuery(query.queryKey) ? 1 : undefined),
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
  if (scope.startsWith(PROFILE_SCOPE_PREFIX)) return stopDirectory;
  const stopMessages = watchSnapshot(client, MESSAGE_SCOPE_PREFIX + scope, store);
  return async () => {
    await Promise.all([stopDirectory(), stopMessages()]);
  };
}

/** 正文和目录分开写盘，聊天更新不会重复拷贝整份联系人目录。 */
function watchSnapshot(client: QueryClient, scope: string, store: BusinessCacheStore) {
  const { matches, profile } = persistedQueries(scope);
  const retained = new Map<string, { source: SavedQuery; saved?: SavedQuery }>(
    dehydrate(client, {
      shouldDehydrateQuery: (query) => matches(query.queryKey) && query.state.data !== undefined,
    }).queries.map((query) => [query.queryHash, { source: query }]),
  );
  const trim = () => {
    if (currentRemoteDataCacheStatus()) return;
    while (retained.size > MAX_QUERIES) {
      // 先淘汰浏览记录，保留主目录和设置。
      const victim = [...retained.values()].find(({ source: query }) => {
        const path = query.queryKey[0];
        return (
          (profile(query.queryKey) && path !== 'contact-card-settings') ||
          (Array.isArray(path) && browsedPaths.has(path.slice(1).join('.')))
        );
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
      !matches(event.query.queryKey)
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
