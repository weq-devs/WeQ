import { useState, useSyncExternalStore } from 'react';
const listeners = new Set<() => void>();
let revision = 0;
const notify = () => {
  revision++;
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const settings = {
  realtimeEnabled: true,
  databaseReadConcurrency: 4,
  suppressDbDamageReminder: false,
};
const tolerance = { level: 0, grantedAt: null, summary: { total: 0 }, entries: [] };
export const qa = {
  changes: [] as number[],
  realtime: [] as boolean[],
  levels: [] as number[],
  repairs: 0,
};
const data: Record<string, unknown> = {
  'bootstrap.getSettings': settings,
  'bootstrap.databaseReadCapabilities': {
    parallelAvailable: !new URLSearchParams(location.search).has('legacy-native'),
  },
  'account.getAccountConfig': { uin: '10001', configId: 'synthetic', static: false },
  'account.getDbTolerance': tolerance,
  'account.listSalvageQuarantine': [],
  'account.dbExplorer.listDatabases': [
    { name: 'synthetic.db', path: '/synthetic/synthetic.db', bytes: 4096 },
  ],
  'account.dbExplorer.listObjects': [
    {
      type: 'table',
      name: 'messages',
      tableName: 'messages',
      sql: 'CREATE TABLE messages(content TEXT)',
    },
  ],
  'account.dbExplorer.getRows': {
    columns: [{ cid: 0, name: 'content', type: 'TEXT', notNull: false, defaultValue: null, pk: 0 }],
    rows: [['合成数据库记录']],
    keys: [{ t: 'rowid', rowid: '1' }],
    hasRowid: true,
    nextCursor: null,
  },
};
function proxy(path = ''): unknown {
  return new Proxy(() => proxy(path), {
    apply: () => proxy(path),
    get: (_target, key) => {
      if (key === 'useQuery')
        return () => {
          useSyncExternalStore(subscribe, () => revision);
          return {
            data: data[path],
            isLoading: false,
            isFetching: false,
            isError: false,
            error: null,
            refetch: async () => ({ data: data[path] }),
          };
        };
      if (key === 'useMutation')
        return () => {
          const [, render] = useState(0);
          return {
            isLoading: false,
            isPending: false,
            mutateAsync: async (input: {
              concurrency?: number;
              suppressed?: boolean;
              level?: number;
              enabled?: boolean;
            }) => {
              if (
                path === 'bootstrap.setDatabaseReadConcurrency' &&
                input.concurrency !== undefined
              ) {
                settings.databaseReadConcurrency = input.concurrency;
                qa.changes.push(input.concurrency);
              }
              if (path === 'bootstrap.setRealtimeEnabled' && input.enabled !== undefined) {
                settings.realtimeEnabled = input.enabled;
                qa.realtime.push(input.enabled);
              }
              if (path === 'account.setDbToleranceLevel' && input.level !== undefined) {
                tolerance.level = input.level;
                qa.levels.push(input.level);
              }
              notify();
              render((v) => v + 1);
              return { closedSalvage: 0 };
            },
          };
        };
      if (key === 'query' || key === 'fetch') return async () => data[path] ?? [];
      if (key === 'invalidate')
        return async () => {
          notify();
        };
      if (key === 'then') return undefined;
      return proxy(path ? `${path}.${String(key)}` : String(key));
    },
  });
}
export const trpc = proxy();
export const client = proxy();
