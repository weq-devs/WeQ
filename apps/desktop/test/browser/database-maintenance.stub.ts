import { useSyncExternalStore } from 'react';
import { DatabaseProgressTracker } from '@weq/service/db-progress';
import type {
  DatabaseMaintenanceSnapshot,
  DatabaseMaintenanceReport,
  DatabaseMaintenanceRow,
} from '@weq/service/db-checkup';

type Input = {
  uin?: string;
  configId?: string;
  kind?: 'scan' | 'checkup';
  dbNames?: string[];
  reportId?: string;
  format?: string;
  allowLowSpace?: boolean;
  backup?: boolean;
  strictPages?: boolean;
};
type Listener = { onData(value: DatabaseMaintenanceSnapshot): void; onError?(error: Error): void };
const listeners = new Set<Listener>();
const stores = new Set<() => void>();
const saved = new Map<string, DatabaseMaintenanceReport>();
let live: DatabaseMaintenanceSnapshot | null = null;
let tracker: DatabaseProgressTracker;
let sequence = 0;
let version = 0;
let cache: string | null = '/synthetic/cache';
let freeBytes = 10_000_000_000;
let resolveRun: ((value: unknown) => void) | undefined;
const calls = {
  scan: [] as Input[],
  repair: [] as Input[],
  stop: 0,
  end: 0,
  pick: 0,
  reset: 0,
  export: [] as Input[],
};
const names = ['nt_msg.db', 'profile.db', 'unsupported.db'];
const notify = () => {
  version++;
  for (const listener of stores) listener();
};
const publish = () => {
  notify();
  if (live) for (const listener of listeners) listener.onData(structuredClone(live));
};
function regularRow(dbName: string, index: number): DatabaseMaintenanceRow {
  const progress = new DatabaseProgressTracker('scan', dbName);
  progress.update('scan', {
    step: 'pages',
    message: '检查页签名',
    completed: 100,
    total: 100,
    unit: 'pages',
    status: 'completed',
    badPages: index === 0 ? 3 : 0,
    outcome: index === 0 ? 'abnormal' : 'normal',
  });
  const done = progress.finish('completed');
  return {
    dbName,
    scanStatus: 'completed',
    support: index === 2 ? 'unsupported' : 'supported',
    issues:
      index === 0
        ? [{ message: '发现 3 个坏页，可重建仍能读取的数据。', support: 'supported' }]
        : index === 2
          ? [
              {
                diagnostic: false,
                message: '此数据库为明文库，当前重建工具不支持。',
                support: 'unsupported',
              },
            ]
          : [],
    scan: {
      dbName,
      dbPath: `/synthetic/${dbName}`,
      pageSize: 4096,
      pageCount: 100,
      badPages: index === 0 ? [4, 8, 12] : [],
      zeroPages: [],
      usedHmac: index !== 2,
      plaintext: index === 2,
      headerOffset: 1024,
      trailingBytes: 0,
      fileSize: 410624,
      scannedAt: 0,
      affected: [],
    },
    progress: done,
    scanProgress: done,
  };
}
function create(kind: 'scan' | 'checkup' | 'repair' = 'scan'): DatabaseMaintenanceSnapshot {
  return {
    id: 'maintenance',
    uin: 'synthetic',
    configId: 'source',
    state: kind === 'repair' ? 'repairing' : 'scanning',
    locked: true,
    databases: names.map((dbName) => ({
      dbName,
      scanStatus: 'pending',
      support: 'possible',
      issues: [],
    })),
    operation: {
      id: `operation-${++sequence}`,
      kind,
      status: 'running',
      startedAt: Date.now() - 13_000,
      elapsedMs: 13_000,
      completedDatabases: 0,
      totalDatabases: 3,
      currentDb: names[0],
    },
  };
}
function retain() {
  if (live?.operation)
    saved.set(live.operation.id, structuredClone(live) as DatabaseMaintenanceReport);
}
function finish(status: 'completed' | 'cancelled' = 'completed') {
  if (!live?.operation || live.operation.status !== 'running') return;
  const repair = live.operation.kind === 'repair';
  if (repair) {
    for (const row of live.databases)
      if (row.repair) row.repair = { status: status === 'completed' ? 'completed' : 'cancelled' };
    live.state = 'ended';
    live.locked = false;
  } else {
    if (status === 'completed') {
      live.databases = names.map(regularRow);
      if (live.operation.kind === 'checkup') {
        for (const [index, row] of live.databases.entries()) {
          row.deepStatus = 'completed';
          row.integrity = {
            ran: true,
            healthy: index !== 0,
            corruptedTables: index === 0 ? ['group_msg_table'] : [],
          };
        }
        tracker.update('checkup', {
          step: 'integrity-pages',
          message: '检查页结构与引用',
          completed: 2048,
          total: 2048,
          unit: 'pages',
        });
        tracker.update('checkup', {
          step: 'integrity',
          message: '结构检查发现异常',
          status: 'completed',
          outcome: 'abnormal',
          detail: '异常表：group_msg_table',
        });
      }
    } else
      for (const row of live.databases)
        if (row.scanStatus === 'running') row.scanStatus = 'pending';
    live.state = 'waiting';
  }
  const done = tracker?.finish(status);
  if (done) {
    const row = live.databases.find((item) => item.dbName === done.dbName);
    if (row) row.progress = done;
    live.progress = done;
  }
  live.operation.status = status;
  live.operation.finishedAt = live.operation.startedAt + 17_000;
  live.operation.elapsedMs = 17_000;
  live.operation.completedDatabases = live.databases.filter((row) =>
    repair ? row.repair?.status === 'completed' : row.scanStatus === 'completed',
  ).length;
  live.operation.currentDb = undefined;
  retain();
  publish();
  resolveRun?.(repair ? { snapshot: live, closedAccount: false } : live);
  resolveRun = undefined;
}

