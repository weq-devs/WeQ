import type { DehydratedState } from '@tanstack/react-query';

const MAX_PARTITIONS = 4;
export const MESSAGE_SCOPE_PREFIX = 'messages:';
export const isMessageScope = (scope: string) => scope.startsWith(MESSAGE_SCOPE_PREFIX);

type SavedQuery = DehydratedState['queries'][number];

export interface BusinessSnapshot {
  scope: string;
  savedAt: number;
  state: DehydratedState;
}

export interface BusinessCacheDelta {
  base?: string;
  revision: string;
  changed: ReadonlySet<string>;
}

export interface BusinessCacheStore {
  get(scope: string): Promise<BusinessSnapshot | undefined>;
  put(snapshot: BusinessSnapshot, delta?: BusinessCacheDelta): Promise<void>;
}

type Partition = {
  schema: 2;
  scope: string;
  savedAt: number;
  keys: string[];
  revision?: string;
};
type QueryRecord = { scope: string; hash: string; query: SavedQuery };

function isPartition(value?: BusinessSnapshot | Partition): value is Partition {
  return value !== undefined && 'schema' in value && value.schema === 2;
}

let database: Promise<IDBDatabase> | undefined;
function openDatabase(): Promise<IDBDatabase> {
  if (!database) {
    database = new Promise<IDBDatabase>((resolve, reject) => {
      let failed = false;
      const request = window.indexedDB.open('weq-business-cache', 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('snapshots'))
          db.createObjectStore('snapshots', { keyPath: 'scope' }).createIndex('savedAt', 'savedAt');
        db.createObjectStore('queries', { keyPath: ['scope', 'hash'] });
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

// IDB 复合键先比较 scope，再比较 hash，数组键排在字符串键之后。
const queryKeys = (scope: string) => IDBKeyRange.bound([scope], [scope, []]);

export const localBusinessCache = {
  async get(scope: string): Promise<BusinessSnapshot | undefined> {
    const db = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['snapshots', 'queries']);
      const request = tx.objectStore('snapshots').get(scope);
      const records = tx.objectStore('queries').getAll(queryKeys(scope));
      tx.onabort = tx.onerror = () => reject(new Error('业务缓存读取失败'));
      records.onsuccess = () => {
        const header = request.result as BusinessSnapshot | Partition | undefined;
        if (!isPartition(header)) {
          resolve(header);
          return;
        }
        if (!Array.isArray(header.keys)) {
          resolve(undefined);
          return;
        }
        const byHash = new Map(
          (records.result as QueryRecord[]).map((row) => [row.hash, row.query]),
        );
        const queries: SavedQuery[] = [];
        for (const hash of header.keys) {
          const query = byHash.get(hash);
          if (!query) {
            resolve(undefined);
            return;
          }
          queries.push(query);
        }
        resolve({ scope, savedAt: header.savedAt, state: { mutations: [], queries } });
      };
    });
  },
  async remove(scope: string) {
    const db = await openDatabase();
    return new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['snapshots', 'queries'], 'readwrite');
      tx.objectStore('snapshots').delete(scope);
      tx.objectStore('queries').delete(queryKeys(scope));
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(new Error('旧缓存迁移清理失败'));
    });
  },
  async put(snapshot: BusinessSnapshot, delta?: BusinessCacheDelta) {
    const db = await openDatabase();
    const { scope, savedAt, state } = snapshot;
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['snapshots', 'queries'], 'readwrite');
      const partitions = tx.objectStore('snapshots');
      const queries = tx.objectStore('queries');
      const request = partitions.get(scope);
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(new Error('业务缓存保存失败'));
      request.onsuccess = () => {
        const previous = request.result as BusinessSnapshot | Partition | undefined;
        if (previous && previous.savedAt > savedAt) return;
        const keys = state.queries.map(({ queryHash }) => queryHash);
        const incremental =
          delta?.base !== undefined && isPartition(previous) && previous.revision === delta.base;
        try {
          if (incremental) {
            const kept = new Set(keys);
            for (const hash of previous.keys) if (!kept.has(hash)) queries.delete([scope, hash]);
          } else {
            queries.delete(queryKeys(scope));
          }
          for (const query of state.queries) {
            if (!incremental || delta.changed.has(query.queryHash))
              queries.put({ scope, hash: query.queryHash, query } satisfies QueryRecord);
          }
          partitions.put({
            schema: 2,
            scope,
            savedAt,
            keys,
            revision: delta?.revision,
          } satisfies Partition);
        } catch {
          tx.abort();
          return;
        }
        const retained = { messages: 0, directory: 0 };
        const cursor = partitions.index('savedAt').openKeyCursor(null, 'prev');
        cursor.onsuccess = () => {
          if (!cursor.result) return;
          const key = String(cursor.result.primaryKey);
          const bucket = isMessageScope(key) ? 'messages' : 'directory';
          if (++retained[bucket] > MAX_PARTITIONS) {
            partitions.delete(key);
            queries.delete(queryKeys(key));
          }
          cursor.result.continue();
        };
      };
    });
  },
};

export async function clearLegacyBusinessCache() {
  const db = await openDatabase();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['snapshots', 'queries'], 'readwrite');
    tx.objectStore('snapshots').clear();
    tx.objectStore('queries').clear();
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(new Error('旧业务缓存清理失败'));
  });
}
