import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  saveExportOutput,
  writeZipFile,
  type ResourceExportRunContext,
  type ResourceExportSummary,
} from '@weq/service';
import { ExportCheckpointError } from '@weq/service/export-checkpoint';
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
  const { directory, signal, progress, checkpoint } = context;
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
  const prepareItem = async (item: DownloadItem, staging: string) => {
    if (!checkpoint) {
      const name = await saveItem(item, staging);
      return { name, path: join(staging, name) };
    }
    const target = join(checkpoint.directory, 'dress-items', String(item.itemId));
    const name = await checkpoint.run(
      ['dress-item', kind, item.itemId],
      async () => {
        await rm(target, { recursive: true, force: true });
        await mkdir(target, { recursive: true });
        return saveItem(item, target);
      },
      (name) => [join(target, name)],
    );
    return { name, path: join(target, name) };
  };
  progress(0, items.length);
  if (items.length === 1) {
    const { name: fileName, path } = await prepareItem(items[0]!, directory);
    if (checkpoint) {
      const out = join(directory, fileName);
      await checkpoint.file(['dress-result', fileName], out, () =>
        saveExportOutput({ name: fileName, filePath: path }, { filePath: out }, signal),
      );
    }
    check();
    signal.throwIfAborted();
    return { fileName, total: 1, ok: 1, failed: [] };
  }

  const stage = join(directory, 'sources');
  if (!checkpoint) await mkdir(stage);
  const entries: { name: string; path: string }[] = [];
  const failed: ResourceExportSummary['failed'] = [];
  try {
    for (const [index, item] of items.entries()) {
      try {
        entries.push(await prepareItem(item, stage));
      } catch (error) {
        check();
        signal.throwIfAborted();
        if (error instanceof ExportCheckpointError) throw error;
        failed.push({
          fileName: `${item.name} (#${item.itemId})`,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      progress(index + 1, items.length);
    }
    if (!entries.length) throw new Error(failed[0]?.error ?? '没有可下载的装扮');
    const out = join(directory, bundleName);
    const zip = () => writeZipFile(out, entries, { signal });
    if (checkpoint) await checkpoint.file(['dress-bundle', bundleName], out, zip);
    else await zip();
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
