import { networkFetch } from '@weq/network';
import { z } from 'zod/v3';
import { basename, extname, join } from 'node:path';
import { open, unlink } from 'node:fs/promises';
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
} from '@weqbot/protocol';
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
import { mediaTransferTarget } from '../../../shared/transfer_progress';
import type { ResumableResourceRequest, ResourceExportRunContext } from '@weq/service';
import { resolveRecordedChatFile, savedMediaSourceKey } from '../../message_media_local';

const messageId = z.string().regex(/^\d{1,20}$/);
const chatFileInput = z.object({
  kind: z.literal('chat-file'),
  msgId: messageId,
  name: z.string().optional(),
  token: z.string().optional(),
  conv: z.string().optional(),
  fwdMsgId: messageId.optional(),
  fwdKind: z.enum(['c2c', 'group']).optional(),
  fwdResId: z.string().max(4096).optional(),
});
const sourceInput = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('url'),
    url: z.string().min(1),
    name: z.string().optional(),
    progressTarget: z
      .string()
      .regex(/^[a-f0-9]{16}$/)
      .optional(),
  }),
  chatFileInput,
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
  foreground: z.boolean().optional(),
  browserOutput: z.boolean().optional(),
});

const mediaTaskRef = exportAccountBindingInput.extend({ taskId: z.string().min(1) });
function resolveMediaTask(input: z.infer<typeof mediaTaskRef>) {
  const context = getAppContext();
  bindExportSaveRequest(input, () => ({
    uin: context.account?.context.uin.toString(),
    configId: context.services?.accountConfig.getRecord()?.configId,
    services: context.services,
  }))();
  const manager = context.services?.exportManager;
  const task = manager?.getTask(input.taskId);
  return task?.resource?.kind === 'media' && manager ? { manager, task } : null;
}

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
  if (url.protocol === 'weq-media:')
    return handleMediaRequest(request, check, { cacheVideo: false });
  if (url.protocol === 'weq-asset:') return handleResourceRequest(request);
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new Error('这份媒体尚未落盘，暂时无法保存');
  const host = getHost();
  return host.fetchMedia ? host.fetchMedia(url.href, { signal }) : networkFetch(url, { signal });
}
function assertCompleteResponse(response: Response) {
  if (!response.ok || response.status === 206 || !response.body)
    throw new Error(`媒体不可用（HTTP ${response.status}）`);
}
async function probeMedia(
  raw: string,
  name: string | undefined,
  check: () => void,
  signal?: AbortSignal,
): Promise<string> {
  const timeout = AbortSignal.timeout(120_000);
  const response = await openUrl(raw, signal ? AbortSignal.any([signal, timeout]) : timeout, check);
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

type PlannedMedia = {
  fileName: string;
  fileSize?: number;
  open: (signal: AbortSignal) => Promise<Response>;
};

async function planSource(
  services: AccountServices,
  source: MediaSaveSource,
  check: () => void,
): Promise<PlannedMedia> {
  if (source.kind === 'url') {
    return planUrlMedia(source.url, source.name, check);
  }
  return planFileMedia(services, source, check);
}

export async function planFileMedia(
  services: AccountServices,
  source: Exclude<MediaSaveSource, { kind: 'url' }>,
  check: () => void,
  select?: () => ReturnType<typeof findMediaElement>,
): Promise<PlannedMedia> {
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
  const lookup =
    select ??
    (() =>
      findMediaElement(
        source.msgId,
        'file',
        source.token ?? '',
        source.fwdMsgId,
        source.fwdKind,
        source.fwdResId,
      ));
  const selected = await lookup();
  check();
  const localOptions = { exact: select !== undefined };
  const local = await resolveRecordedChatFile(services, source, selected, localOptions);
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
    fileSize: selected?.element.fileSize,
    open: async (signal: AbortSignal) => {
      check();
      signal.throwIfAborted();
      const found = await lookup();
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
      const cached = await resolveRecordedChatFile(services, source, found, localOptions);
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
  transfer?: { size?: number; report: NonNullable<ResourceExportRunContext['transferProgress']> },
) {
  assertCompleteResponse(response);
  const handle = await open(path, 'wx', 0o600);
  try {
    const encoding = response.headers.get('content-encoding');
    const length =
      !encoding || encoding === 'identity' ? Number(response.headers.get('content-length')) : 0;
    const knownTotal = Number.isSafeInteger(length) && length > 0 ? length : transfer?.size;
    const total =
      knownTotal && Number.isSafeInteger(knownTotal) && knownTotal > 0 ? knownTotal : undefined;
    let received = 0;
    transfer?.report(received, total);
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
        if (transfer) {
          received += chunk.length;
          transfer.report(received, total && received <= total ? total : undefined);
        }
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

type MediaResumeRequest = Extract<ResumableResourceRequest, { type: 'media-file' }>;

async function planUrlMedia(
  url: string,
  name: string | undefined,
  check: () => void,
  signal?: AbortSignal,
) {
  const fileName = await probeMedia(url, name, check, signal);
  check();
  return { fileName, open: (signal: AbortSignal) => openUrl(url, signal, check) };
}

export async function planUrlMediaExport(
  url: string,
  name: string,
  check: () => void,
  signal?: AbortSignal,
) {
  const plan = await planUrlMedia(url, name, check, signal);
  const output = describeExportOutput(
    { kind: 'file', name, fileName: plan.fileName },
    { avatar: false, transcribe: false, ocr: false, dress: false },
  );
  if (output.kind !== 'file') throw new Error('媒体保存形态无效');
  const fileName = exportOutputFileName(output);
  return {
    output,
    fileName,
    run: (context: ResourceExportRunContext, name = fileName) =>
      savePlannedMedia(plan, name, context, check, output.extension),
  };
}

/** URL 媒体在任务内部识别格式，并以原始格式写入任务暂存目录。 */
export async function downloadUrlMedia(
  url: string,
  name: string,
  { directory, signal }: Pick<ResourceExportRunContext, 'directory' | 'signal'>,
  check: () => void,
): Promise<string> {
  const plan = await planUrlMediaExport(url, name, check, signal);
  const result = await plan.run({ directory, signal, progress() {} });
  return result.fileName;
}

export async function runResumableMediaFile(
  services: AccountServices,
  request: MediaResumeRequest,
  context: ResourceExportRunContext,
  check: () => void,
) {
  if (basename(request.fileName) !== request.fileName || ['.', '..', ''].includes(request.fileName))
    throw new Error('原文件输出名称无效。');
  const source = sourceInput.parse(request.source);
  if (
    source.kind === 'url' ||
    (source.kind === 'chat-file' &&
      (source.token || source.fwdKind || source.fwdMsgId || source.fwdResId))
  )
    throw new Error('原文件没有可复用的来源身份，请重新选择。');
  return savePlannedMedia(
    await planSource(services, source, check),
    request.fileName,
    context,
    check,
  );
}

async function savePlannedMedia(
  plan: PlannedMedia,
  fileName: string,
  context: ResourceExportRunContext,
  check: () => void,
  expectedExtension?: string,
) {
  const { directory, signal, progress, checkpoint } = context;
  const path = join(directory, fileName);
  const download = async () => {
    check();
    signal.throwIfAborted();
    progress(0, 1);
    const response = await plan.open(signal);
    try {
      check();
      signal.throwIfAborted();
      await copyResponse(
        response,
        path,
        signal,
        expectedExtension,
        context.transferProgress
          ? { size: plan.fileSize, report: context.transferProgress }
          : undefined,
      );
      check();
      signal.throwIfAborted();
    } finally {
      await closeResponse(response);
    }
    return true;
  };
  if (checkpoint) await checkpoint.file('selected-file', path, download);
  else await download();
  return { total: 1, ok: 1, failed: [], fileName };
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
    const host = getHost();
    if (selected.browserOutput && !host.registerDownload)
      throw new Error('当前环境不支持浏览器下载');
    let policy: NonNullable<Awaited<ReturnType<typeof prepareExportDestination>>> | undefined;
    if (!selected.browserOutput) {
      const settings = context.bootstrap?.userConfig.getSettings();
      const destination = await prepareExportDestination(
        selected.savePolicy ?? { mode: settings?.exportSaveMode ?? 'before' },
        settings?.defaultExportDir,
        host,
        output,
        check,
        `media:${selected.source.kind}:${output.extension}`,
      );
      if (!destination) return null;
      policy = destination;
    }
    const fileName = exportOutputFileName(output);
    const source = selected.source;
    const recoverable =
      source.kind === 'group-file'
        ? source
        : source.kind === 'chat-file' &&
            source.name &&
            !source.token &&
            !source.fwdKind &&
            !source.fwdMsgId &&
            !source.fwdResId
          ? { kind: source.kind, msgId: source.msgId, name: source.name, conv: source.conv }
          : undefined;
    const resume: MediaResumeRequest | undefined = recoverable
      ? { type: 'media-file', source: recoverable, fileName }
      : undefined;
    return services.exportManager.startResourceExport({
      kind: 'media',
      foreground: selected.foreground,
      browserOutput: selected.browserOutput,
      resume,
      sourceKey: savedMediaSourceKey(selected.source),
      transferTarget: mediaTransferTarget(selected.source),
      name: output.name,
      display: {
        action:
          selected.source.kind === 'group-file'
            ? '保存群文件'
            : /^(png|jpe?g|gif|webp|bmp|svg|apng|avif|heic)$/i.test(output.extension)
              ? '保存图片'
              : /^(mp4|mov|webm|mkv|avi)$/i.test(output.extension)
                ? '保存视频'
                : /^(wav|mp3|ogg|m4a|flac|silk|amr|aac)$/i.test(output.extension)
                  ? '保存语音'
                  : '保存文件',
        subject: plan.fileName,
        fileName: true,
      },
      output,
      savePolicy: policy,
      run: (context) =>
        savePlannedMedia(
          plan,
          fileName,
          context,
          check,
          source.kind === 'url' ? output.extension : undefined,
        ),
    });
  }),
  background: procedure
    .input(mediaTaskRef.extend({ unfinishedOnly: z.boolean().optional() }))
    .mutation(
      ({ input }) =>
        resolveMediaTask(input)?.manager.backgroundResourceTask(
          input.taskId,
          input.unfinishedOnly,
        ) ?? false,
    ),
  resume: procedure.input(mediaTaskRef).mutation(({ input }) => {
    const entry = resolveMediaTask(input);
    return entry?.task.status === 'paused' ? entry.manager.resumeTask(input.taskId) : false;
  }),
  cancel: procedure.input(mediaTaskRef).mutation(({ input }) => {
    const entry = resolveMediaTask(input);
    return entry && ['pending', 'running', 'paused'].includes(entry.task.status)
      ? entry.manager.cancelTask(input.taskId)
      : false;
  }),
});