export const maintenanceQa = {
  calls,
  reset() {
    resolveRun?.(live);
    resolveRun = undefined;
    live = null;
    saved.clear();
    sequence = 0;
    cache = '/synthetic/cache';
    freeBytes = 10_000_000_000;
    calls.scan.length = 0;
    calls.repair.length = 0;
    calls.export.length = 0;
    calls.stop = calls.end = calls.pick = calls.reset = 0;
    notify();
  },
  snapshot: () => live,
  ready() {
    live = create();
    tracker = new DatabaseProgressTracker('scan', names[0]!);
    finish();
  },
  archive(target?: { uin: string; configId?: string }) {
    if (!live?.operation) return;
    const old = structuredClone(live) as DatabaseMaintenanceReport;
    old.id = 'old-maintenance';
    if (target) {
      old.uin = target.uin;
      old.configId = target.configId;
    }
    old.operation.id = 'old-report';
    old.state = 'ended';
    old.locked = false;
    saved.set('old-report', old);
    notify();
  },
  pages() {
    if (!live?.operation) return;
    const row = live.databases[0]!;
    row.scanStatus = 'running';
    row.progress = tracker.update('scan', {
      step: 'pages',
      message: '检查页签名',
      completed: 42,
      total: 100,
      unit: 'pages',
      badPages: 3,
      outcome: 'abnormal',
    });
    live.progress = row.progress;
    publish();
  },
  complete: () => finish(),
  completeFirst() {
    if (!live) return;
    live.databases[0] = regularRow(names[0]!, 0);
    if (live.operation) {
      live.operation.completedDatabases = 1;
      live.operation.currentDb = names[1];
    }
    tracker = new DatabaseProgressTracker('scan', names[1]!);
    live.databases[1]!.scanStatus = 'running';
    live.databases[1]!.progress = tracker.update('scan', {
      step: 'pages',
      message: '检查页签名',
      completed: 1,
      total: 100,
      unit: 'pages',
    });
    live.progress = live.databases[1]!.progress;
    publish();
  },
  structure() {
    if (!live?.operation) return;
    live.databases = names.map(regularRow);
    live.state = 'checking';
    live.operation.currentDb = names[0];
    tracker = new DatabaseProgressTracker(
      'checkup',
      names[0]!,
      Date.now,
      live.databases[0]!.scanProgress,
    );
    live.databases[0]!.progress = tracker.update('checkup', {
      step: 'integrity-pages',
      message: '检查页结构与引用',
      completed: 800,
      total: 2048,
      unit: 'pages',
    });
    live.progress = live.databases[0]!.progress;
    publish();
  },
  repair(phase = 'Repair') {
    if (!live?.operation) return;
    const name = live.operation.currentDb!;
    const row = live.databases.find((item) => item.dbName === name)!;
    row.progress = tracker.update(
      phase,
      phase === 'Repair'
        ? {
            step: 'recover-data',
            message: '恢复表数据',
            completed: 1_846_721,
            unit: 'fields',
            objectName: 'group_msg_table_with_a_long_identifier_for_layout_verification',
          }
        : {
            step: 'decrypt',
            message: '解密源数据库',
            completed: 327156,
            total: 524288,
            unit: 'pages',
          },
    );
    live.progress = row.progress;
    publish();
  },
  lowSpace() {
    freeBytes = 1;
    notify();
  },
  disconnect() {
    for (const listener of listeners) listener.onError?.(new Error('synthetic disconnect'));
  },
};

