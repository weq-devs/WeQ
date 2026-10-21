import { z } from 'zod';
import { basename, extname, join } from 'node:path';
import { stat, open, unlink } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { describeExportOutput, exportOutputFileName, getHost } from '@weq/service';
import {
  detectImageFormat,
  PIC_FORMAT_BMP,
  PIC_FORMAT_GIF,
  PIC_FORMAT_JPEG,
  PIC_FORMAT_PNG,
  PIC_FORMAT_WEBP,
} from '@weq/protocol';
import { getAppContext, type AccountServices } from '../../context/app_context';
import { findMediaElement, handleMediaRequest } from '../../media_protocol';
import { handleResourceRequest } from '../../resource_protocol';
import { fileResponse } from '../../file_response';
import { toProtocolAssetUrl } from '../../protocol_asset_url';
import { procedure, router } from '../trpc';
import {
  bindExportSaveRequest,
  exportAccountBindingInput,
  exportSavePolicyInput,
  prepareExportDestination,
} from './export_save';
import type { MediaSaveSource } from '../../../shared/media_save';

const messageId = z.string().regex(/^\d{1,20}$/);
const sourceInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('url'), url: z.string().min(1), name: z.string().optional() }),
  z.object({
    kind: z.literal('chat-file'),
    msgId: messageId,
    name: z.string().optional(),
    token: z.string().optional(),
    conv: z.string().optional(),
    fwdMsgId: messageId.optional(),
    fwdKind: z.enum(['c2c', 'group']).optional(),
  }),
  z.object({
    kind: z.literal('group-file'),
    groupCode: z
      .string()
      .regex(/^\d+$/)
      .refine((value) => Number.isSafeInteger(Number(value))),
    fileId: z.string().min(1),
    fileName: z.string().min(1),
    busId: z.number().int().nonnegative().optional(),
  }),
]) satisfies z.ZodType<MediaSaveSource>;
const saveInput = exportAccountBindingInput.extend({
  source: sourceInput,
  savePolicy: exportSavePolicyInput.optional(),
});

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/apng': 'apng',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/webm': 'webm',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
};
const IMAGE_EXT = new Map([
  [PIC_FORMAT_PNG, 'png'],
  [PIC_FORMAT_GIF, 'gif'],
  [PIC_FORMAT_WEBP, 'webp'],
  [PIC_FORMAT_BMP, 'bmp'],
  [PIC_FORMAT_JPEG, 'jpg'],
]);
function mediaExtension(header: Uint8Array, mime: string) {
  const image = detectImageFormat(header);
  const detected =
    image.width > 0 && image.height > 0
      ? IMAGE_EXT.get(image.format)
      : header[0] === 0xff && header[1] === 0xd8
        ? 'jpg'
        : undefined;
  const extension = detected ?? MIME_EXT[mime];
  if (!extension && mime && mime !== 'application/octet-stream')
    throw new Error('返回内容不是可保存的媒体');
  return extension;
}
async function closeResponse(response: Response): Promise<void> {
  if (response.body && !response.body.locked) await response.body.cancel().catch(() => {});
}
async function openUrl(raw: string, signal?: AbortSignal, check?: () => void): Promise<Response> {
  check?.();
  const local = toProtocolAssetUrl(raw);
  const url = new URL(local ?? raw);
  if (url.username || url.password) throw new Error('媒体地址无效');
  const request = new Request(url, { signal });
  if (url.protocol === 'weq-media:') return handleMediaRequest(request, check);
  if (url.protocol === 'weq-asset:') return handleResourceRequest(request);
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new Error('这份媒体尚未落盘，暂时无法保存');
  const host = getHost();
  return host.fetchMedia ? host.fetchMedia(url.href, { signal }) : fetch(url, { signal });
}
function assertCompleteResponse(response: Response) {
  if (!response.ok || response.status === 206 || !response.body)
    throw new Error(`媒体不可用（HTTP ${response.status}）`);
}
async function probeMedia(
  raw: string,
  name: string | undefined,
  check: () => void,
): Promise<string> {
  const response = await openUrl(raw, AbortSignal.timeout(120_000), check);
  try {
    check();
    assertCompleteResponse(response);
    const mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
    const reader = response.body!.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (size < 64) {
        const next = await reader.read();
        if (next.done) break;
        const prefix = next.value.subarray(0, 65536 - size);
        chunks.push(prefix);
        size += prefix.length;
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    if (!size) throw new Error('媒体内容为空');
    const header = Buffer.concat(chunks).subarray(0, 65536);
    const extension = mediaExtension(header, mime);
    const url = new URL(toProtocolAssetUrl(raw) ?? raw);
    let candidate = name || url.searchParams.get('name') || '';
    if (!candidate) {
      try {
        candidate = decodeURIComponent(basename(url.pathname));
      } catch {
        /* 使用下面的媒体兜底名。 */
      }
    }
    candidate = basename(candidate.replace(/\\/g, '/')) || '媒体';
    const old = extname(candidate);
    if (
      extension &&
      !(extension === 'jpg' && /^\.jpe?g$/i.test(old)) &&
      old.toLowerCase() !== `.${extension}`
    )
      candidate = `${old ? candidate.slice(0, -old.length) : candidate}.${extension}`;
    if (!extname(candidate)) candidate += `.${extension ?? 'bin'}`;
    return candidate;
  } finally {
    await closeResponse(response);
  }
}

async function localChatFile(
  services: AccountServices,
  source: Extract<MediaSaveSource, { kind: 'chat-file' }>,
) {
  const file = await services.fileAssistant
    .getFileInfoByMsgId(BigInt(source.fwdMsgId || source.msgId))
    .catch(() => null);
  if (!file || (source.name && source.name !== file.fileName)) return null;
  const path = file.localPath.startsWith('::NTOSFull::')
    ? file.localPath.slice('::NTOSFull::'.length)
    : file.localPath;
  return (await stat(path).catch(() => null))?.isFile() ? { path, name: file.fileName } : null;
}

async function planSource(services: AccountServices, source: MediaSaveSource, check: () => void) {
  if (source.kind === 'url') {
    const fileName = await probeMedia(source.url, source.name, check);
    check();
    return { fileName, open: (signal: AbortSignal) => openUrl(source.url, signal, check) };
  }
  if (source.kind === 'group-file')
    return {
      fileName: source.fileName,
      open: async (signal: AbortSignal) => {
        check();
        const url = await services.mediaUrl.getGroupFileUrl(
          Number(source.groupCode),
          source.fileId,
          source.busId ?? 102,
          source.fileName,
        );
        check();
        signal.throwIfAborted();
        if (!url) throw new Error('文件下载地址不可用');
        return openUrl(url, signal, check);
      },
    };
  const local = await localChatFile(services, source);
  check();
  const selected = await findMediaElement(
    source.msgId,
    'file',
    source.token ?? '',
    source.fwdMsgId,
    source.fwdKind,
  );
  check();
  if (
    (selected && source.token && selected.element.fileToken !== source.token) ||
    (selected &&
      !source.token &&
      source.name &&
      selected.element.fileName &&
      selected.element.fileName !== source.name) ||
    (!local && !selected)
  )
    throw new Error('未找到所选文件');
  const fileName = local?.name || source.name || selected?.element.fileName || '文件';
  return {
    fileName,
    open: async (signal: AbortSignal) => {
      check();
      signal.throwIfAborted();
      const found = await findMediaElement(
        source.msgId,
        'file',
        source.token ?? '',
        source.fwdMsgId,
        source.fwdKind,
      );
      check();
      signal.throwIfAborted();
      if (found && source.token && found.element.fileToken !== source.token)
        throw new Error('未找到所选文件');
      if (
        found &&
        !source.token &&
        source.name &&
        found.element.fileName &&
        found.element.fileName !== source.name
      )
        throw new Error('未找到所选文件');
      const cached = await localChatFile(services, source);
      check();
      if (cached) return fileResponse(cached.path);
      if (!found) throw new Error('未找到所选文件');
      const groupId = Number(source.conv) || 0;
      const url =
        found.conv === null
          ? await services.mediaUrl.resolveFileUrlUnknownScene(groupId, found.element, fileName)
          : await services.mediaUrl.resolveFileUrl(found.conv, groupId, found.element, fileName);
      check();
      signal.throwIfAborted();
      if (!url) throw new Error('文件下载地址不可用');
      return openUrl(url, signal, check);
    },
  };
}

/** 独占写私有结果，视频等大文件按流复制；失败只清理本次新建的半成品。 */
async function copyResponse(
  response: Response,
  path: string,
  signal: AbortSignal,
  expectedExtension?: string,
) {
  assertCompleteResponse(response);
  const handle = await open(path, 'wx', 0o600);
  try {
    const mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '';
    const chunks: Buffer[] = [];
    let size = 0,
      checked = expectedExtension === undefined;
    const validate = () => {
      if (!size) throw new Error('媒体内容为空');
      const extension = mediaExtension(
        Buffer.concat(chunks.map((part) => part.subarray(0, 65536))).subarray(0, 65536),
        mime,
      );
      if (
        extension &&
        extension !== expectedExtension?.toLowerCase() &&
        !(extension === 'jpg' && expectedExtension?.toLowerCase() === 'jpeg')
      )
        throw new Error('媒体类型在准备期间发生变化，请重新选择保存位置');
      checked = true;
    };
    const verify = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        if (checked) {
          done(null, chunk);
          return;
        }
        chunks.push(chunk);
        size += chunk.length;
        if (size < 64) {
          done();
          return;
        }
        try {
          validate();
          for (const part of chunks) this.push(part);
          chunks.length = 0;
          done();
        } catch (error) {
          done(error instanceof Error ? error : new Error(String(error)));
        }
      },
      flush(done) {
        try {
          if (!checked) {
            validate();
            for (const part of chunks) this.push(part);
          }
          done();
        } catch (error) {
          done(error instanceof Error ? error : new Error(String(error)));
        }
      },
    });
    await pipeline(
      Readable.fromWeb(response.body! as Parameters<typeof Readable.fromWeb>[0]),
      verify,
      handle.createWriteStream({ autoClose: true }),
      { signal },
    );
  } catch (error) {
    await unlink(path).catch(() => {});
    throw error;
  } finally {
    await handle.close().catch(() => {});
  }
}

