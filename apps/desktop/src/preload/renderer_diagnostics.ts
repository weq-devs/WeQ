import { ipcRenderer } from 'electron';
import {
  DIAGNOSTIC_SAMPLE_REQUEST,
  DIAGNOSTIC_SAMPLE_RESPONSE,
  RESOURCE_DIAGNOSTIC_ID,
  RESOURCE_DIAGNOSTIC_REQUEST,
} from '../shared/renderer_diagnostics';

/** 只响应主进程的分钟采样，不暴露网页调用入口或读取正文。 */
export function installRendererDiagnosticSampling(): void {
  ipcRenderer.on(DIAGNOSTIC_SAMPLE_REQUEST, (_event, sequence: unknown) => {
    if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 1) return;
    try {
      const memory = process.memoryUsage();
      let blink: Electron.BlinkMemoryInfo | null = null;
      try {
        blink = process.getBlinkMemoryInfo();
      } catch {
        // 其余可取得指标仍上报。
      }
      const preloadDocument = (
        globalThis as typeof globalThis & {
          document?: {
            dispatchEvent(event: Event): boolean;
            getElementById(id: string): { getAttribute(name: string): string | null } | null;
            getElementsByTagName(name: '*'): { length: number };
          };
        }
      ).document;
      let resources: unknown = null;
      if (preloadDocument) {
        preloadDocument.dispatchEvent(new Event(RESOURCE_DIAGNOSTIC_REQUEST));
        const raw = preloadDocument.getElementById(RESOURCE_DIAGNOSTIC_ID)?.getAttribute('content');
        if (raw && raw.length <= 2048) {
          try {
            resources = JSON.parse(raw);
          } catch {
            /* 未就绪时保留未知值。 */
          }
        }
      }
      ipcRenderer.send(DIAGNOSTIC_SAMPLE_RESPONSE, sequence, {
        jsHeapUsedBytes: memory.heapUsed,
        jsHeapTotalBytes: memory.heapTotal,
        externalBytes: memory.external,
        arrayBuffersBytes: memory.arrayBuffers,
        blinkAllocatedKB: blink?.allocated,
        blinkTotalKB: blink?.total,
        domNodes: preloadDocument?.getElementsByTagName('*').length,
        resources,
      });
    } catch {
      ipcRenderer.send(DIAGNOSTIC_SAMPLE_RESPONSE, sequence, null);
    }
  });
}
