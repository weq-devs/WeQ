import { z } from 'zod';
import { getPerformanceMonitor } from '@weq/service/performance';
import { getHost } from '@weq/service';
import { basename } from 'node:path';
import { procedure, router } from '../trpc';

const timestamp = z.number().finite().min(0).max(8.64e15);
const range = z
  .object({
    from: timestamp,
    to: timestamp,
    buckets: z.number().int().min(1).max(1200).default(400),
    process: z.string().max(128).optional(),
  })
  .refine((value) => value.to > value.from, '结束时间须晚于开始时间');
const config = z.object({
  mode: z.enum(['off', 'light', 'full']),
  retentionDays: z.number().int().min(1).max(365),
  capacityMiB: z.union([z.literal(64), z.literal(128), z.literal(256), z.literal(512)]),
  fullDurationMinutes: z.union([z.literal(15), z.literal(60), z.literal(240), z.null()]).optional(),
  confirmPrune: z.boolean().default(false),
});
export const performanceMonitorRouter = router({
  status: procedure.query(() => getPerformanceMonitor().status()),
  configure: procedure.input(config).mutation(async ({ input }) => {
    const monitor = getPerformanceMonitor();
    await monitor.ready;
    if (
      !input.confirmPrune &&
      (input.retentionDays < monitor.settings.retentionDays ||
        input.capacityMiB < monitor.settings.capacityMiB)
    )
      throw new Error('缩短保存期或降低容量会删除最旧历史，请确认后重试');
    const fullUntil =
      input.mode !== 'full'
        ? null
        : input.fullDurationMinutes === undefined && monitor.settings.mode === 'full'
          ? monitor.settings.fullUntil
          : input.fullDurationMinutes === null
            ? null
            : Date.now() + (input.fullDurationMinutes ?? 60) * 60_000;
    return monitor.configure({
      version: 1,
      mode: input.mode,
      retentionDays: input.retentionDays,
      capacityMiB: input.capacityMiB,
      fullUntil,
    });
  }),
  history: procedure.input(range).query(({ input }) => getPerformanceMonitor().history(input)),
  detail: procedure
    .input(z.object({ id: z.number().int().positive() }))
    .query(({ input }) => getPerformanceMonitor().detail(input.id)),
  exportPage: procedure
    .input(
      z
        .object({
          from: timestamp,
          to: timestamp,
          after: z.number().int().nonnegative().default(0),
        })
        .refine((value) => value.to > value.from),
    )
    .query(({ input }) => getPerformanceMonitor().exportPage(input.from, input.to, input.after)),
  export: procedure
    .input(z.object({ range, format: z.enum(['jsonl', 'csv']) }))
    .mutation(async ({ input }) => {
      const monitor = getPerformanceMonitor(),
        host = getHost();
      const target = await host.pickSaveTarget({
        defaultName: `weq-performance-${Date.now()}.${input.format}`,
        extension: input.format,
        locationKey: 'performance-monitor',
      });
      if (!target) return null;
      await monitor.exportFile(target.path, input.range, input.format);
      const download = host.registerDownload?.(target.path, basename(target.path), 'file');
      return { path: target.path, downloadUrl: download?.url ?? null };
    }),
  clear: procedure.input(z.literal(true)).mutation(() => getPerformanceMonitor().clear()),
});