export const mediaSaveRouter = router({
  save: procedure.input(saveInput).mutation(async ({ input }) => {
    const context = getAppContext(),
      services = context.services;
    if (!services) throw new Error('未打开账号');
    const selected = structuredClone(input);
    const check = bindExportSaveRequest(
      {
        expectedAccountUin: selected.expectedAccountUin ?? context.account?.context.uin.toString(),
        expectedAccountConfigId:
          selected.expectedAccountConfigId ?? services.accountConfig.getRecord()?.configId,
      },
      () => {
        const ctx = getAppContext();
        return {
          uin: ctx.account?.context.uin.toString(),
          configId: ctx.services?.accountConfig.getRecord()?.configId,
          services: ctx.services,
        };
      },
    );
    const plan = await planSource(services, selected.source, check);
    check();
    const output = describeExportOutput(
      { kind: 'file', name: plan.fileName, fileName: plan.fileName },
      { avatar: false, transcribe: false, ocr: false, dress: false },
    );
    if (output.kind !== 'file') throw new Error('媒体保存形态无效');
    const settings = context.bootstrap?.userConfig.getSettings();
    const policy = await prepareExportDestination(
      selected.savePolicy ?? { mode: settings?.exportSaveMode ?? 'before' },
      settings?.defaultExportDir,
      getHost(),
      output,
      check,
    );
    if (!policy) return null;
    const fileName = exportOutputFileName(output);
    return services.exportManager.startResourceExport({
      kind: 'media',
      name: output.name,
      output,
      savePolicy: policy,
      run: async ({ directory, signal, progress }) => {
        check();
        signal.throwIfAborted();
        progress(0, 1);
        const response = await plan.open(signal);
        try {
          check();
          signal.throwIfAborted();
          await copyResponse(
            response,
            join(directory, fileName),
            signal,
            selected.source.kind === 'url' ? output.extension : undefined,
          );
          check();
          signal.throwIfAborted();
        } finally {
          await closeResponse(response);
        }
        return { total: 1, ok: 1, failed: [], fileName };
      },
    });
  }),
  cancel: procedure
    .input(exportAccountBindingInput.extend({ taskId: z.string().min(1) }))
    .mutation(({ input }) => {
      const ctx = getAppContext(),
        services = ctx.services;
      bindExportSaveRequest(input, () => ({
        uin: getAppContext().account?.context.uin.toString(),
        configId: getAppContext().services?.accountConfig.getRecord()?.configId,
        services: getAppContext().services,
      }))();
      const task = services?.exportManager.getTask(input.taskId);
      if (task?.resource?.kind !== 'media') return false;
      return ['pending', 'running'].includes(task.status)
        ? services!.exportManager.cancelTask(input.taskId)
        : false;
    }),
});
