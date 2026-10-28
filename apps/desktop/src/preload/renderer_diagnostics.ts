import { ipcRenderer, webFrame } from 'electron';
import {
  DIAGNOSTIC_SAMPLE_REQUEST,
  DIAGNOSTIC_SAMPLE_RESPONSE,
  RESOURCE_DIAGNOSTIC_ID,
  RESOURCE_DIAGNOSTIC_REQUEST,
} from '../shared/renderer_diagnostics';
import {
  collectDevelopmentDetails,
  type DevelopmentDiagnosticDocument,
  type DiagnosticAnimation,
} from './development_diagnostics';

/** 只响应主进程采样，不暴露网页调用入口或读取正文。 */
export function installRendererDiagnosticSampling(): void {
  let collecting = false;
  let processMemoryAvailable = true;
  ipcRenderer.on(
    DIAGNOSTIC_SAMPLE_REQUEST,
    async (_event, sequence: unknown, development: unknown) => {
      if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 1) return;
      if (collecting) return;
      collecting = true;
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
              getAnimations?(): DiagnosticAnimation[];
              querySelectorAll?: DevelopmentDiagnosticDocument['querySelectorAll'];
              styleSheets?: DevelopmentDiagnosticDocument['styleSheets'];
              visibilityState?: string;
            };
          }
        ).document;
        let resources: unknown = null;
        if (preloadDocument) {
          preloadDocument.dispatchEvent(new Event(RESOURCE_DIAGNOSTIC_REQUEST));
          const raw = preloadDocument
            .getElementById(RESOURCE_DIAGNOSTIC_ID)
            ?.getAttribute('content');
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
          const started = performance.now();
          let heap: Electron.HeapStatistics | null = null;
          let processMemory: object | null = null;
          try {
            heap = process.getHeapStatistics();
          } catch {
            /* 当前平台缺测。 */
          }
          let deadline: ReturnType<typeof setTimeout> | undefined;
          if (processMemoryAvailable)
            try {
              const info = await Promise.race([
                process.getProcessMemoryInfo(),
                new Promise<null>((resolve) => {
                  deadline = setTimeout(() => resolve(null), 500);
                }),
              ]);
              if (info)
                processMemory = {
                  privateKB: info.private,
                  sharedKB: info.shared,
                  residentSetKB: info.residentSet,
                };
              else processMemoryAvailable = false;
            } catch {
              processMemoryAvailable = false; /* 失败/超时后不重复堆积原生请求。 */
            } finally {
              if (deadline !== undefined) clearTimeout(deadline);
            }
          let caches: Electron.ResourceUsage | null = null;
          let animations: DiagnosticAnimation[] | undefined;
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
            ...collectDevelopmentDetails(
              preloadDocument?.querySelectorAll
                ? {
                    querySelectorAll: (selector) => preloadDocument.querySelectorAll!(selector),
                    styleSheets: preloadDocument.styleSheets,
                  }
                : undefined,
              animations,
            ),
            caches,
            heap,
            processMemory,
            animations: animations?.length,
            runningAnimations: animations?.filter((animation) => animation.playState === 'running')
              .length,
            documentVisible:
              typeof preloadDocument?.visibilityState === 'string'
                ? preloadDocument.visibilityState === 'visible'
                : null,
            sampleDurationMs: performance.now() - started,
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
        try {
          ipcRenderer.send(DIAGNOSTIC_SAMPLE_RESPONSE, sequence, null);
        } catch {
          // 导航或销毁时通道可能已关闭，不让诊断抛出异步异常。
        }
      } finally {
        collecting = false;
      }
    },
  );
}
