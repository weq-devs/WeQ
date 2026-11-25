import { useSyncExternalStore } from 'react';
import { DatabaseProgressTracker } from '@weq/service/db-progress';
import {
  summarizeDatabaseMaintenance,
  type DatabaseRepairBackupMode,
  type DatabaseMaintenanceStatus,
  type DatabaseMaintenanceSnapshot,
  type DatabaseMaintenanceReport,
  type DatabaseMaintenanceRow,
} from '@weq/service/db-checkup';

type Input = {
  concurrency?: number;
  mode?: DatabaseRepairBackupMode;
  uin?: string;
  configId?: string;
  kind?: 'scan' | 'checkup';
  dbNames?: string[];
  operationId?: string;
  methods?: Record<string, 'quick' | 'deep'>;
  reportId?: string;
  recordId?: string;
  format?: string;
  allowLowSpace?: boolean;
  backup?: boolean;
  backups?: Record<string, boolean>;
  strictPages?: boolean;
};
type Listener = { onData(value: DatabaseMaintenanceStatus): void; onError?(error: Error): void };
const listeners = new Set<Listener>();
const stores = new Set<() => void>();
const saved = new Map<string, DatabaseMaintenanceReport>();
let live: DatabaseMaintenanceSnapshot | null = null;
let liveStatus: DatabaseMaintenanceStatus | null = null;
let tracker: DatabaseProgressTracker;
let sequence = 0;
let scopeNames = namesForFixture();
let version = 0;
let cache: string | null = '/synthetic/cache';
let checkupConcurrency = 2;
let repairBackupMode: DatabaseRepairBackupMode = 'deep';
let freeBytes = 10_000_000_000;
let resolveRun: ((value: unknown) => void) | undefined;
const calls = {
  scan: [] as Input[],
  append: [] as Input[],
  repair: [] as Input[],
  stop: 0,
  end: 0,
  pick: 0,
  reset: 0,
  export: [] as Input[],
  delete: [] as Input[],
};
function namesForFixture() {
  return ['nt_msg.db', 'profile.db', 'unsupported.db'];
}
const names = namesForFixture();
const notify = () => {
  version++;
  for (const listener of stores) listener();
};
const publish = () => {
  liveStatus = live && structuredClone(summarizeDatabaseMaintenance(live));
  notify();
  if (liveStatus) for (const listener of listeners) listener.onData(liveStatus);
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
    badPages: index === 0 ? 1 : 0,
    outcome: index === 0 ? 'abnormal' : 'normal',
  });
  const done = progress.finish('completed');
  return {
    dbName,
    scanStatus: 'completed',
    support: index === 2 ? 'unsupported' : 'supported',
    issues:
      index === 0
        ? [{ message: '发现 1 个坏页。', support: 'supported' }]
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
      pageCount: index === 0 ? 4663100 : 100,
      badPages: index === 0 ? [4663083] : [],
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
    databases: scopeNames.map((dbName) => ({
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
      totalDatabases: scopeNames.length,
      currentDb: scopeNames[0],
    },
  };
}
function retain() {
  if (live?.operation)
    saved.set(live.operation.id, structuredClone(live) as DatabaseMaintenanceReport);
}
function finish(status: 'completed' | 'cancelled' = 'completed') {
  if (live?.operation?.status !== 'running') return;
  const repair = live.operation.kind === 'repair';
  if (repair) {
    for (const row of live.databases)
      if (row.repair) row.repair = { status: status === 'completed' ? 'completed' : 'cancelled' };
    live.state = 'ended';
    live.locked = false;
  } else {
    if (status === 'completed') {
      const targets = live.operation.databaseNames ?? scopeNames;
      scopeNames = [...new Set([...scopeNames, ...targets])];
      live.databases = scopeNames.map((name) =>
        targets.includes(name)
          ? regularRow(name, names.indexOf(name))
          : live!.databases.find((row) => row.dbName === name)!,
      );
      const { kind, databaseScanKinds } = live.operation;
      const deepNames = targets.filter((name) => (databaseScanKinds?.[name] ?? kind) === 'checkup');
      if (deepNames.length) {
        for (const row of live.databases) {
          if (!deepNames.includes(row.dbName)) continue;
          const index = names.indexOf(row.dbName);
          row.deepStatus = 'completed';
          if (index === 0) {
            row.locationChecked = true;
            row.quickBudgetBytes = 32 * 1024 * 1024;
            row.scan!.affected = [
              {
                name: '空闲叶页',
                pagetype: 'freelist-leaf',
                badPageCount: 1,
                samplePages: [4663083],
              },
            ];
          }
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
    } else {
      for (const row of live.databases) {
        if (row.scanStatus === 'running') row.scanStatus = 'pending';
        if (row.deepStatus === 'running') row.deepStatus = 'cancelled';
      }
    }
    const empty =
      status === 'cancelled' && !live.databases.some((row) => row.scanStatus === 'completed');
    live.state = empty ? 'ended' : 'waiting';
    if (empty) live.locked = false;
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
  const { databaseNames, kind, databaseScanKinds } = live.operation;
  live.operation.completedDatabases = live.databases.filter((row) => {
    if (databaseNames && !databaseNames.includes(row.dbName)) return false;
    if (repair) return row.repair?.status === 'completed';
    return (databaseScanKinds?.[row.dbName] ?? kind) === 'checkup'
      ? row.deepStatus === 'completed'
      : row.scanStatus === 'completed';
  }).length;
  live.operation.currentDb = undefined;
  if (
    repair ||
    status !== 'cancelled' ||
    live.databases.some((row) => row.scanStatus === 'completed')
  )
    retain();
  publish();
  const snapshot = summarizeDatabaseMaintenance(live);
  resolveRun?.(repair ? { snapshot, closedAccount: false } : snapshot);
  resolveRun = undefined;
}

export const maintenanceQa = {
  calls,
  reset() {
    resolveRun?.(live && summarizeDatabaseMaintenance(live));
    resolveRun = undefined;
    live = null;
    liveStatus = null;
    saved.clear();
    sequence = 0;
    scopeNames = namesForFixture();
    cache = '/synthetic/cache';
    checkupConcurrency = 2;
    repairBackupMode = 'deep';
    freeBytes = 10_000_000_000;
    calls.scan.length = 0;
    calls.append.length = 0;
    calls.repair.length = 0;
    calls.export.length = 0;
    calls.delete.length = 0;
    calls.stop = calls.end = calls.pick = calls.reset = 0;
    notify();
  },
  snapshot: () => live,
  ready(
    kind: 'scan' | 'checkup' = 'scan',
    options: { secondIssue?: boolean; quickSupported?: boolean } = {},
  ) {
    live = create(kind);
    tracker = new DatabaseProgressTracker('scan', names[0]!);
    finish();
    if (kind === 'checkup') {
      if (!options.quickSupported) live.databases[0]!.quickBudgetBytes = undefined;
      if (options.secondIssue)
        live.databases[1]!.issues.push({ message: '测试用结构异常', support: 'supported' });
      publish();
    }
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
    const row = live.databases.find((item) => item.dbName === live?.operation?.currentDb)!;
    row.scanStatus = 'running';
    row.progress = tracker.update('scan', {
      step: 'pages',
      message: '检查页签名',
      completed: 42,
      total: 100,
      unit: 'pages',
      badPages: row.dbName === names[0] ? 3 : 0,
      outcome: row.dbName === names[0] ? 'abnormal' : 'normal',
    });
    live.progress = row.progress;
    publish();
  },
  complete: () => finish(),
  failQuick() {
    if (!live?.operation || !resolveRun) return;
    live.state = 'waiting';
    live.operation.status = 'waiting';
    const row = live.databases.find((item) => item.dbName === live?.operation?.currentDb)!;
    row.repair = {
      status: 'waiting',
      method: 'quick',
      nextAction: 'view-deep',
      error: '快速修复产物未通过复核，原数据库保持不变。',
    };
    retain();
    publish();
    resolveRun({ snapshot: summarizeDatabaseMaintenance(live), closedAccount: false });
    resolveRun = undefined;
  },
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
    live.databases = scopeNames.map(regularRow);
    live.state = 'checking';
    const row = live.databases[0]!;
    row.deepStatus = 'running';
    live.operation.currentDb = row.dbName;
    tracker = new DatabaseProgressTracker('checkup', row.dbName, Date.now, row.scanProgress);
    row.progress = tracker.update('checkup', {
      step: 'integrity-pages',
      message: '检查页结构与引用',
      completed: 800,
      total: 2048,
      unit: 'pages',
    });
    live.progress = row.progress;
    publish();
  },
  tableStructure() {
    if (!live) return;
    for (let table = 1; table <= 12; table++) {
      const tableName = `table_${table}`;
      tracker.update('checkup', {
        step: `integrity-records-${table}`,
        message: '检查记录与索引对应',
        objectName: tableName,
        completed: 2000,
        total: 2000,
        unit: 'records',
      });
      live.progress = tracker.update('checkup', {
        step: `integrity-index-${table + 12}`,
        message: '核对索引条目数量',
        objectName: `lookup_${table}`,
        tableName,
        completed: table === 12 ? 15 : 30,
        total: 30,
        unit: 'pages',
      });
    }
    live.databases[0]!.progress = live.progress;
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
  lowSpace(availableBytes = 1) {
    freeBytes = availableBytes;
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
        isFetchedAfterMount: true,
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
    [
      'status',
      'maintenance',
      'preflight',
      'repairStorage',
      'reports',
      'history',
      'cacheLocation',
    ].map((key) => [key, invalidation]),
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
    maintenance: query(() => liveStatus),
    reports: query(() =>
      [...saved.values()].map((item) => ({ id: item.operation.id, operation: item.operation })),
    ),
    reportStatus: query((input) => {
      const report = saved.get(input.reportId ?? '');
      return report && summarizeDatabaseMaintenance(report);
    }),
    history: query(() => []),
    legacyReport: query(() => null),
    cacheLocation: query(() => ({ override: cache })),
    repairBackupMode: query(() => repairBackupMode),
    setRepairBackupMode: mutation(async ({ mode }) => {
      repairBackupMode = mode!;
      notify();
    }),
    checkupSettings: query(() => ({ concurrency: checkupConcurrency })),
    setCheckupConcurrency: mutation(async ({ concurrency }) => {
      checkupConcurrency = concurrency!;
      notify();
    }),
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
    repairStorage: query((input) =>
      (input.dbNames ?? []).map((dbName) => ({
        dbName,
        phase: 'preparing',
        cachePath: cache ?? '/default/cache',
        space: [
          {
            paths: [cache ?? '/default/cache'],
            freeBytes,
            requiredBytes: dbName === 'profile.db' ? 100_000 : 1_000_000,
            recommendedBytes: dbName === 'profile.db' ? 125_000 : 1_250_000,
          },
        ],
      })),
    ),
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
      const previous = live?.locked ? live.databases : undefined;
      const targets = input.dbNames ?? scopeNames;
      scopeNames = previous ? [...new Set([...scopeNames, ...targets])] : targets;
      live = create(input.kind);
      if (previous)
        live.databases = live.databases.map(
          (row) => previous.find((item) => item.dbName === row.dbName) ?? row,
        );
      live.operation!.databaseNames = targets;
      live.operation!.totalDatabases = targets.length;
      const currentDb = targets[0]!;
      live.operation!.currentDb = currentDb;
      tracker = new DatabaseProgressTracker('scan', currentDb);
      maintenanceQa.pages();
      return new Promise((resolve) => {
        resolveRun = resolve;
      });
    }),
    appendScan: mutation(async (input) => {
      calls.append.push(input);
      const operation = live?.operation;
      if (!operation || operation.id !== input.operationId || operation.status !== 'running')
        throw new Error('本次体检已停止或完成。');
      operation.databaseNames = [
        ...new Set([...(operation.databaseNames ?? []), ...input.dbNames!]),
      ];
      operation.totalDatabases = operation.databaseNames.length;
      const kind = input.kind ?? operation.kind;
      if (kind !== 'repair') {
        const scanKinds = { ...operation.databaseScanKinds };
        for (const name of input.dbNames!) {
          if (kind === operation.kind) delete scanKinds[name];
          else scanKinds[name] = kind;
        }
        operation.databaseScanKinds = Object.keys(scanKinds).length ? scanKinds : undefined;
      }
      publish();
    }),
    repairSelected: mutation(async (input) => {
      calls.repair.push(input);
      const rows = live!.databases;
      live = { ...create('repair'), id: live!.id, databases: rows };
      live.operation!.totalDatabases = input.dbNames!.length;
      live.operation!.databaseNames = input.dbNames;
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
      return live && summarizeDatabaseMaintenance(live);
    }),
    endMaintenance: mutation(async () => {
      calls.end++;
      finish('cancelled');
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
    deleteReport: mutation(async (input) => {
      calls.delete.push(input);
      saved.delete(input.reportId!);
      notify();
      return { removed: true };
    }),
    deleteRecord: mutation(),
  },
};
export const client = {
  dbRepair: {
    prepareEndMaintenance: {
      subscribe: (
        _: unknown,
        listener: {
          onData(value: {
            id: string;
            kind?: 'scan' | 'checkup' | 'repair';
            running: boolean;
            replacing?: string;
          }): void;
        },
      ) => {
        let open = true;
        queueMicrotask(() => {
          if (!open) return;
          listener.onData({
            id: 'end-decision',
            kind: live?.operation?.kind,
            running: live?.operation?.status === 'running',
            replacing:
              live?.progress?.current.phase === 'swapping' ? live.operation?.currentDb : undefined,
          });
        });
        return {
          unsubscribe: () => {
            open = false;
          },
        };
      },
    },
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
