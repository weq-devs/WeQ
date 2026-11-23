import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { z } from 'zod';
import { albumMediaTransferTarget, mediaTransferTarget } from '../shared/transfer_progress';
import {
  clientKeyExpiryMs,
  downloadUrlToFile,
  localOcrBlocker,
  OperationError,
  type AlbumMedia,
  type AlbumMediaPage,
  type ResumableResourceRequest,
  type ResourceExportRunContext,
} from '@weq/service';
import { ExportCheckpointError } from '@weq/service/export-checkpoint';
import { groupAlbumMediaKey, qzoneAlbumMediaKey } from '../shared/album_media_identity';
import { groupAlbumReferences } from '../shared/content_selection';
import { QZONE_ALBUM_PAGE_SIZE } from '../shared/qzone_album_export';
import { deduplicateAlbumResources } from './album_resource_dedup';
import { getAppContext, requireBootstrap, type AccountServices } from './context/app_context';
import { fullModeAllowed } from './context/full_mode';
import { resolveLocalOcrModel, resolveLocalOcrFilterModel } from './ocr/local';
import { exportAccountBindingInput } from './ipc/routers/export_save';

export const groupAlbumInput = z.object({
  groupCode: z.string().min(1),
});

/** 待导出的相册媒体条目（多选下载用，对齐 QzoneAlbumPhoto wire）。 */
const qzoneAlbumMediaItemInput = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  url: z.string().min(1),
  isVideo: z.boolean().optional(),
  picKey: z.string().optional(),
});

export const exportQzoneAlbumMediaInput = z
  .object({
    hostUin: z.string().min(1),
    topicId: z.string().min(1),
    outputDir: z.string().min(1),
    items: z.array(qzoneAlbumMediaItemInput).min(1),
    concurrency: z.number().int().min(1).max(8).optional(),
  })
  .merge(exportAccountBindingInput);

export const albumSelectionInput = z.object({
  id: z.string().min(1),
  title: z.string().optional(),
  mediaKeys: z.array(z.string().min(1)).optional(),
});

export const exportGroupAlbumsInput = groupAlbumInput.extend({
  outputDir: z.string().min(1),
  albums: z.array(albumSelectionInput).min(1),
  concurrency: z.number().int().min(1).max(8).optional(),
});

export interface GroupAlbumAccessState {
  source?: { expectedAccountUin: string; expectedAccountConfigId: string };
  qqOnline: boolean;
  qqPid: number | null;
  /** 宿主内有效的自动策略或本来源手动请求，不表示凭据已经就绪。 */
  attachEnabled: boolean;
  /**
   * 本地账号配置里的会话物料是否齐全（a2 / d2 / d2key）。发包要拿它做 TEA 加密，
   * 缺任一项都发不出去，所以发送按钮按它前置置灰。
   */
  hasA2: boolean;
  hasD2: boolean;
  hasD2Key: boolean;
  /** 本地是否已解析出设备 guid（服务端认设备的依据，缺了会被拒绝）。 */
  hasGuid: boolean;
  /**
   * 原生侧是否已经登记了这个 QQ 进程的 SSO 会话。
   *
   * **和 `qqOnline` 不是一回事**：Linux 上要先提权读进程内存拿到 a2 / d2 / d2key
   * 才能登记，QQ 刚上线时中间有几十秒空窗。这段时间里发包只会回
   * 「还没有登记 SSO 会话」，所以任何走原始 SSO 通道的功能（漫游补拉、闪照补拉）
   * 都必须等它为真。`getGroupAlbumAccessState` 才会返回它。
   */
  ssoReady?: boolean;
  /** 会话物料需要重新读一次进程内存（pid 变了或物料不全）。 */
  needsMemoryRead?: boolean;
  clientKeyValid: boolean;
  clientKeyExpiresAt: number | null;
  clientKeySecondsLeft: number;
  /**
   * 本地 OCR 识别模型的 id —— 已选且已下载时非空。在线那条腿不可用（QQ 离线 /
   * 物料不全）时，灯箱的 OCR 按钮就靠它活着；两条腿都没有才置灰。
   */
  ocrLocalModelId: string | null;
  /**
   * 本地筛图模型（只判断「图里有没有文字」）的 id —— 已选且已下载时非空。
   * 导出面板据此显示「预筛选已就绪 / 去下载」，并决定要不要带 `ocrPrefilter`。
   */
  ocrFilterModelId: string | null;
  ocrPrefilterEnabled: boolean;
  /**
   * **本机能不能跑本地识别引擎**：能跑为 null，跑不了是给人看的原因（如 macOS Intel
   * 上游没发 onnxruntime 二进制）。与那两个 id 的区别：这是平台能力，跟模型下没下好无关。
   * 灯箱的置灰提示据此说人话（否则 Intel Mac 上会一直劝用户「去下个本地模型」）。
   */
  ocrLocalBlocker: string | null;
}

