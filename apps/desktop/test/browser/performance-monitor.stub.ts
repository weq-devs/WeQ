import { useState } from 'react';
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
export const qa = {
  requests: [] as Array<{ route: string; enabled: boolean }>,
  changes: [] as unknown[],
  exports: [] as unknown[],
  setActive: (_value: boolean) => {},
  clearCount: 0,
  detailIds: [] as number[],
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
function query<T>(route: string, value: T, options?: { enabled?: boolean }) {
  qa.requests.push({ route, enabled: options?.enabled !== false });
  return {
    data: value,
    error: fixture === 'error' && route === 'history' ? { message: '合成读取失败' } : null,
    isLoading: false,
    refetch: async () => {},
  };
}
function useFixtureMutation(run: (input: never) => unknown) {
  const [, update] = useState(0);
  return {
    isLoading: false,
    mutateAsync: async (input: never) => {
      const result = run(input);
      update((value) => value + 1);
      return result;
    },
  };
}
export const trpc = {
  useUtils: () => ({ performanceMonitor: { invalidate: async () => {} } }),
  performanceMonitor: {
    status: {
      useQuery: (_input: unknown, options: object) =>
        query(
          'status',
          {
            host: new URLSearchParams(location.search).get('host') ?? 'desktop',
            settings,
            bytes: 42_000,
            records: cleared ? 0 : 80,
            oldest: cleared ? null : now - 2400_000,
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
        query('history', history(input), options),
    },
    detail: {
      useQuery: (input: { id: number }, options: { enabled?: boolean }) => {
        if (options.enabled) qa.detailIds.push(input.id);
        return query(
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
                ? input.fullDurationMinutes === null
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
export const client = {};
