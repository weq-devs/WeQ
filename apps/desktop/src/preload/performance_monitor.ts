import { ipcRenderer, webFrame } from 'electron';
import {
  MONITOR_REQUEST,
  MONITOR_RESPONSE,
  RESOURCE_LIGHT_REQUEST,
} from '../shared/performance_monitor';
import { RESOURCE_DIAGNOSTIC_ID } from '../shared/renderer_diagnostics';
import { collectBatchedDevelopmentDetails, type MonitorDocument } from './development_diagnostics';

/** 同步区间仅由隔离验收入口启用；日常入口不额外保留追踪数组。 */
export function installPerformanceSampling(options?: { recordSpans?: boolean }) {
  let collecting = false;
  let memoryAvailable = true;
  ipcRenderer.on(MONITOR_REQUEST, async (_event, sequence: unknown, detailed: unknown) => {
    if (
      typeof sequence !== 'number' ||
      !Number.isSafeInteger(sequence) ||
      sequence < 1 ||
      collecting
    )
      return;
    collecting = true;
    try {
      const document = (globalThis as typeof globalThis & { document: MonitorDocument }).document;
      const spans: Array<{ at: number; duration: number }> = [];
      const recordSpan = (started: number, duration = performance.now() - started) => {
        if (options?.recordSpans && spans.length < 256)
          spans.push({ at: performance.timeOrigin + started, duration });
        return duration;
      };
      let syncMs = 0,
        waitMs = 0,
        start = performance.now();
      const heap = process.getHeapStatistics();
      document.dispatchEvent(new Event(RESOURCE_LIGHT_REQUEST));
      const raw = document.getElementById(RESOURCE_DIAGNOSTIC_ID)?.getAttribute('content');
      let resources: unknown = null;
      if (raw && raw.length <= 2048) {
        try {
          resources = JSON.parse(raw);
        } catch {
          /* 下一轮重试。 */
        }
      }
      syncMs += recordSpan(start);
      let development: Record<string, unknown> | undefined;
      let detailSyncMs = 0;
      if (detailed === true) {
        let processMemory: object | null = null;
        if (memoryAvailable) {
          start = performance.now();
          let timer: ReturnType<typeof setTimeout> | undefined;
          let nativeSync: number | undefined;
          try {
            const memory = process.getProcessMemoryInfo();
            nativeSync = recordSpan(start);
            detailSyncMs += nativeSync;
            const info = await Promise.race([
              memory,
              new Promise<null>((resolve) => {
                timer = setTimeout(() => resolve(null), 500);
              }),
            ]);
            if (info)
              processMemory = {
                privateKB: info.private,
                sharedKB: info.shared,
                residentSetKB: info.residentSet,
              };
            else memoryAvailable = false;
          } catch {
            if (nativeSync === undefined) {
              nativeSync = recordSpan(start);
              detailSyncMs += nativeSync;
            }
            memoryAvailable = false;
          } finally {
            clearTimeout(timer);
            waitMs += Math.max(0, performance.now() - start - (nativeSync ?? 0));
          }
        }
        const idle = (
          globalThis as typeof globalThis & {
            requestIdleCallback?: (callback: () => void, options: { timeout: number }) => number;
          }
        ).requestIdleCallback;
        const details = await collectBatchedDevelopmentDetails(
          document,
          options?.recordSpans ? recordSpan : undefined,
          () =>
            new Promise<void>((resolve) => {
              if (idle) idle.call(globalThis, resolve, { timeout: 50 });
              else setTimeout(resolve, 0);
            }),
        );
        detailSyncMs += details.syncMs;
        waitMs += details.waitMs;
        start = performance.now();
        let caches: Electron.ResourceUsage | null = null;
        try {
          caches = webFrame.getResourceUsage();
        } catch {
          /* 指标缺失不冒充零。 */
        }
        detailSyncMs += recordSpan(start);
        development = {
          ...details.value,
          caches,
          processMemory,
          heap,
          documentVisible: document.visibilityState === 'visible',
        };
      }
      ipcRenderer.send(MONITOR_RESPONSE, sequence, {
        jsHeapUsedBytes: heap.usedHeapSize * 1024,
        jsHeapTotalBytes: heap.totalHeapSize * 1024,
        resources,
        development,
        syncMs: syncMs + detailSyncMs,
        waitMs,
        detailSyncMs,
        ...(options?.recordSpans ? { syncSpans: spans } : {}),
      });
    } catch {
      ipcRenderer.send(MONITOR_RESPONSE, sequence, null);
    } finally {
      collecting = false;
    }
  });
}
