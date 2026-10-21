import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { diagnosticNumber } from '../shared/renderer_diagnostics';

export type DiagnosticPageCategory =
  | 'main'
  | 'qzone'
  | 'channel'
  | 'embedded-other'
  | 'window-other';
export interface DiagnosticPage {
  id: number;
  pid: number;
  category: DiagnosticPageCategory;
}

export function classifyDiagnosticPage(
  main: boolean,
  url: string,
  type: string,
): DiagnosticPageCategory {
  if (main) return 'main';
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:') {
      if (parsed.hostname === 'qzone.qq.com' || parsed.hostname.endsWith('.qzone.qq.com'))
        return 'qzone';
      if (parsed.hostname === 'pd.qq.com' || parsed.hostname.endsWith('.pd.qq.com'))
        return 'channel';
    }
  } catch {
    // 空白／销毁中的页面只记录宿主类别。
  }
  return type === 'webview' ? 'embedded-other' : 'window-other';
}

const PROCESS_TYPES = new Set([
  'Browser',
  'Tab',
  'Utility',
  'Zygote',
  'Sandbox helper',
  'GPU',
  'Pepper Plugin',
  'Pepper Plugin Broker',
  'Unknown',
]);
export const DIAGNOSTIC_PROCESS_LIMIT = 32;
export const DIAGNOSTIC_PAGE_LIMIT = 64;
export const DIAGNOSTIC_INTERVAL_MS = 60_000;

export function projectDiagnosticProcesses(
  metrics: readonly {
    pid: number;
    creationTime: number;
    type: string;
    memory: { workingSetSize: number; peakWorkingSetSize: number; privateBytes?: number };
  }[],
  pages: readonly DiagnosticPage[],
) {
  return metrics.slice(0, DIAGNOSTIC_PROCESS_LIMIT).map((metric) => {
    const matches = pages.filter((page) => page.pid === metric.pid);
    return {
      pid: diagnosticNumber(metric.pid),
      createdAtMs: diagnosticNumber(metric.creationTime),
      type: PROCESS_TYPES.has(metric.type) ? metric.type : 'Unknown',
      workingSetKB: diagnosticNumber(metric.memory.workingSetSize),
      peakWorkingSetKB: diagnosticNumber(metric.memory.peakWorkingSetSize),
      privateBytesKB: diagnosticNumber(metric.memory.privateBytes),
      pages: matches.slice(0, 8).map((page) => ({ id: page.id, category: page.category })),
      omittedPages: Math.max(0, matches.length - 8),
    };
  });
}

/** 专用双文件环：不让诊断本身形成无界日志或内存队列。 */
export function createDiagnosticLog(
  directory: string,
  limits = { maxBytes: 2 * 1024 * 1024, maxEntries: 1440 },
) {
  const current = join(directory, 'memory-diagnostics.jsonl');
  const previous = join(directory, 'memory-diagnostics.previous.jsonl');
  let entries: number | null = null;
  return {
    write(record: object): boolean {
      try {
        const line = `${JSON.stringify(record)}\n`;
        const bytes = Buffer.byteLength(line);
        if (bytes > limits.maxBytes) return false;
        mkdirSync(directory, { recursive: true });
        let size = 0;
        try {
          size = statSync(current).size;
        } catch {
          /* 首条记录。 */
        }
        if (entries === null) {
          entries =
            size > 0 && size <= limits.maxBytes
              ? readFileSync(current, 'utf8').split('\n').length - 1
              : 0;
        }
        if (size + bytes > limits.maxBytes || entries >= limits.maxEntries) {
          rmSync(previous, { force: true });
          if (size > 0) renameSync(current, previous);
          entries = 0;
        }
        appendFileSync(current, line, { encoding: 'utf8', mode: 0o600 });
        entries += 1;
        return true;
      } catch {
        return false;
      }
    },
  };
}