export interface AlbumMediaWire extends AlbumMedia {
  kind: 'image' | 'video';
  previewUrl: string;
  originalUrl: string;
  fileName: string;
}

interface AlbumDownloadWork {
  albumId: string;
  albumTitle: string;
  url: string;
  targetPath: string;
  fileName: string;
}

export interface AlbumExportResult {
  outputDir: string;
  total: number;
  ok: number;
  failed: Array<{
    albumId: string;
    albumTitle: string;
    fileName: string;
    url: string;
    error: string;
  }>;
}

export interface QzoneAlbumMediaExportResult {
  outputDir: string;
  total: number;
  ok: number;
  failed: Array<{
    name: string;
    fileName: string;
    error: string;
  }>;
}

export const exportGroupFilesInput = z.object({
  groupCode: z.string().min(1),
  outputDir: z.string().min(1),
  /** 省略则递归导出全群文件(含子文件夹,保留目录结构)。 */
  files: z
    .array(
      z.object({
        fileId: z.string().min(1),
        fileName: z.string().min(1),
        busId: z.number().int().optional(),
        /** 相对根目录的文件夹路径段,用于在输出目录里重建目录树。 */
        path: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  concurrency: z.number().int().min(1).max(8).optional(),
});

interface GroupFileDownloadWork {
  fileId: string;
  fileName: string;
  busId: number;
  targetPath: string;
}

export interface GroupFileExportResult {
  outputDir: string;
  total: number;
  ok: number;
  failed: Array<{ fileId: string; fileName: string; error: string }>;
}

export function albumAccessState(services: AccountServices): GroupAlbumAccessState {
  const record = services.accountConfig.getRecord();
  const session = record?.session;
  const expiresAt = record?.clientKey ? clientKeyExpiryMs(record.clientKey) : null;
  const secondsLeft = expiresAt ? Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)) : 0;
  return {
    source: record?.configId
      ? { expectedAccountUin: String(record.uin), expectedAccountConfigId: record.configId }
      : undefined,
    qqOnline: Boolean(record?.qqOnline && record.qqPid),
    qqPid: record?.qqPid ?? null,
    attachEnabled: fullModeAllowed(getAppContext()),
    hasA2: Boolean(session?.a2),
    hasD2: Boolean(session?.d2),
    hasD2Key: Boolean(session?.d2Key),
    hasGuid: Boolean(record?.guid),
    clientKeyValid: Boolean(expiresAt && expiresAt > Date.now()),
    clientKeyExpiresAt: expiresAt,
    clientKeySecondsLeft: secondsLeft,
    // 本地 OCR 那条腿的可用性：设置里选了识别模型且文件下好了才有值。渲染层拿它决定
    // OCR 按钮能不能点（在线那条腿不可用时，本地模型就是唯一的出路）。
    ocrLocalModelId: resolveLocalOcrModel()?.modelId ?? null,
    // 筛图模型只看检测网络（1.7 MB 那份），与识别模型是两个独立的设置项。
    ocrFilterModelId: resolveLocalOcrFilterModel()?.modelId ?? null,
    ocrPrefilterEnabled: requireBootstrap().userConfig.getSettings().ocr.prefilterEnabled,
    // 平台能力（与模型状态无关）：本机没有可用的推理引擎时两个 id 必然是 null，
    // 渲染层用这句话代替「去下个本地模型」的提示。
    ocrLocalBlocker: localOcrBlocker(),
  };
}

export function requireQqOnlineForAlbum(services: AccountServices): void {
  const state = albumAccessState(services);
  if (!state.qqOnline) {
    throw new Error('需要先登录该账号的 QQ 客户端。');
  }
  if (!state.attachEnabled) {
    throw new OperationError(
      '已开启完全离线模式（自动读取 QQ 内存 已关闭），该功能需要在线 QQ 实例。',
      'expected',
    );
  }
}

export function requireFreshClientKeyForAlbum(services: AccountServices): void {
  const state = albumAccessState(services);
  if (!state.qqOnline) {
    throw new Error('需要先登录该账号的 QQ 客户端。');
  }
  if (!state.attachEnabled) {
    throw new OperationError(
      '已开启完全离线模式（自动读取 QQ 内存 已关闭），群相册等在线功能不可用。',
      'expected',
    );
  }
  if (!state.clientKeyValid) {
    throw new Error('ClientKey 未获取或已过期，请确认 QQ 在线且已开启「自动启用 QQ 在线能力」。');
  }
}

/**
 * 仅要求在线 QQ 实例（不要求注入 / ClientKey）—— 走 Web CGI 的接口用：
 * qzone.qq.com / qun.qq.com 的 p_skey 可经 ptlogin2 本地快速登录兜底获取。
 */
export function requireOnlineQqForWeb(services: AccountServices): void {
  const state = albumAccessState(services);
  if (!state.qqOnline) {
    throw new Error('需要先登录该账号的 QQ 客户端。');
  }
}

function bestUrls(
  entries: Array<{ url: { url: string; width: number; height: number } | null }>,
): Array<{ url: string; width: number; height: number }> {
  return entries
    .map((entry) => entry.url)
    .filter((entry): entry is NonNullable<typeof entry> => {
      if (!entry?.url) return false;
      return !isAlbumPlaceholderUrl(entry.url);
    })
    .slice()
    .sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0));
}

