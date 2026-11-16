import { useState, useSyncExternalStore } from 'react';
import type { MonitorHistory, MonitorPoint, MonitorSettings } from '@weq/service/performance';
const now = Date.now();
let settings: MonitorSettings = {
  version: 1,
  mode: 'light',
  retentionDays: 7,
  capacityMiB: 128,
  fullUntil: null,
};
const fixture = new URLSearchParams(location.search).get('state');
let cleared = false;
let revision = 0;
let logDays = 7;
let debug = false;
const listeners = new Set<() => void>();
function notify() {
  revision++;
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
const logText =
  Array.from({ length: 160 }, (_, index) =>
    JSON.stringify({
      ts: new Date(now - (160 - index) * 1000).toISOString(),
      level: index % 8 === 0 ? 'warn' : 'info',
      message: `合成日志 ${index}`,
      context: { scope: 'fixture' },
    }),
  ).join('\n') + '\n';
export const qa = {
  requests: [] as Array<{ route: string; enabled: boolean }>,
  changes: [] as unknown[],
  exports: [] as unknown[],
  setActive: (_value: boolean) => {},
  clearCount: 0,
  detailIds: [] as number[],
  logReads: 0,
  storageBytes: 42_000,
  historyAgeDays: 40 / 1440,
};
function history(input: { from: number; to: number; process?: string }): MonitorHistory {
  const points: MonitorPoint[] = [];
  if (!cleared && fixture !== 'empty')
    for (let i = 0; i < 80; i++) {
      const at = now - (80 - i) * 30_000;
      if (at < input.from || at > input.to || (i > 30 && i < 36)) continue;
      for (const [process, label] of [
        ['1:1', '主进程'],
        ['2:2', '主窗口'],
      ]) {
        if (input.process && process !== input.process) continue;
        const cpu = 2 + (i % 8);
        points.push({
          id: i + 1,
          process: process!,
          label: label!,
          segment: i < 36 ? 'first' : 'after-gap',
          start: at - 15_000,
          end: at + 15_000,
          firstAt: at,
          lastAt: at,
          count: 1,
          intervalMs: 30_000,
          metrics: {
            cpuPercent: { min: cpu, max: cpu + 3, mean: cpu + 1 },
            residentBytes: { min: 90e6 + i * 1e6, max: 100e6 + i * 1e6, mean: 95e6 + i * 1e6 },
            heapBytes: { min: 20e6, max: 30e6, mean: 25e6 },
            externalBytes: { min: null, max: null, mean: null },
            eventLoopP95Ms: { min: 12, max: 18, mean: 15 },
          },
        });
      }
    }
  return {
    points: points.sort((a, b) => a.lastAt - b.lastAt),
    events: [{ id: 1000, at: now - 1200_000, session: 'fixture', event: 'sampling-gap' }],
    eventLimitReached: false,
    pointLimitReached: false,
  };
}
function useFixtureQuery<T>(route: string, value: T, options?: { enabled?: boolean }) {
  useSyncExternalStore(subscribe, () => revision);
  qa.requests.push({ route, enabled: options?.enabled !== false });
  return {
    data: value,
    error: fixture === 'error' && route === 'history' ? { message: '合成读取失败' } : null,
    isLoading: false,
    refetch: async () => {
      notify();
      return { data: value };
    },
  };
}
function useFixtureMutation(run: (input: never) => unknown) {
  const [, update] = useState(0);
  return {
    isLoading: false,
    mutateAsync: async (input: never) => {
      const result = run(input);
      notify();
      update((value) => value + 1);
      return result;
    },
  };
}
export const trpc = {
  useUtils: () => ({
    performanceMonitor: {
      invalidate: async () => {
        notify();
      },
    },
    help: {
      getNativeDebugLog: {
        setData: () => {
          notify();
        },
      },
    },
  }),
  bootstrap: {
    getSettings: {
      useQuery: (_input: unknown, options: object) =>
        useFixtureQuery('settings', { logRetentionDays: logDays }, options),
    },
    setLogRetentionDays: {
      useMutation: () =>
        useFixtureMutation((input: { days: number }) => {
          logDays = input.days;
        }),
    },
  },
  help: {
    getNativeDebugLog: {
      useQuery: (_input: unknown, options: object) =>
        useFixtureQuery('debug', { enabled: debug, available: true }, options),
    },
    listLogFiles: {
      useQuery: (_input: unknown, options: object) =>
        useFixtureQuery(
          'logFiles',
          {
            dirs: ['/synthetic'],
            files: [
              {
                path: '/synthetic/2026-11-16.log',
                name: '2026-11-16.log',
                kind: 'weq',
                size: logText.length,
                mtime: now,
              },
            ],
          },
          options,
        ),
    },
  },
  performanceMonitor: {
    status: {
      useQuery: (_input: unknown, options: object) =>
        useFixtureQuery(
          'status',
          {
            host: new URLSearchParams(location.search).get('host') ?? 'desktop',
            settings,
            bytes: qa.storageBytes,
            records: cleared ? 0 : 80,
            oldest: cleared ? null : now - qa.historyAgeDays * 86400_000,
            newest: now,
            session: 'fixture',
            capabilities: [],
            queued: 0,
            dropped: 0,
            deferred: 0,
            collecting: false,
            lastSampleAt: now,
            lastSyncMs: 1,
            lastWaitMs: 0,
            error: null,
            detailIntervalMs: 30_000,
            detailBackoffUntil: null,
          },
          options,
        ),
    },
    history: {
      useQuery: (input: Parameters<typeof history>[0], options: object) =>
        useFixtureQuery('history', history(input), options),
    },
    detail: {
      useQuery: (input: { id: number }, options: { enabled?: boolean }) => {
        if (options.enabled) qa.detailIds.push(input.id);
        return useFixtureQuery(
          'detail',
          {
            at: now,
            syncMs: 1.2,
            waitMs: 2,
            processes: [
              {
                label: '主窗口',
                pid: 2,
                key: '2:2',
                metrics: { heapBytes: 25e6 },
                details: { resources: { retainedImages: 4 } },
              },
            ],
          },
          options,
        );
      },
    },
    configure: {
      useMutation: () =>
        useFixtureMutation((input: MonitorSettings & { fullDurationMinutes?: number | null }) => {
          settings = {
            ...input,
            version: 1,
            fullUntil:
              input.mode === 'full'
                ? input.fullDurationMinutes === undefined && settings.mode === 'full'
                  ? settings.fullUntil
                  : input.fullDurationMinutes === null
                    ? null
                    : Date.now() + (input.fullDurationMinutes ?? 60) * 60_000
                : null,
          };
          qa.changes.push(input);
        }),
    },
    clear: {
      useMutation: () =>
        useFixtureMutation(() => {
          cleared = true;
          qa.clearCount++;
        }),
    },
    export: {
      useMutation: () =>
        useFixtureMutation((input: unknown) => {
          qa.exports.push(input);
          return { path: '/synthetic/performance.jsonl', downloadUrl: null };
        }),
    },
  },
};
export const client = {
  performanceMonitor: {
    previewPrune: {
      query: async (input: { retentionDays: number; capacityMiB: number }) => {
        const expiredRecords = !cleared && qa.historyAgeDays > input.retentionDays ? 12 : 0;
        const capacityBudgetBytes = input.capacityMiB * 1048576 * 0.9;
        const capacityExceeded = !cleared && qa.storageBytes > capacityBudgetBytes;
        return {
          ...input,
          bytes: qa.storageBytes,
          records: cleared ? 0 : 80,
          oldest: cleared ? null : now - qa.historyAgeDays * 86400_000,
          newest: now,
          cutoff: Date.now() - input.retentionDays * 86400_000,
          expiredRecords,
          capacityBudgetBytes,
          capacityExceeded,
          needsPrune: expiredRecords > 0 || capacityExceeded,
        };
      },
    },
  },
  help: {
    setNativeDebugLog: {
      mutate: async (input: { enabled: boolean }) => {
        debug = input.enabled;
        notify();
        return { ok: true, enabled: debug };
      },
    },
    logFileInfo: {
      query: async () => {
        qa.logReads++;
        return { size: logText.length, mtime: now };
      },
    },
    readLogChunk: {
      query: async (input: { offset: number; bytes: number }) => {
        qa.logReads++;
        const offset = Math.max(0, input.offset);
        const text = logText.slice(offset, offset + input.bytes);
        return {
          text,
          nextOffset: offset + text.length,
          eof: offset + text.length >= logText.length,
          size: logText.length,
        };
      },
    },
  },
};
