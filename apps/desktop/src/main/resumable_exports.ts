import { open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  exportOnlineFavoriteEmojiBundle,
  type ResumableResourceRequest,
  type ResourceExportRunContext,
  type ResourceExportSummary,
} from '@weq/service';
import { exportAllMailMessages, exportMailMessages } from '@weq/service/mail';
import type { AccountServices } from './context/app_context';

/** 仅保存内容选择；恢复时重新使用当前账号的邮箱和表情服务，不持久化登录凭据。 */
export async function runResumableExport(
  services: Pick<AccountServices, 'mail' | 'emoji' | 'fileResource'>,
  request: ResumableResourceRequest,
  context: ResourceExportRunContext,
  current: () => void,
): Promise<ResourceExportSummary> {
  current();
  context.signal.throwIfAborted();
  if (request.type === 'mail') {
    return request.ids === null
      ? exportAllMailMessages(services.mail, context, current, request.filter, request.archive)
      : exportMailMessages(
          services.mail,
          request.ids,
          context,
          current,
          request.filter,
          request.expandThreads,
          request.archive,
        );
  }
  const result = await exportOnlineFavoriteEmojiBundle(services.emoji, {
    current,
    signal: context.signal,
    progress: context.progress,
    checkpoint: context.checkpoint,
    readLocal: async (path) => {
      const safe = await services.fileResource.resolveLocalFile(path);
      current();
      if (!safe) return null;
      const handle = await open(safe, 'r');
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size < 1 || info.size > 20 * 1024 * 1024) return null;
        const bytes = Buffer.alloc(info.size + 1);
        let filled = 0;
        while (filled < bytes.length) {
          context.signal.throwIfAborted();
          const read = await handle.read(bytes, filled, bytes.length - filled, filled);
          if (!read.bytesRead) break;
          filled += read.bytesRead;
        }
        current();
        return filled === info.size ? bytes.subarray(0, filled) : null;
      } finally {
        await handle.close();
      }
    },
  });
  current();
  context.signal.throwIfAborted();
  const fileName = 'favorite-emoji.zip';
  await writeFile(join(context.directory, fileName), result.archive, { signal: context.signal });
  return {
    fileName,
    total: 1,
    ok: 1,
    failed: [],
    contents: {
      total: result.total,
      ok: result.written,
      failed: result.failed.map((item) => ({
        fileName: `${item.position}. ${item.description || '未命名表情'}`,
        error: item.error,
      })),
    },
  };
}