function imageUrls(image: NonNullable<AlbumMedia['image']>): {
  previewUrl: string;
  originalUrl: string;
} {
  const sorted = bestUrls(image.photoUrls);
  const defaultUrl =
    image.defaultUrl && !isAlbumPlaceholderUrl(image.defaultUrl.url) ? image.defaultUrl.url : '';
  return {
    previewUrl: defaultUrl || sorted[sorted.length - 1]?.url || sorted[0]?.url || '',
    originalUrl: sorted[0]?.url || defaultUrl || '',
  };
}

function mediaUrls(media: AlbumMedia): Omit<AlbumMediaWire, keyof AlbumMedia> {
  const video = media.video;
  if (video) {
    // 视频卡片显示封面图,下载/播放取最高码率的那路;videoUrl 为空时回退到顶层 url。
    const cover = video.cover ? imageUrls(video.cover) : { previewUrl: '', originalUrl: '' };
    const streams = bestUrls(video.videoUrls);
    const src =
      streams[0]?.url || (video.url && !isAlbumPlaceholderUrl(video.url) ? video.url : '');
    return {
      kind: 'video',
      previewUrl: cover.previewUrl || cover.originalUrl,
      originalUrl: src,
      fileName: video.id || '',
    };
  }

  const image = media.image;
  if (!image) return { kind: 'image', previewUrl: '', originalUrl: '', fileName: '' };
  return { kind: 'image', ...imageUrls(image), fileName: image.name || '' };
}

function mediaToWire(media: AlbumMedia): AlbumMediaWire {
  return { ...media, ...mediaUrls(media) };
}

function albumMediaKey(media: AlbumMediaWire): string {
  return groupAlbumMediaKey(media);
}

/** 群相册每一页的游标都可能指向当前页最后一项，末页也可能带游标。 */
export function nextAlbumMediaCursor(page: AlbumMediaPage): string | null {
  const hasMore = page.nextHasMore ?? page.mediaList.length > 0;
  return hasMore ? page.nextAttachInfo || null : null;
}

function isAlbumPlaceholderUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    return parsed.hostname.toLowerCase() === 'imgcache.qq.com' && path.endsWith('/no.gif');
  } catch {
    return /imgcache\.qq\.com\/.*\/no\.gif/i.test(url);
  }
}

