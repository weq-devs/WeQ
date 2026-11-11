import { app, ipcMain, webContents } from 'electron';
import { cpus } from 'node:os';
import { createNodeCollector } from '@weq/service/performance-node';
import type { MonitorCollector, MonitorProcess } from '@weq/service/performance';
import { MONITOR_REQUEST, MONITOR_RESPONSE } from '../shared/performance_monitor';
import { normalizeRendererExitReason } from './renderer_recovery';
import {
  diagnosticNumber,
  normalizeDevelopmentSample,
  normalizeRendererSample,
} from '../shared/renderer_diagnostics';

export function createDesktopCollector(
  mainId: () => number | undefined,
  extra: () => Record<string, unknown>,
  event: (kind: 'renderer-exit', reason: string) => void,
): MonitorCollector {
  const node = createNodeCollector(extra);
  let mode = 'off';
  let sequence = 0;
  let pending:
    | {
        sequence: number;
        contents: Electron.WebContents;
        pid: number;
        resolve(value: Record<string, unknown> | null): void;
      }
    | undefined;
  const previous = new Map<string, { cpu: number; at: number }>();
  const receive = (source: Electron.IpcMainEvent, seq: unknown, raw: unknown) => {
    if (
      !pending ||
      seq !== pending.sequence ||
      source.sender !== pending.contents ||
      source.senderFrame !== source.sender.mainFrame ||
      source.sender.getOSProcessId() !== pending.pid
    )
      return;
    pending.resolve(raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null);
    pending = undefined;
  };
  const gone = (
    _event: Electron.Event,
    contents: Electron.WebContents,
    details?: Electron.RenderProcessGoneDetails,
  ) => {
    if (pending && pending.contents === contents) {
      pending.resolve(null);
      pending = undefined;
    }
    if (mode !== 'off')
      event('renderer-exit', normalizeRendererExitReason(details?.reason ?? 'unknown'));
  };
  ipcMain.on(MONITOR_RESPONSE, receive);
  app.on('render-process-gone', gone);
  return {
    host: 'desktop',
    capabilities: [
      ...node.capabilities,
      'processes',
      'dom',
      'media',
      'animations',
      'styles',
      'renderer-cache',
    ],
    activate(value) {
      mode = value;
      previous.clear();
      node.activate(value);
      if (value === 'off') {
        pending?.resolve(null);
        pending = undefined;
      }
    },
    async collect(detailed) {
      const start = performance.now();
      const local = await node.collect(detailed);
      const metrics = app.getAppMetrics();
      const processes: MonitorProcess[] = [];
      const now = performance.now();
      const seen = new Set<string>();
      for (const metric of metrics.slice(0, 64)) {
        const key = `${metric.pid}:${metric.creationTime}`;
        seen.add(key);
        const cpu = metric.cpu.cumulativeCPUUsage,
          prev = previous.get(key);
        const cpuPercent =
          typeof cpu === 'number' && prev && now > prev.at
            ? Math.max(
                0,
                Math.min(100, ((cpu - prev.cpu) / ((now - prev.at) / 1000) / cpus().length) * 100),
              )
            : null;
        if (typeof cpu === 'number') previous.set(key, { cpu, at: now });
        const own = metric.pid === process.pid ? local.processes[0] : undefined;
        processes.push({
          key,
          label:
            metric.pid === process.pid
              ? '主进程'
              : metric.type === 'Tab'
                ? '渲染进程'
                : metric.type,
          pid: metric.pid,
          createdAt: metric.creationTime,
          metrics: {
            cpuPercent,
            residentBytes: metric.memory.workingSetSize * 1024,
            heapBytes: own?.metrics.heapBytes ?? null,
            externalBytes: own?.metrics.externalBytes ?? null,
            eventLoopP95Ms: own?.metrics.eventLoopP95Ms ?? null,
          },
          details: detailed
            ? {
                ...own?.details,
                privateBytes:
                  metric.memory.privateBytes === undefined
                    ? null
                    : metric.memory.privateBytes * 1024,
              }
            : undefined,
        });
      }
      for (const key of previous.keys()) if (!seen.has(key)) previous.delete(key);
      let syncMs = performance.now() - start;
      const main = webContents.getAllWebContents().find((content) => content.id === mainId());
      const proc = main && processes.find((item) => item.pid === main.getOSProcessId());
      let waitMs = local.waitMs,
        detailSyncMs = local.detailSyncMs ?? 0;
      const unavailable: string[] = [];
      if (main && proc && !main.isDestroyed() && !main.isCrashed()) {
        const began = performance.now();
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const response = await new Promise<Record<string, unknown> | null>((resolve) => {
          pending = { sequence: ++sequence, contents: main, pid: proc.pid, resolve };
          timeout = setTimeout(() => {
            pending = undefined;
            resolve(null);
          }, 3000);
          main.send(MONITOR_REQUEST, sequence, detailed);
        });
        clearTimeout(timeout);
        waitMs += Math.max(
          0,
          performance.now() - began - (diagnosticNumber(response?.syncMs) ?? 0),
        );
        if (response) {
          const sample = normalizeRendererSample(response);
          proc.label = '主窗口';
          proc.metrics.heapBytes = sample.jsHeapUsedBytes;
          proc.metrics.externalBytes = sample.externalBytes;
          proc.details = {
            resources: sample.resources,
            ...(detailed ? { renderer: normalizeDevelopmentSample(response.development) } : {}),
          };
          syncMs += diagnosticNumber(response.syncMs) ?? 0;
          detailSyncMs += diagnosticNumber(response.detailSyncMs) ?? 0;
        } else unavailable.push('renderer');
      } else unavailable.push('renderer');
      return {
        processes,
        syncMs,
        waitMs,
        detailSyncMs: detailed ? detailSyncMs : undefined,
        unavailable,
      };
    },
    dispose() {
      mode = 'off';
      pending?.resolve(null);
      pending = undefined;
      node.dispose();
      ipcMain.off(MONITOR_RESPONSE, receive);
      app.off('render-process-gone', gone);
    },
  };
}
