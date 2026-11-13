import { cpus } from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { MonitorCollector } from './index';
import type { MonitorMode } from './types';
import { enableRequestMetrics, requestMetrics } from './requests';

export function createNodeCollector(extra?: () => Record<string, unknown>): MonitorCollector {
  let histogram: ReturnType<typeof monitorEventLoopDelay> | undefined;
  let cpu = process.cpuUsage(),
    began = performance.now();
  let measured = false;
  const createdAt = Date.now() - process.uptime() * 1000;
  const cores = cpus().length;
  const activate = (mode: MonitorMode) => {
    enableRequestMetrics(mode === 'full');
    if (mode === 'off') {
      histogram?.disable();
      histogram = undefined;
    } else if (!histogram) {
      histogram = monitorEventLoopDelay({ resolution: 100 });
      histogram.enable();
    }
    cpu = process.cpuUsage();
    began = performance.now();
    measured = false;
    histogram?.reset();
  };
  return {
    host: 'web',
    capabilities: ['cpu', 'resident-memory', 'js-heap', 'event-loop', 'requests', 'database'],
    activate,
    async collect(detailed) {
      const start = performance.now(),
        elapsed = start - began,
        usage = process.cpuUsage(cpu);
      cpu = process.cpuUsage();
      began = start;
      const memory = process.memoryUsage();
      const loop = histogram && histogram.count > 0 ? histogram.percentile(95) / 1e6 : null;
      histogram?.reset();
      const details = detailed ? { requests: requestMetrics(), ...extra?.() } : undefined;
      const syncMs = performance.now() - start;
      const cpuPercent =
        measured && elapsed > 0
          ? Math.min(100, ((usage.user + usage.system) / (elapsed * 1000 * cores)) * 100)
          : null;
      measured = true;
      return {
        processes: [
          {
            key: `${process.pid}:${createdAt}`,
            label: 'Web 服务',
            pid: process.pid,
            createdAt,
            metrics: {
              cpuPercent: cpuPercent,
              residentBytes: memory.rss,
              heapBytes: memory.heapUsed,
              externalBytes: memory.external,
              eventLoopP95Ms: loop,
            },
            details,
          },
        ],
        syncMs,
        waitMs: 0,
        detailSyncMs: detailed ? syncMs : undefined,
      };
    },
    dispose() {
      activate('off');
    },
  };
}