export async function collectAlbumMedia(
  services: Pick<AccountServices, 'groupAlbumMedia'>,
  groupCode: string,
  albumId: string,
  signal?: AbortSignal,
  beforeRequest?: () => void,
): Promise<AlbumMediaWire[]> {
  const out: AlbumMediaWire[] = [];
  const seenKeys = new Set<string>();
  const seenAttachInfo = new Set<string>();
  let attachInfo = '';
  for (let guard = 0; guard < 100; guard += 1) {
    signal?.throwIfAborted();
    beforeRequest?.();
    const page = await services.groupAlbumMedia.getMediaList(groupCode, albumId, attachInfo);
    beforeRequest?.();
    signal?.throwIfAborted();
    for (const wire of page.mediaList
      .map(mediaToWire)
      .filter((media) => media.originalUrl || media.previewUrl)) {
      const key = albumMediaKey(wire);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      out.push(wire);
    }
    const next = nextAlbumMediaCursor(page);
    if (!next || seenAttachInfo.has(next)) break;
    seenAttachInfo.add(next);
    attachInfo = next;
  }
  return out;
}

function pickAlbumDownloadUrl(media: AlbumMediaWire): string {
  return media.originalUrl || media.previewUrl;
}

export function sanitizePathSegment(value: string | undefined, fallback: string): string {
  const raw = (value || fallback).trim();
  const cleaned = raw
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 有意剔除文件名中的控制字符
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .slice(0, 120)
    .trim();
  const name = cleaned || fallback;
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name) ? `_${name}` : name;
}

function filenameFromUrl(url: string, fallback: string, index: number, defaultExt: string): string {
  let name = fallback;
  if (!name) {
    try {
      name = decodeURIComponent(basename(new URL(url).pathname));
    } catch {
      name = '';
    }
  }
  const safe = sanitizePathSegment(
    name,
    `photo-${String(index + 1).padStart(4, '0')}${defaultExt}`,
  );
  return extname(safe) ? safe : `${safe}${defaultExt}`;
}

export function uniqueFilename(name: string, used: Set<string>): string {
  if (!used.has(name.toLowerCase())) {
    used.add(name.toLowerCase());
    return name;
  }
  const ext = extname(name);
  const base = ext ? name.slice(0, -ext.length) : name;
  for (let i = 2; ; i += 1) {
    const next = `${base}-${i}${ext}`;
    const key = next.toLowerCase();
    if (!used.has(key)) {
      used.add(key);
      return next;
    }
  }
}

async function downloadAlbumUrl(
  url: string,
  targetPath: string,
  signal?: AbortSignal,
  onProgress?: (received: number, total: number) => void,
): Promise<void> {
  const outcome = await downloadUrlToFile(url, targetPath, { signal, onProgress });
  if (!outcome.ok) throw new Error(outcome.reason);
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  let next = 0;
  async function run(): Promise<void> {
    for (;;) {
      signal?.throwIfAborted();
      const index = next;
      next += 1;
      if (index >= items.length) return;
      await worker(items[index]!);
    }
  }
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, items.length) }, run),
  );
  const failure = results.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
}

