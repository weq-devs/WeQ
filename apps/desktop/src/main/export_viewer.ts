import { randomUUID } from 'node:crypto';
import { discoverViewerSources, resolveViewerMedia, type ExportViewerSource } from '@weq/service';
import { scanDirectories } from './directory_scan';

export async function discoverExportDirectories(path: string, recursive = false) {
  let partial = false;
  const result = await scanDirectories(
    path,
    async (directory) => {
      const catalog = await discoverViewerSources(directory, true);
      partial ||= catalog.truncated;
      // 旧基线目录索引也会列出子目录；这里按当前层过滤，避免漏掉同层的旧 JSON 导出。
      return catalog.sources.filter(
        (source) => source.root === directory || source.baselineDirectory === directory,
      );
    },
    recursive,
  );
  return {
    sources: result.items,
    truncated: result.truncated || partial,
    unreadable: result.unreadable,
  };
}

/** 仅允许访问本次文件选择得到的来源；关闭查看器后撤销媒体能力。 */
const sources = new Map<string, ExportViewerSource>();
const controllers = new Map<string, AbortController>();
export function registerViewerSource(source: ExportViewerSource) {
  if (sources.size >= 64) throw new Error('打开的导出过多，请关闭部分导出后重试。');
  const id = randomUUID();
  sources.set(id, source);
  controllers.set(id, new AbortController());
  return { ...source, id };
}
export function viewerSource(id: string) {
  const source = sources.get(id);
  if (!source) throw new Error('导出已关闭，请重新打开。');
  return source;
}
export function closeViewerSources(ids: string[]) {
  for (const id of ids) {
    controllers.get(id)?.abort();
    controllers.delete(id);
    sources.delete(id);
  }
}
export function beginViewerRead(id: string): AbortSignal {
  viewerSource(id);
  controllers.get(id)?.abort();
  const controller = new AbortController();
  controllers.set(id, controller);
  return controller.signal;
}
export async function viewerMedia(id: string, path: string) {
  const source = sources.get(id);
  return source ? resolveViewerMedia(source, path) : null;
}
