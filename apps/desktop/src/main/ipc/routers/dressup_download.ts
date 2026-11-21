import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  writeZipFile,
  type ResourceExportRunContext,
  type ResourceExportSummary,
} from '@weq/service';
import {
  buildDecorationFile,
  type DressExportKind,
  type DressExportServices,
} from './dressup_export';
import { downloadUrlMedia } from './media_save';

type DownloadKind = DressExportKind | 'callbg';

interface DownloadItem {
  itemId: number;
  name: string;
  mediaUrl?: string;
}

export async function runDressDownload(
  services: DressExportServices,
  kind: DownloadKind,
  items: readonly DownloadItem[],
  bundleName: string,
  context: ResourceExportRunContext,
  check: () => void,
): Promise<ResourceExportSummary> {
  const { directory, signal, progress } = context;
  async function saveItem(item: DownloadItem, target: string): Promise<string> {
    check();
    signal.throwIfAborted();
    if (kind === 'callbg') {
      if (!item.mediaUrl) throw new Error('通话背景素材地址不可用');
      return downloadUrlMedia(
        item.mediaUrl,
        `WeQ-通话背景-${item.itemId} ${item.name}`,
        {
          directory: target,
          signal,
        },
        check,
      );
    }
    const result = await buildDecorationFile(
      services,
      {
        bubbleId: kind === 'bubble' ? item.itemId : 0,
        fontId: kind === 'font' ? item.itemId : 0,
        widgetId: kind === 'widget' ? item.itemId : 0,
      },
      kind,
    );
    check();
    await writeFile(join(target, result.fileName), result.bytes, { flag: 'wx', signal });
    return result.fileName;
  }
  progress(0, items.length);
  if (items.length === 1) {
    const fileName = await saveItem(items[0]!, directory);
    check();
    signal.throwIfAborted();
    return { fileName, total: 1, ok: 1, failed: [] };
  }

  const stage = join(directory, 'sources');
  await mkdir(stage);
  const entries: { name: string; path: string }[] = [];
  const failed: ResourceExportSummary['failed'] = [];
  try {
    for (const [index, item] of items.entries()) {
      try {
        const name = await saveItem(item, stage);
        entries.push({ name, path: join(stage, name) });
      } catch (error) {
        check();
        signal.throwIfAborted();
        failed.push({
          fileName: `${item.name} (#${item.itemId})`,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      progress(index + 1, items.length);
    }
    if (!entries.length) throw new Error(failed[0]?.error ?? '没有可下载的装扮');
    await writeZipFile(join(directory, bundleName), entries, { signal });
    check();
    return {
      fileName: bundleName,
      total: 1,
      ok: 1,
      failed: [],
      contents: { total: items.length, ok: entries.length, failed },
    };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