export async function exportGroupAlbums(
  services: AccountServices,
  input: z.infer<typeof exportGroupAlbumsInput>,
  context?: {
    signal: AbortSignal;
    progress(current: number, total: number): void;
    folder?: string;
  },
): Promise<AlbumExportResult> {
  requireFreshClientKeyForAlbum(services);
  const work: AlbumDownloadWork[] = [];
  const failed: AlbumExportResult['failed'] = [];
  const albumNames = new Set<string>();
  for (const album of input.albums) {
    context?.signal.throwIfAborted();
    const albumTitle =
      context?.folder ?? uniqueFilename(sanitizePathSegment(album.title, album.id), albumNames);
    const albumDir = join(input.outputDir, albumTitle);
    const used = new Set<string>();
    const media = await collectAlbumMedia(services, input.groupCode, album.id, context?.signal);
    const selected = album.mediaKeys === undefined ? null : new Set(album.mediaKeys);
    const found = new Set(media.map(albumMediaKey));
    for (const key of selected ?? [])
      if (!found.has(key))
        failed.push({
          albumId: album.id,
          albumTitle,
          fileName: key,
          url: '',
          error: '未找到选中的媒体，未扩大为整本相册',
        });
    media.forEach((item, index) => {
      if (selected && !selected.has(albumMediaKey(item))) return;
      const url = pickAlbumDownloadUrl(item);
      if (!url) return;
      const fileName = uniqueFilename(
        filenameFromUrl(url, item.fileName, index, item.kind === 'video' ? '.mp4' : '.jpg'),
        used,
      );
      work.push({
        albumId: album.id,
        albumTitle,
        url,
        fileName,
        targetPath: join(albumDir, fileName),
      });
    });
  }

  const missing = failed.length;
  let ok = 0;
  await mkdir(input.outputDir, { recursive: true });
  await runWithConcurrency(
    work,
    input.concurrency ?? 4,
    async (item) => {
      try {
        await mkdir(dirname(item.targetPath), { recursive: true });
        await downloadAlbumUrl(item.url, item.targetPath, context?.signal);
        ok += 1;
      } catch (e) {
        context?.signal.throwIfAborted();
        failed.push({
          albumId: item.albumId,
          albumTitle: item.albumTitle,
          fileName: item.fileName,
          url: item.url,
          error: e instanceof Error ? e.message : String(e),
        });
      }
      context?.progress(ok + failed.length, work.length + missing);
    },
    context?.signal,
  );

  return { outputDir: input.outputDir, total: work.length + missing, ok, failed };
}

/**
 * 并发下载选中的个人空间相册媒体到 `outputDir`。与 {@link exportGroupAlbums}
 * 共用同一套下载工具函数；区别是个人相册列表只给视频封面，下载视频前按
 * picKey 现取 mp4 本体（签名会过期），取不到则回退封面图。
 */
export async function exportQzoneAlbumMedia(
  services: AccountServices,
  input: z.infer<typeof exportQzoneAlbumMediaInput>,
  context?: {
    signal: AbortSignal;
    check(): void;
    progress(current: number, total: number): void;
    resolved?: { url: string; fileName: string };
  } & Pick<ResourceExportRunContext, 'transferProgress' | 'transferItemFinished'>,
): Promise<QzoneAlbumMediaExportResult> {
  requireOnlineQqForWeb(services);
  const used = new Set<string>();
  const failed: QzoneAlbumMediaExportResult['failed'] = [];
  let ok = 0;
  context?.progress(0, input.items.length);
  await mkdir(input.outputDir, { recursive: true });
  await runWithConcurrency(
    input.items.map((item, index) => ({ item, index })),
    input.concurrency ?? 4,
    async ({ item, index }) => {
      const target = albumMediaTransferTarget(
        input.hostUin,
        input.topicId,
        qzoneAlbumMediaKey(item),
      );
      let fileName = item.name || item.id;
      let success = false;
      try {
        context?.check();
        context?.signal.throwIfAborted();
        const source =
          context?.resolved ?? (await resolveQzoneAlbumDownload(services, input, item, index));
        context?.check();
        context?.signal.throwIfAborted();
        fileName = uniqueFilename(source.fileName, used);
        await downloadAlbumUrl(
          source.url,
          join(input.outputDir, fileName),
          context?.signal,
          (received, total) => context?.transferProgress?.(received, total || undefined, target),
        );
        context?.check();
        ok += 1;
        success = true;
      } catch (e) {
        context?.signal.throwIfAborted();
        context?.check();
        failed.push({
          name: item.url,
          fileName,
          error: e instanceof Error ? e.message : String(e),
        });
      } finally {
        context?.transferItemFinished?.(target, success);
      }
      context?.progress(ok + failed.length, input.items.length);
    },
    context?.signal,
  );

  return { outputDir: input.outputDir, total: input.items.length, ok, failed };
}