function query<T>(get: (input: Input) => T) {
  return {
    useQuery: (input: Input = {}) => {
      useSyncExternalStore(
        (listener) => {
          stores.add(listener);
          return () => {
            stores.delete(listener);
          };
        },
        () => version,
      );
      return {
        data: get(input),
        error: null,
        isLoading: false,
        refetch: async () => {
          notify();
          return {};
        },
      };
    },
  };
}
const mutation = (mutateAsync: (input: Input) => Promise<unknown> = async () => ({})) => ({
  useMutation: () => ({ mutateAsync, isLoading: false }),
});
const invalidation = {
  invalidate: async () => {
    notify();
  },
};
const utils = {
  dbRepair: Object.fromEntries(
    ['status', 'maintenance', 'preflight', 'reports', 'history', 'cacheLocation'].map((key) => [
      key,
      invalidation,
    ]),
  ),
};
const status = {
  keyPresent: true,
  qqPid: null,
  busy: false,
  error: null,
  databases: names.map((dbName) => ({ dbName, exists: true, bytes: 410624, lastRecord: null })),
};
export const trpc = {
  useUtils: () => utils,
  dbRepair: {
    status: query(() => status),
    maintenance: query(() => live),
    reports: query(() =>
      [...saved.values()].map((item) => ({ id: item.operation.id, operation: item.operation })),
    ),
    report: query((input) => saved.get(input.reportId ?? '')),
    history: query(() => []),
    legacyReport: query(() => null),
    cacheLocation: query(() => ({ override: cache })),
    preflight: query(() => ({
      cachePath: cache,
      space: [
        {
          paths: [cache ?? '/default/cache'],
          freeBytes,
          requiredBytes: 1_000_000,
          recommendedBytes: 1_250_000,
        },
      ],
    })),
    pickCacheLocation: mutation(async () => {
      calls.pick++;
      cache = '/synthetic/changed';
      notify();
      return { override: cache };
    }),
    resetCacheLocation: mutation(async () => {
      calls.reset++;
      cache = null;
      notify();
      return { override: null };
    }),
    scanAccount: mutation(async (input) => {
      calls.scan.push(input);
      live = create(input.kind);
      tracker = new DatabaseProgressTracker('scan', names[0]!);
      maintenanceQa.pages();
      return new Promise((resolve) => {
        resolveRun = resolve;
      });
    }),
    repairSelected: mutation(async (input) => {
      calls.repair.push(input);
      const rows = live!.databases;
      live = { ...create('repair'), databases: rows };
      live.operation!.totalDatabases = input.dbNames!.length;
      live.operation!.currentDb = input.dbNames![0];
      for (const row of rows)
        row.repair = input.dbNames!.includes(row.dbName)
          ? { status: row.dbName === live.operation!.currentDb ? 'running' : 'pending' }
          : undefined;
      tracker = new DatabaseProgressTracker('repair', live.operation!.currentDb!);
      maintenanceQa.repair('Decrypt');
      return new Promise((resolve) => {
        resolveRun = resolve;
      });
    }),
    stopMaintenance: mutation(async () => {
      calls.stop++;
      finish('cancelled');
      return live;
    }),
    endMaintenance: mutation(async () => {
      calls.end++;
      if (live) {
        live.state = 'ended';
        live.locked = false;
        publish();
      }
      return true;
    }),
    exportMaintenanceReport: mutation(async (input) => {
      calls.export.push(input);
      return null;
    }),
    exportLegacyReport: mutation(),
  },
};
export const client = {
  dbRepair: {
    onMaintenance: {
      subscribe: (_: unknown, listener: Listener) => {
        listeners.add(listener);
        return {
          unsubscribe: () => {
            listeners.delete(listener);
          },
        };
      },
    },
  },
};
export const QqAvatar = () => null;
