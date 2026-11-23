import {
  dehydrate,
  hydrate,
  type DehydratedState,
  type QueryClient,
  type QueryKey,
} from '@tanstack/react-query';
import { recentMessageCacheTag } from './recentMessageCache';
import superjson from 'superjson';
import { boundedBridgeRead, remoteCacheBridge, sharedAccountScope } from './remoteCacheBridge';

const MAX_PARTITIONS = 4;
const MAX_ROWS = 10_000;
const MAX_QUERIES = 160;
const MESSAGE_SCOPE_PREFIX = 'messages:';
const isMessageScope = (scope: string) => scope.startsWith(MESSAGE_SCOPE_PREFIX);
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
export interface BusinessSnapshot {
  scope: string;
  savedAt: number;
  state: DehydratedState;
}
export interface BusinessCacheStore {
  get(scope: string): Promise<BusinessSnapshot | undefined>;
  put(snapshot: BusinessSnapshot): Promise<void>;
}

let database: Promise<IDBDatabase> | undefined;
function openDatabase(): Promise<IDBDatabase> {
  if (!database) {
    database = new Promise<IDBDatabase>((resolve, reject) => {
      let failed = false;
      const request = window.indexedDB.open('weq-business-cache', 1);
      request.onupgradeneeded = () => {
        request.result
          .createObjectStore('snapshots', { keyPath: 'scope' })
          .createIndex('savedAt', 'savedAt');
      };
      request.onsuccess = () => {
        const db = request.result;
        if (failed) {
          db.close();
          return;
        }
        db.onversionchange = () => {
          db.close();
          database = undefined;
        };
        resolve(db);
      };
      request.onerror = request.onblocked = () => {
        failed = true;
        reject(new Error('业务缓存不可用'));
      };
    }).catch((error) => {
      database = undefined;
      throw error;
    });
  }
  return database;
}

const localBusinessCache: BusinessCacheStore = {
  async get(scope) {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const request = db.transaction('snapshots').objectStore('snapshots').get(scope);
      request.onsuccess = () => resolve(request.result as BusinessSnapshot | undefined);
      request.onerror = () => reject(new Error('业务缓存读取失败'));
    });
  },
  async put(snapshot) {
    const db = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('snapshots', 'readwrite');
      const store = tx.objectStore('snapshots');
      store.put(snapshot);
      const retained = { messages: 0, directory: 0 };
      const cursor = store.index('savedAt').openCursor(null, 'prev');
      cursor.onsuccess = () => {
        if (!cursor.result) return;
        const bucket = isMessageScope(String(cursor.result.primaryKey)) ? 'messages' : 'directory';
        if (++retained[bucket] > MAX_PARTITIONS) cursor.result.delete();
        cursor.result.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(new Error('业务缓存保存失败'));
    });
  },
};

export const businessCacheStore: BusinessCacheStore = {
  async get(scope) {
    const local = localBusinessCache.get(scope);
    const bridge = remoteCacheBridge();
    const { account, kind } = nativeScope(scope);
    if (!bridge || !account) return local;
    const current = await local.catch(() => undefined);
    const payload = await boundedBridgeRead(
      bridge.postMessage({ action: 'get', kind, scope: account, newerThan: current?.savedAt ?? 0 }),
    );
    if (!payload) return current;
    try {
      const read = superjson.parse<BusinessSnapshot>(payload);
      if (
        read.scope === account &&
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
  async put(snapshot) {
    const bridge = remoteCacheBridge();
    const { account, kind } = nativeScope(snapshot.scope);
    await Promise.all([
      localBusinessCache.put(snapshot),
      bridge &&
        account &&
        Promise.resolve()
          .then(() =>
            bridge.postMessage({
              action: 'put',
              kind,
              scope: account,
              savedAt: snapshot.savedAt,
              payload: superjson.stringify({ ...snapshot, scope: account }),
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
  if (Array.isArray(data)) return data.slice(0, MAX_ROWS);
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
  const retained = new Map(
    dehydrate(client, {
      shouldDehydrateQuery: (query) =>
        persisted(query.queryKey, scope) && query.state.data !== undefined,
    }).queries.map((query) => [query.queryHash, query]),
  );
  const trim = () => {
    while (retained.size > MAX_QUERIES) {
      // 先淘汰浏览记录，不让大量包详情或搜索挤掉联系人及表情主目录。
      const victim = [...retained.values()].find((query) => {
        const path = query.queryKey[0];
        return Array.isArray(path) && browsedPaths.has(path.slice(1).join('.'));
      });
      retained.delete(victim?.queryHash ?? retained.keys().next().value!);
    }
  };
  trim();
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let idle: number | undefined;
  let writing = Promise.resolve();
  const flush = () => {
    if (timer !== undefined) clearTimeout(timer);
    if (idle !== undefined) window.cancelIdleCallback(idle);
    timer = undefined;
    idle = undefined;
    if (dirty) {
      const queries = [...retained.values()].slice(-MAX_QUERIES).map((query) => ({
        ...query,
        state: {
          ...query.state,
          data: boundedData(query.state.data),
          status: 'success' as const,
          fetchStatus: 'idle' as const,
          error: null,
          fetchFailureCount: 0,
          fetchFailureReason: null,
        },
      }));
      const snapshot = { scope, savedAt: Date.now(), state: { mutations: [], queries } };
      dirty = false;
      // 串行提交，避免慢事务覆盖更新的快照；失败不删除已有缓存。
      writing = writing.then(() => store.put(snapshot)).catch(() => {});
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
    if (retained.get(queryHash)?.state.data === state.data) return;
    // 成功事件只保存该查询的不可变状态；全量快照留到空闲写入，不随每次更新扫描。
    retained.delete(queryHash);
    retained.set(queryHash, {
      queryHash,
      queryKey,
      state,
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