/** 继续沿用视频本体／封面回退，仅根据实际选中的资源修正保存后缀。 */
export async function resolveQzoneAlbumDownload(
  services: AccountServices,
  input: { hostUin: string; topicId: string },
  item: z.infer<typeof qzoneAlbumMediaItemInput>,
  index: number,
): Promise<{ url: string; fileName: string }> {
  let url = item.url,
    video = false;
  if (item.isVideo && item.picKey) {
    try {
      const mp4 = await services.webQuery.getQzoneAlbumVideoUrl(
        input.hostUin,
        input.topicId,
        item.picKey,
      );
      if (mp4) {
        url = mp4;
        video = true;
      }
    } catch {
      /* 本体不可用时仍保存既有封面，不新增媒体获取链路。 */
    }
  }
  let fileName = filenameFromUrl(url, item.name ?? '', index, video ? '.mp4' : '.jpg');
  if (item.isVideo) {
    let extension = '.jpg';
    if (video) extension = '.mp4';
    else {
      try {
        const ext = extname(new URL(url).pathname);
        if (/^\.(?:jpg|jpeg|png|gif|webp)$/i.test(ext)) extension = ext;
      } catch {
        /* 无可用后缀时沿用封面默认格式。 */
      }
    }
    const old = extname(fileName);
    fileName = `${old ? fileName.slice(0, -old.length) : fileName}${extension}`;
  }
  return { url, fileName };
}

