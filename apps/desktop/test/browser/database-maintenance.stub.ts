import { DatabaseProgressTracker } from '@weq/service/db-progress';

type Listener = { onData: (value: unknown) => void; onError: (error: Error) => void };
const listeners = new Set<Listener>();
let checkupRequest: { taskId: string; uin: string; dbName: string } | undefined;
let repairRequest: { requestId: string; uin: string; dbName: string } | undefined;
let resolveCheckup: ((value: unknown) => void) | undefined;
let checkupTracker = new DatabaseProgressTracker('checkup', 'nt_msg.db');
let repairTracker = new DatabaseProgressTracker('repair', 'nt_msg.db');
const query = (data: unknown) => ({ useQuery: () => ({ data }) });
const mutation = (mutateAsync: (input: never) => Promise<unknown> = async () => ({})) => ({
  useMutation: () => ({ mutateAsync, isLoading: false }),
});
const utils = { invalidate: async () => {} };
const databases = [
  'nt_msg.db',
  'profile.db',
  'collection.db',
  'guild_msg.db',
  'misc.db',
  'friends.db',
].map((dbName) => ({ dbName, exists: true, bytes: 2147483648, lastRecord: null }));
const result = () => ({
  dbName: checkupRequest?.dbName,
  bytes: 2147483648,
  integrity: { ran: true, healthy: true, corruptedTables: [] },
  pages: {
    ran: true,
    report: { pageCount: 524288, pageSize: 4096, badPages: [], zeroPages: [], usedHmac: true },
  },
  verdict: 'healthy',
  summary: '结构与页签名检查通过',
});

export const maintenanceQa = {
  checkupOutcome(mode: 'normal' | 'abnormal' | 'unverified' | 'failed' | 'diagnosing') {
    checkupTracker = new DatabaseProgressTracker('checkup', 'nt_msg.db');
    checkupTracker.update('checkup', { step: 'opening', message: '打开只读体检进程' });
    checkupTracker.update('checkup', { step: 'integrity', message: '检查数据库整体结构' });
    checkupTracker.update('checkup', {
      step: 'integrity-pages',
      message: '检查页结构与引用',
      completed: mode === 'abnormal' || mode === 'diagnosing' ? 4336384 : 4567177,
      total: 4567177,
      unit: 'pages',
    });
    if (mode === 'abnormal' || mode === 'diagnosing')
      checkupTracker.update('checkup', {
        step: 'integrity-tables',
        message: '逐表定位结构异常',
        objectName: 'group_msg_table',
        completed: mode === 'diagnosing' ? 17 : 34,
        total: 34,
        unit: 'tables',
        outcome: 'abnormal',
      });
    let maintenance: ReturnType<typeof checkupTracker.update>;
    if (mode === 'diagnosing') {
      maintenance = checkupTracker.update('checkup', {
        step: 'integrity-tables',
        message: '逐表定位结构异常',
        objectName: 'group_msg_table',
        completed: 17,
        total: 34,
        unit: 'tables',
        outcome: 'abnormal',
      });
    } else {
      checkupTracker.update('checkup', {
        step: 'integrity',
        message: '检查数据库整体结构',
        status: mode === 'failed' ? 'failed' : 'completed',
        outcome: mode === 'abnormal' ? 'abnormal' : mode === 'failed' ? 'unverified' : 'normal',
        detail:
          mode === 'abnormal'
            ? '异常表：group_msg_table'
            : mode === 'failed'
              ? '无法读取数据库，结构结果未判定。'
              : undefined,
      });
      maintenance = checkupTracker.update('checkup', {
        step: 'pages',
        message: '检查页签名',
        completed: mode === 'unverified' ? 0 : 182400,
        total: 524288,
        unit: 'pages',
        status: mode === 'unverified' ? 'skipped' : 'running',
        outcome:
          mode === 'unverified' ? 'unverified' : mode === 'abnormal' ? 'abnormal' : undefined,
        badPages: mode === 'abnormal' ? 3 : undefined,
        detail: mode === 'unverified' ? '未开启页 HMAC，无法判断页签名是否正常。' : undefined,
      });
    }
    for (const listener of listeners)
      listener.onData({ ...checkupRequest, kind: 'checkup', maintenance });
  },
  structure() {
    checkupTracker.update('checkup', { step: 'opening', message: '打开只读体检进程' });
    const maintenance = checkupTracker.update('checkup', {
      step: 'integrity-pages',
      message: '检查页结构与引用',
      completed: 800,
      total: 2048,
      unit: 'pages',
    });
    for (const listener of listeners)
      listener.onData({ ...checkupRequest, kind: 'checkup', maintenance });
  },
  structureRecords() {
    checkupTracker.update('checkup', {
      step: 'integrity-pages',
      message: '检查页结构与引用',
      completed: 2048,
      total: 2048,
      unit: 'pages',
    });
    const maintenance = checkupTracker.update('checkup', {
      step: 'integrity-records-2',
      message: '检查记录与索引对应',
      completed: 500,
      total: 2000,
      unit: 'records',
      objectName: 'synthetic_table',
    });
    for (const listener of listeners)
      listener.onData({ ...checkupRequest, kind: 'checkup', maintenance });
  },
  checkup() {
    const maintenance = checkupTracker.update('checkup', {
      step: 'pages',
      message: '检查页签名',
      completed: 182400,
      total: 524288,
      unit: 'pages',
      badPages: 3,
      zeroPages: 0,
    });
    for (const listener of listeners)
      listener.onData({ ...checkupRequest, kind: 'checkup', maintenance });
  },
  repair(phase = 'Decrypt') {
    const maintenance = repairTracker.update(
      phase,
      phase === 'Repair'
        ? {
            step: 'recover-data',
            message: '恢复表数据',
            objectName: 'group_msg_table_with_an_extremely_long_identifier_for_overflow_regression',
            completed: 1846721,
            unit: 'fields',
          }
        : {
            step: 'decrypt',
            message: '解密源数据库',
            completed: 327156,
            total: 524288,
            unit: 'pages',
          },
    );
    for (const listener of listeners)
      listener.onData({
        ...repairRequest,
        kind: 'repair',
        phase,
        percent: 15,
        message: maintenance.current.message,
        maintenance,
      });
  },
  longRepair() {
    repairTracker = new DatabaseProgressTracker('repair', repairRequest!.dbName);
    for (let index = 0; index < 8; index++) {
      repairTracker.update('Repair', {
        step: `table-${index}`,
        message: `恢复已完成表 ${index}`,
      });
    }
    maintenanceQa.repair('Repair');
  },
  disconnect() {
    for (const listener of listeners) listener.onError(new Error('synthetic disconnect'));
  },
};

