import { lstat, open, statfs, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import {
  exportOnlineFavoriteEmojiBundle,
  assertDestinationCapacity,
  getHost,
  requireDevelopmentDressTools,
  saveExportOutput,
  type ResumableResourceRequest,
  type ResourceExportRunContext,
  type ResourceExportSummary,
} from '@weq/service';
import { exportAllMailMessages, exportMailMessages, MailFailure } from '@weq/service/mail';
import { runResumableAlbumResource, runResumableQzoneAlbumMedia } from './account_resource_exports';
import type { AccountServices } from './context/app_context';

/** 仅保存内容选择；恢复时重新使用当前账号的邮箱和表情服务，不持久化登录凭据。 */
export async function runResumableExport(
  services: AccountServices | Pick<AccountServices, 'mail' | 'emoji' | 'fileResource'>,
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
  if (request.type === 'annual-report' || request.type === 'decoration') {
    const { directory, signal, checkpoint, stagedInput } = context;
    const { fileName } = request;
    if (!stagedInput || basename(fileName) !== fileName || ['', '.', '..'].includes(fileName))
      throw new Error('原始输入或输出名称不可用。');
    const path = join(directory, fileName);
    const generate = async () => {
      const render = request.type === 'annual-report' && request.extension !== 'html';
      const host = getHost();
      const bytes = render
        ? request.extension === 'pdf'
          ? await host.renderHtmlToPdf(stagedInput.toString('utf8'))
          : await host.renderHtmlToLongPng(stagedInput.toString('utf8'))
        : stagedInput;
      current();
      signal.throwIfAborted();
      await writeFile(path, bytes, { flag: 'wx', signal });
    };
    if (checkpoint) await checkpoint.file([request.type, fileName], path, generate);
    else await generate();
    return { total: 1, ok: 1, failed: [], fileName };
  }
  if (request.type === 'analytics-report') {
    const { runAnalyticsResource } = await import('./analytics_save');
    return runAnalyticsResource(request.fileName, context, current);
  }
  if (request.type === 'composition') {
    if (!('accountConfig' in services)) throw new Error('账号资源服务不可用，无法继续导出。');
    const { runCompositionResource } = await import('./ipc/routers/merge_forward');
    return runCompositionResource(services, context, current);
  }
  if (request.type === 'dress-download') {
    if (!('msgDecoration' in services)) throw new Error('账号资源服务不可用，无法继续导出。');
    requireDevelopmentDressTools();
    const { runDressDownload } = await import('./ipc/routers/dressup_download');
    return runDressDownload(
      services,
      request.kind,
      request.items,
      request.bundleName,
      context,
      current,
    );
  }
  if (request.type === 'qzone-videos') {
    if (!('webQuery' in services)) throw new Error('账号资源服务不可用，无法继续导出。');
    const { runQzoneVideoResource } = await import('./ipc/routers/qzone');
    return runQzoneVideoResource(services, request, context, current);
  }
  if (request.type === 'assistant-artifact' || request.type === 'database') {
    if (!('assistant' in services)) throw new Error('账号资源服务不可用，无法继续导出。');
    if (request.type === 'database') {
      const { directory, signal, checkpoint, progress } = context;
      assertDestinationCapacity(
        join(directory, 'database'),
        request.items.map(({ dbPath }) => dbPath),
      );
      const receipts = await services.dbDecrypt.decryptDatabases({
        items: request.items,
        outputDir: directory,
        mode: request.mode,
        concurrency: 3,
        signal,
        onProgress: progress,
        checkpoint,
      });
      current();
      signal.throwIfAborted();
      const failed: ResourceExportSummary['failed'] = [];
      let ok = 0;
      for (const receipt of receipts) {
        if (dirname(receipt.outPath) !== directory)
          throw new Error('解密器返回了不属于本次任务的输出位置。');
        const info = await lstat(receipt.outPath).catch(() => null);
        if (receipt.ok && info?.isFile() && info.size > 0) ok++;
        else {
          if (info) await unlink(receipt.outPath);
          failed.push({
            fileName: receipt.name,
            error: receipt.error || '解密器没有生成有效文件。',
          });
        }
      }
      return {
        total: request.items.length,
        ok,
        failed,
        ...(request.items.length === 1 && ok === 1
          ? { fileName: basename(receipts[0]!.outPath) }
          : {}),
      };
    }
    const { directory, signal, checkpoint } = context;
    const { fileName } = request;
    if (basename(fileName) !== fileName || ['', '.', '..'].includes(fileName))
      throw new Error('原文件输出名称无效。');
    const destination = join(directory, fileName);
    const copy = async () => {
      const { path } = services.assistant.artifactInfo(request.id);
      if (extname(path) !== extname(fileName)) throw new Error('报告来源已改变，请重新选择。');
      await saveExportOutput(
        { name: request.name, filePath: path },
        { filePath: destination },
        signal,
      );
      current();
    };
    if (checkpoint) await checkpoint.file(['assistant-artifact', request.id], destination, copy);
    else await copy();
    return { total: 1, ok: 1, failed: [], fileName };
  }
  if (request.type === 'mail-attachment' || request.type === 'market-image') {
    const { fileName } = request;
    if (basename(fileName) !== fileName || ['', '.', '..'].includes(fileName))
      throw new Error('原文件输出名称无效。');
    const path = join(context.directory, fileName);
    const download = async () => {
      if (request.type === 'mail-attachment') {
        const detail = await services.mail.read(request.mailId, context.signal, false);
        current();
        const matches = detail.attachments.filter(
          (item) =>
            item.available &&
            item.sourceKey === request.sourceKey &&
            item.name === request.name &&
            item.size === request.size &&
            item.big === request.big,
        );
        if (detail.id !== request.mailId || matches.length !== 1)
          throw new MailFailure('business', '待续作附件已发生变化，请重新选择。');
        const space = await statfs(context.directory);
        current();
        if (space.bavail * space.bsize < request.size + 64 * 1024 * 1024)
          throw new MailFailure('business', '目标磁盘空间不足。');
        try {
          await services.mail.download(matches[0]!.id, path, context.signal);
        } catch (error) {
          if (error instanceof MailFailure) throw error;
          throw new MailFailure('business', '邮箱附件下载失败，请稍后重试。');
        }
      } else {
        requireDevelopmentDressTools();
        const source = await services.emoji.getMarketPackImage(request.packId, request.hash);
        current();
        context.signal.throwIfAborted();
        if (!source) throw new Error('这张表情不可用或解密失败');
        await saveExportOutput(
          { name: request.name, filePath: source },
          { filePath: path },
          context.signal,
        );
      }
      current();
      context.signal.throwIfAborted();
    };
    if (context.checkpoint) await context.checkpoint.file([request.type, fileName], path, download);
    else await download();
    return { total: 1, ok: 1, failed: [], fileName };
  }
  if (request.type !== 'favorite-emoji') {
    if (!('groupFile' in services)) throw new Error('账号资源服务不可用，无法继续导出。');
    if (request.type === 'media-file') {
      const { runResumableMediaFile } = await import('./ipc/routers/media_save');
      return runResumableMediaFile(services, request, context, current);
    }
    if (request.type === 'qzone-album-media')
      return runResumableQzoneAlbumMedia(services, request, context, current);
    return runResumableAlbumResource(services, request, context, current);
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
