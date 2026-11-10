import {
  dehydrate,
  hydrate,
  type DehydratedState,
  type QueryClient,
  type QueryKey,
} from '@tanstack/react-query';

const MAX_PARTITIONS = 4;
const MAX_ROWS = 10_000;
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
]);

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

export const businessCacheStore: BusinessCacheStore = {
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
      let retained = 0;
      const cursor = store.index('savedAt').openCursor(null, 'prev');
      cursor.onsuccess = () => {
        if (!cursor.result) return;
        if (++retained > MAX_PARTITIONS) cursor.result.delete();
        cursor.result.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(new Error('业务缓存保存失败'));
    });
  },
};

function persisted(key: QueryKey): boolean {
  const path = key[0];
  return (
    key[0] === resolvedProfilesKey[0] ||
    (Array.isArray(path) && path.length === 2 && path[0] === 'account' && procedures.has(path[1]))
  );
}

export async function restoreBusinessCache(
  client: QueryClient,
  scope: string,
  store = businessCacheStore,
  current = () => true,
): Promise<void> {
  try {
    const value = await store.get(scope);
    if (!current() || value?.scope !== scope || !Array.isArray(value.state?.queries)) return;
    // 仅恢复本地明确允许的目录项，不恢复 mutation、错误或账号配置。
    const queries = value.state.queries.filter(
      (query) =>
        Array.isArray(query.queryKey) &&
        persisted(query.queryKey) &&
        query.state?.status === 'success' &&
        Number.isFinite(query.state.dataUpdatedAt),
    );
    hydrate(client, { mutations: [], queries });
  } catch {
    /* 存储损坏或不可用时继续使用现有在线读取。 */
  }
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
  let pending: DehydratedState | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let idle: number | undefined;
  let writing = Promise.resolve();
  const flush = () => {
    if (timer !== undefined) clearTimeout(timer);
    if (idle !== undefined) window.cancelIdleCallback(idle);
    timer = undefined;
    idle = undefined;
    if (pending) {
      const snapshot = { scope, savedAt: Date.now(), state: pending };
      pending = undefined;
      // 串行提交，避免慢事务覆盖更新的快照；失败不删除已有缓存。
      writing = writing.then(() => store.put(snapshot)).catch(() => {});
    }
    return writing;
  };
  const unsubscribe = client.getQueryCache().subscribe((event) => {
    if (
      event.type !== 'updated' ||
      event.action.type !== 'success' ||
      !persisted(event.query.queryKey)
    )
      return;
    pending = dehydrate(client, {
      shouldDehydrateQuery: (query) => persisted(query.queryKey) && query.state.data !== undefined,
    });
    pending.queries = pending.queries.map((query) => ({
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
    }));
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