export const trpc = {
  useUtils: () => ({
    dbRepair: {
      status: utils,
      preflight: utils,
      detectLayout: utils,
      history: utils,
      cacheLocation: utils,
    },
  }),
  dbRepair: {
    status: query({ keyPresent: true, qqPid: null, busy: false, databases }),
    history: query([]),
    detectLayout: query({ needsMigration: false, summary: '页布局正常' }),
    preflight: query({
      readiness: 'ready',
      qqHolders: [],
      cachePath: '/synthetic/cache',
      pendingWalBytes: 0,
      dbBytes: 2147483648,
      storageOptimized: true,
      space: [
        {
          paths: ['/synthetic/cache'],
          freeBytes: 10000000000,
          requiredBytes: 1000000000,
          recommendedBytes: 1250000000,
        },
      ],
    }),
    cacheLocation: query({ override: '/synthetic/cache' }),
    pickCacheLocation: mutation(),
    resetCacheLocation: mutation(),
    checkup: mutation(async (input) => {
      checkupRequest = input;
      checkupTracker = new DatabaseProgressTracker('checkup', checkupRequest!.dbName);
      return new Promise((resolve) => {
        resolveCheckup = resolve;
      });
    }),
    cancelCheckup: mutation(async () => {
      resolveCheckup?.(result());
      return { cancelled: true };
    }),
    start: mutation(async (input) => {
      repairRequest = input;
      repairTracker = new DatabaseProgressTracker('repair', repairRequest!.dbName);
      return new Promise(() => {});
    }),
    killQq: mutation(),
    restore: mutation(),
    deleteRecord: mutation(),
    backup: mutation(),
  },
};
export const client = {
  dbRepair: {
    onProgress: {
      subscribe: (_: unknown, listener: Listener) => {
        listeners.add(listener);
        return { unsubscribe: () => listeners.delete(listener) };
      },
    },
    releaseCheckups: { mutate: async () => true },
  },
};
export const useQQAutoRefresh = () => ({ enabled: true });
export const useToast = (selector: (value: { push: () => void }) => unknown) =>
  selector({ push: () => {} });
export const useToastApi = () => ({ push: () => {} });
export const QqAvatar = () => null;
