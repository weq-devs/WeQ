import { ipcRenderer, webFrame } from 'electron';
import {
  DIAGNOSTIC_SAMPLE_REQUEST,
  DIAGNOSTIC_SAMPLE_RESPONSE,
  RESOURCE_DIAGNOSTIC_ID,
  RESOURCE_DIAGNOSTIC_REQUEST,
} from '../shared/renderer_diagnostics';

/** 只响应主进程采样，不暴露网页调用入口或读取正文。 */
export function installRendererDiagnosticSampling(): void {
  ipcRenderer.on(DIAGNOSTIC_SAMPLE_REQUEST, (_event, sequence: unknown, development: unknown) => {
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
            getAnimations?(): { playState: string }[];
            visibilityState?: string;
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
      let developmentSample: object | undefined;
      if (development === true) {
        let caches: Electron.ResourceUsage | null = null;
        let animations: { playState: string }[] | undefined;
        try {
          caches = webFrame.getResourceUsage();
        } catch {
          // 未提供缓存统计的平台保留未知值，不影响基础采样。
        }
        try {
          animations = preloadDocument?.getAnimations?.();
        } catch {
          // 导航或销毁期间动画统计可能不可用。
        }
        developmentSample = {
          caches,
          animations: animations?.length,
          runningAnimations: animations?.filter((animation) => animation.playState === 'running')
            .length,
          documentVisible:
            typeof preloadDocument?.visibilityState === 'string'
              ? preloadDocument.visibilityState === 'visible'
              : null,
        };
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
        ...(developmentSample ? { development: developmentSample } : {}),
      });
    } catch {
      ipcRenderer.send(DIAGNOSTIC_SAMPLE_RESPONSE, sequence, null);
    }
  });
}