/** 迁移既有整本相册分页导出，选择范围仍是用户明确勾选的相册。 */
export async function exportSelectedQzoneAlbums(
  services: AccountServices,
  input: {
    hostUin: string;
    albums: Array<{ id: string; title?: string; mediaKeys?: string[] }>;
    outputDir: string;
  },
  context: {
    signal: AbortSignal;
    check(): void;
    progress(current: number, total: number): void;
    folder?: string;
  } & Pick<ResourceExportRunContext, 'transferProgress' | 'transferItemFinished'>,
) {
  const failed: Array<{ fileName: string; error: string }> = [];
  const folders = new Set<string>();
  let total = 0,
    ok = 0;
  for (const album of input.albums) {
    const selected = album.mediaKeys === undefined ? null : new Set(album.mediaKeys);
    const matched = new Set<string>();
    let readError = '';
    context.signal.throwIfAborted();
    context.check();
    const folder =
      context.folder ??
      uniqueFilename(sanitizePathSegment(`${album.title || '相册'}_${album.id}`, '相册'), folders);
    let start = 0,
      pageIndex = 0,
      sequence = 0;
    const seen = new Set<string>();
    try {
      for (;;) {
        context.signal.throwIfAborted();
        context.check();
        if (++pageIndex > 10000) throw new Error('相册分页未结束，请分批重试。');
        const page = await services.webQuery.getQzoneAlbumPhotos(
          input.hostUin,
          album.id,
          start,
          QZONE_ALBUM_PAGE_SIZE,
        );
        context.signal.throwIfAborted();
        context.check();
        const photos = page?.photos ?? [];
        if (!photos.length) {
          if (start < Number(page?.totalInAlbum ?? 0))
            throw new Error('相册分页提前返回空页，未导出全部媒体。');
          break;
        }
        const fresh = photos.filter((photo) => {
          const key = `${photo.isVideo}:${photo.picKey || photo.url || photo.thumbUrl}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        if (!fresh.length) throw new Error('相册分页重复，已停止，避免重复下载。');
        const items = fresh
          .filter((photo) => {
            const key = qzoneAlbumMediaKey(photo);
            if (selected && !selected.has(key)) return false;
            matched.add(key);
            return true;
          })
          .flatMap((photo) => {
            sequence++;
            if (!photo.url && !photo.thumbUrl) {
              total++;
              failed.push({ fileName: `${folder}/媒体-${sequence}`, error: '媒体缺少下载地址。' });
              return [];
            }
            return [
              {
                id: photo.id || String(sequence),
                name: `${String(sequence).padStart(6, '0')}_${photo.name || '媒体'}`,
                url: photo.url || photo.thumbUrl,
                isVideo: photo.isVideo,
                picKey: photo.picKey,
              },
            ];
          });
        if (items.length) {
          const result = await exportQzoneAlbumMedia(
            services,
            {
              hostUin: input.hostUin,
              topicId: album.id,
              outputDir: join(input.outputDir, folder),
              concurrency: 4,
              items,
            },
            {
              ...context,
              progress: (current, size) =>
                context.progress(ok + failed.length + current, total + size),
            },
          );
          total += result.total;
          ok += result.ok;
          failed.push(
            ...result.failed.map((failure) => ({
              fileName: `${folder}/${failure.fileName}`,
              error: failure.error,
            })),
          );
        }
        context.progress(ok + failed.length, total);
        start += photos.length;
        if (selected && matched.size === selected.size) break;
        const size = Number(page?.totalInAlbum ?? 0);
        if (size > 0 ? start >= size : photos.length < QZONE_ALBUM_PAGE_SIZE) break;
      }
    } catch (error) {
      context.signal.throwIfAborted();
      context.check();
      readError = error instanceof Error ? error.message : String(error);
      if (!selected) {
        total++;
        failed.push({
          fileName: `${folder}/相册读取`,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    for (const key of selected ?? [])
      if (!matched.has(key)) {
        total++;
        failed.push({
          fileName: `${folder}/${key}`,
          error: readError || '未找到选中的媒体，未扩大为整本相册',
        });
      }
  }
  return { total, ok, failed };
}

export async function exportGroupFiles(
  services: AccountServices,
  input: z.infer<typeof exportGroupFilesInput>,
  context?: Pick<
    ResourceExportRunContext,
    'signal' | 'progress' | 'checkpoint' | 'transferProgress' | 'transferItemFinished'
  > & {
    check?: () => void;
  },
): Promise<GroupFileExportResult> {
  requireQqOnlineForAlbum(services);

  // 没给具体文件就递归整个群,path 用来在输出目录里重建文件夹结构。
  const enumerate = async () =>
    input.files ??
    (await services.groupFile.listRecursive(Number(input.groupCode))).map((f) => ({
      fileId: f.fileId,
      fileName: f.fileName,
      busId: f.busId,
      path: f.path,
    }));
  const targets = context?.checkpoint
    ? await context.checkpoint.run('group-file-plan', enumerate)
    : await enumerate();
  context?.check?.();

  const work: GroupFileDownloadWork[] = [];
  // 同名去重按目录分桶 —— 不同子文件夹下的同名文件本来就不冲突。
  const usedByDir = new Map<string, Set<string>>();
  targets.forEach((file, index) => {
    const segments = (file.path ?? []).map((seg, i) => sanitizePathSegment(seg, `folder-${i + 1}`));
    const dir = join(input.outputDir, ...segments);
    const used = usedByDir.get(dir) ?? new Set<string>();
    usedByDir.set(dir, used);
    const fileName = uniqueFilename(
      sanitizePathSegment(file.fileName, `file-${String(index + 1).padStart(4, '0')}`),
      used,
    );
    work.push({
      fileId: file.fileId,
      fileName,
      busId: file.busId ?? 102,
      targetPath: join(dir, fileName),
    });
  });

  const failed: GroupFileExportResult['failed'] = [];
  let ok = 0;
  context?.progress(0, work.length);
  await mkdir(input.outputDir, { recursive: true });
  await runWithConcurrency(
    work,
    input.concurrency ?? 4,
    async (item) => {
      const target = mediaTransferTarget({
        kind: 'group-file',
        groupCode: input.groupCode,
        fileId: item.fileId,
        fileName: item.fileName,
        busId: item.busId,
      });
      let success = false;
      try {
        const download = async () => {
          context?.check?.();
          const url = await services.mediaUrl.getGroupFileUrl(
            Number(input.groupCode),
            item.fileId,
            item.busId,
            item.fileName,
          );
          context?.signal.throwIfAborted();
          context?.check?.();
          const outcome = await downloadUrlToFile(url, item.targetPath, {
            signal: context?.signal,
            onProgress: (received, total) =>
              context?.transferProgress?.(received, total || undefined, target),
          });
          if (!outcome.ok) throw new Error(outcome.reason);
          context?.check?.();
          return true;
        };
        if (context?.checkpoint)
          await context.checkpoint.file(
            ['group-file', item.fileId, item.targetPath],
            item.targetPath,
            download,
          );
        else await download();
        ok += 1;
        success = true;
      } catch (e) {
        context?.signal.throwIfAborted();
        context?.check?.();
        if (e instanceof ExportCheckpointError) throw e;
        failed.push({
          fileId: item.fileId,
          fileName: item.fileName,
          error: e instanceof Error ? e.message : String(e),
        });
      } finally {
        context?.transferItemFinished?.(target, success);
      }
      context?.progress(ok + failed.length, work.length);
    },
    context?.signal,
  );

  return { outputDir: input.outputDir, total: work.length, ok, failed };
}

export async function runResumableAlbumResource(
  services: AccountServices,
  request: Exclude<ResumableResourceRequest, { type: 'mail' | 'favorite-emoji' | 'media-file' }>,
  context: ResourceExportRunContext,
  check: () => void,
) {
  check();
  const { directory, signal, checkpoint } = context;
  if (request.type === 'group-files')
    return exportGroupFiles(services, { ...request, outputDir: directory }, { ...context, check });
  if (request.type === 'group-albums') requireFreshClientKeyForAlbum(services);
  if (request.type === 'qzone-albums') requireOnlineQqForWeb(services);
  const mixed = request.type === 'album-references';
  const albums =
    request.type === 'album-references'
      ? groupAlbumReferences(request.items)
      : request.albums.map((album) => ({
          provider: request.type === 'group-albums' ? ('group' as const) : ('qzone' as const),
          owner: request.type === 'group-albums' ? request.groupCode : request.hostUin,
          albumId: album.id,
          title: album.title,
          mediaKeys: album.mediaKeys,
        }));
  const folders = new Map<string, Set<string>>();
  const failed: Array<{ fileName: string; error: string }> = [];
  let total = 0;
  let ok = 0;
  for (const [index, album] of albums.entries()) {
    signal.throwIfAborted();
    check();
    const owner = `${album.provider}-${album.owner}`;
    const used = folders.get(owner) ?? new Set<string>();
    folders.set(owner, used);
    const folder = uniqueFilename(
      mixed
        ? sanitizePathSegment(album.albumId, 'album')
        : album.provider === 'group'
          ? sanitizePathSegment(album.title, album.albumId)
          : sanitizePathSegment(`${album.title || '相册'}_${album.albumId}`, '相册'),
      used,
    );
    const outputDir = mixed ? join(directory, owner, folder) : join(directory, folder);
    const parent = mixed ? outputDir : directory;
    const fixedFolder = mixed ? undefined : folder;
    const selection = [{ id: album.albumId, title: album.title, mediaKeys: album.mediaKeys }];
    const progress = (current: number, size: number) =>
      context.progress(ok + failed.length + current, total + size);
    const download = async () => {
      await mkdir(outputDir, { recursive: true });
      const result =
        album.provider === 'group'
          ? await exportGroupAlbums(
              services,
              {
                groupCode: album.owner,
                outputDir: parent,
                albums: selection,
                concurrency: request.type === 'group-albums' ? request.concurrency : undefined,
              },
              { signal, progress, folder: fixedFolder },
            )
          : await exportSelectedQzoneAlbums(
              services,
              { hostUin: album.owner, outputDir: parent, albums: selection },
              {
                signal,
                progress,
                check,
                folder: fixedFolder,
                transferProgress: context.transferProgress,
                transferItemFinished: context.transferItemFinished,
              },
            );
      check();
      signal.throwIfAborted();
      return result;
    };
    try {
      const result = checkpoint
        ? await checkpoint.file(
            ['album', index, owner, album.albumId],
            outputDir,
            download,
            (result) => !result.failed.length,
          )
        : await download();
      total += result.total;
      ok += result.ok;
      failed.push(
        ...result.failed.map((item) => ({
          fileName: `${album.owner}/${album.albumId}/${item.fileName}`,
          error: item.error,
        })),
      );
    } catch (error) {
      signal.throwIfAborted();
      check();
      if (error instanceof ExportCheckpointError) throw error;
      const keys = album.mediaKeys ?? [album.albumId];
      total += keys.length;
      failed.push(
        ...keys.map((key) => ({
          fileName: `${album.owner}/${album.albumId}/${key}`,
          error: error instanceof Error ? error.message : '相册读取失败',
        })),
      );
    }
    context.progress(ok + failed.length, total);
  }
  signal.throwIfAborted();
  check();
  if (request.type === 'album-references') {
    await deduplicateAlbumResources(directory, signal);
    await writeFile(
      join(directory, 'selected-items.json'),
      JSON.stringify({ items: request.items, total, ok, failed }, null, 2),
      { signal },
    );
  }
  return { total, ok, failed };
}
