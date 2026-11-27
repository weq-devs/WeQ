import { bounded, networkFetch } from '@weq/network';
/**
 * MediaDownloadService — CDN fallback for chat media that isn't on disk.
 *
 * When `FileSearchService` can't find media locally, we fetch it from QQ's
 * multimedia CDN using the element's `fileToken` plus a live download rkey
 * harvested by {@link AccountMonitorService}:
 *
 *   https://multimedia.nt.qq.com.cn/download?appid=<appid>&fileid=<token>&spec=0<rkey>
 *
 * rkeys are scene- AND media-bound — a different rkey/appid pair per (chat
 * scene × media kind). We don't thread the chat scene down here, so for a given
 * media kind we try each non-expired rkey of the matching types (with its
 * appid) until one returns real bytes. The rkey value already carries its own
 * `&rkey=` prefix. Results are cached on disk keyed by a hash of the token.
 *
 * Currently only image download (pic / received emoji) is wired up; video and
 * ptt download are intentionally deferred.
 */

import { createHash } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { AccountConfigService, DownloadRkey } from './user_config';
import { rkeyExpiryMs } from './user_config';
import { getLogger, logErrorContext } from '../common/logger';
import { scopedNetworkAllowed } from '../common/network_scope';
import {
  ManagedDownload,
  TransferDeferredError,
  type DownloadState,
} from '../common/managed_download';

const MEDIA_HOST = 'https://multimedia.nt.qq.com.cn';
const DOWNLOAD_BASE = `${MEDIA_HOST}/download`;

/** rkey `type_` values, by (scene × media kind). */
export const PRIVATE_IMAGE_RKEY_TYPE = 10;
export const GROUP_IMAGE_RKEY_TYPE = 20;
export const PRIVATE_VIDEO_RKEY_TYPE = 12;
export const GROUP_VIDEO_RKEY_TYPE = 22;
export const PRIVATE_PTT_RKEY_TYPE = 14;
export const GROUP_PTT_RKEY_TYPE = 24;

/** rkey types usable to download images (pic / received animated emoji). */
const IMAGE_RKEY_TYPES = [PRIVATE_IMAGE_RKEY_TYPE, GROUP_IMAGE_RKEY_TYPE];

/** Group scenes use appid 1407; private (c2c) scenes use 1406. */
const GROUP_RKEY_TYPES = new Set([
  GROUP_IMAGE_RKEY_TYPE,
  GROUP_VIDEO_RKEY_TYPE,
  GROUP_PTT_RKEY_TYPE,
]);

export interface DownloadOptions {
  localOnly?: boolean;
  /** Extension for the cached file, e.g. `.jpg` / `.mp4` / `.silk`. */
  ext?: string;
  /** rkey types allowed for this download. Defaults to image types (10/20). */
  rkeyTypes?: number[];
  /**
   * CDN path/URL for the original media. When the `fileToken` is all digits the
   * media predates the rkey scheme — we fetch `<host><originalUrl>` directly
   * (no rkey) and prefer it over the rkey attempts.
   */
  originalUrl?: string;
  /** 仅用户明确请求查看原图时，可在任务列表继续被策略暂停的传输。 */
  reportActivity?: boolean;
  activityTaskId?: string;
  activity?: {
    pageId: string;
    onState(state: DownloadState, resume?: () => void): void;
  };
  /** 取消这个调用方，最后一个调用方离开时才停止共享下载。 */
  signal?: AbortSignal;
}

/**
 * 外部 rkey 服务器的回退源（见 external_rkey.ts）。结构类型接口，避免 account
 * 层反向依赖 bootstrap 层；MediaDownloadService 只要求能按需解析出可用 rkey。
 */
export interface ExternalRkeySource {
  /** 解析外部服务器当前可用的 rkey（已过滤 allowedTypes、未过期）。 */
  resolveRkeys(allowedTypes: number[], signal?: AbortSignal): Promise<DownloadRkey[]>;
}

const mediaSummary = new Map<string, { count: number; failed: number; durationMs: number }>();
type MediaProgress = (received: number, total: number) => void;
type Consumer = { progress?: MediaProgress };
type Transfer = {
  controller: AbortController;
  consumers: Set<Consumer>;
  progress: [number, number];
  work: Promise<string | null>;
};

/** 来源切换时两个账号实例可能指向同一缓存目录。每个实际目标只允许一个分段写入器。 */
const writers = new Map<string, Promise<unknown>>();
async function writeMedia(
  path: string,
  signal: AbortSignal,
  write: () => Promise<string | null>,
): Promise<string | null> {
  const key = resolve(path);
  for (;;) {
    signal.throwIfAborted();
    const previous = writers.get(key);
    if (!previous) break;
    await bounded(
      previous.catch(() => undefined),
      signal,
    );
  }
  const work = Promise.resolve().then(async () => {
    signal.throwIfAborted();
    const hadPartial = existsSync(`${path}.part`) || existsSync(`${path}.resume.json`);
    try {
      return await write();
    } finally {
      if (signal.aborted && !hadPartial) await removeCancelledDownload(path);
    }
  });
  writers.set(key, work);
  try {
    return await work;
  } finally {
    writers.delete(key);
  }
}

async function removeCancelledDownload(path: string): Promise<void> {
  await Promise.all([
    rm(`${path}.part`, { force: true }).catch(() => undefined),
    rm(`${path}.resume.json`, { force: true }).catch(() => undefined),
  ]);
}

let summaryTimer: ReturnType<typeof setTimeout> | undefined;
function summarizeMedia(source: string, durationMs: number, failed = false): void {
  const entry = mediaSummary.get(source) ?? { count: 0, failed: 0, durationMs: 0 };
  entry.count++;
  entry.failed += Number(failed);
  entry.durationMs += durationMs;
  mediaSummary.set(source, entry);
  summaryTimer ??= setTimeout(flushMediaDownloadLogs, 5000);
  summaryTimer.unref();
}
export function flushMediaDownloadLogs(): void {
  if (summaryTimer) clearTimeout(summaryTimer);
  summaryTimer = undefined;
  for (const [source, stats] of mediaSummary)
    getLogger().info('媒体下载汇总', {
      scope: 'media-download',
      event: 'media-download-summary',
      source,
      ...stats,
    });
  mediaSummary.clear();
}
process.once('exit', flushMediaDownloadLogs);

export class MediaDownloadService {
  private readonly downloadingThumbnails = new Map<string, Transfer>();
  private readonly downloading = new Map<string, Transfer>();
  private readonly chatStickers = new Map<string, string>();
  private readonly logger = getLogger().child({ scope: 'media-download' });

  constructor(
    private readonly accountConfig: AccountConfigService,
    private readonly cacheDir: string,
    private readonly externalRkey?: ExternalRkeySource,
    private readonly allowOnline: () => boolean = () => true,
  ) {}

  cachedFile(fileToken: string, ext = ''): string | null {
    if (!fileToken) return null;
    const path = join(this.cacheDir, `${hashToken(fileToken)}${ext}`);
    return existsSync(path) ? path : null;
  }

  cachedChatSticker(md5: string): string | null {
    const path = this.chatStickers.get(md5);
    if (path && existsSync(path)) return path;
    this.chatStickers.delete(md5);
    return null;
  }

  /** 复用本账号已下载的原文件；只有实际内容吻合才跨下载凭据共享。 */
  async rememberChatSticker(md5: string, path: string, signal?: AbortSignal): Promise<void> {
    if (this.cachedChatSticker(md5)) return;
    try {
      const digest = createHash('md5');
      for await (const chunk of createReadStream(path, { signal })) digest.update(chunk);
      if (digest.digest('hex') !== md5) return;
      this.chatStickers.set(md5, path);
      if (this.chatStickers.size > 512)
        this.chatStickers.delete(this.chatStickers.keys().next().value!);
    } catch {
      // 缓存验证失败仍保留原凭据对应的显示来源。
    }
  }

  /** 仅使用消息真实携带的小图地址，不将 spec=0 原图地址变造为缩图。 */
  async thumbnail(raw: string, localOnly = false, signal?: AbortSignal): Promise<string | null> {
    signal?.throwIfAborted();
    let url: URL;
    try {
      url = new URL(raw, MEDIA_HOST);
    } catch {
      return null;
    }
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      !['multimedia.nt.qq.com.cn', 'gchat.qpic.cn', 'c2cpicdw.qpic.cn', 'offpic.qq.com'].includes(
        url.hostname,
      )
    )
      return null;
    const path = join(this.cacheDir, `${hashToken(`thumbnail:${url.href}`)}.thumb`);
    if (existsSync(path)) return path;
    if (localOnly || !this.allowOnline()) return null;
    return this.consume(this.downloadingThumbnails, path, signal, (transferSignal) =>
      writeMedia(path, transferSignal, async () => {
        transferSignal.throwIfAborted();
        if (existsSync(path)) return path;
        return this.downloadThumbnail(url, path, transferSignal);
      }),
    );
  }

  private async downloadThumbnail(url: URL, path: string, signal: AbortSignal) {
    const tried = new Set<string>();
    const fetchCandidate = async (candidate: URL) => {
      signal.throwIfAborted();
      if (!this.allowOnline() || tried.has(candidate.href)) return false;
      tried.add(candidate.href);
      try {
        await mkdir(this.cacheDir, { recursive: true });
        await new ManagedDownload({
          signal,
          maxBytes: 512 * 1024,
          validate: async (_path, response, size) => {
            signal.throwIfAborted();
            if (
              !this.allowOnline() ||
              !size ||
              !(response.headers.get('content-type') ?? '').startsWith('image/')
            )
              throw new Error('缩略图不可用');
          },
        }).file(candidate.href, path);
        return this.allowOnline();
      } catch {
        signal.throwIfAborted();
        return false;
      }
    };
    const type = thumbnailRkeyType(url);
    if (type === undefined) return (await fetchCandidate(url)) ? path : null;

    const fetchWithRkeys = async (keys: DownloadRkey[]) => {
      for (const key of keys) {
        const value = new URLSearchParams(key.rkey).get('rkey');
        if (!value) continue;
        const signed = new URL(url);
        signed.searchParams.set('rkey', value);
        if (await fetchCandidate(signed)) return true;
      }
      return false;
    };
    if (await fetchWithRkeys(this.validRkeys([type]))) return path;
    if (url.searchParams.get('rkey') && (await fetchCandidate(url))) return path;
    if (!this.externalRkey || !this.allowOnline()) return null;
    try {
      const keys = await bounded(this.externalRkey.resolveRkeys([type], signal), signal);
      return (await fetchWithRkeys(keys)) ? path : null;
    } catch {
      signal.throwIfAborted();
      return null;
    }
  }

  /**
   * Download `fileToken` to the cache and return its local path, or null if no
   * usable rkey is available or every attempt failed. Cached on success.
   */
  async download(
    fileToken: string,
    opts: DownloadOptions = {},
    onProgress?: MediaProgress,
  ): Promise<string | null> {
    opts.signal?.throwIfAborted();
    if (!fileToken) return null;
    const path = join(this.cacheDir, `${hashToken(fileToken)}${opts.ext ?? ''}`);
    if (existsSync(path)) {
      this.logger.debug('media cache hit', {
        event: 'media-cache-hit',
        mediaId: hashToken(fileToken).slice(0, 16),
      });
      return path;
    }
    if (opts.localOnly || !this.allowOnline() || !scopedNetworkAllowed()) return null;
    return this.consume(
      this.downloading,
      path,
      opts.signal,
      (signal, progress) =>
        writeMedia(path, signal, () =>
          this.runDownload(fileToken, path, opts, progress, signal),
        ).catch((error: unknown) => {
          if (error instanceof TransferDeferredError) return null;
          throw error;
        }),
      onProgress,
    );
  }

  private async consume(
    tasks: Map<string, Transfer>,
    key: string,
    signal: AbortSignal | undefined,
    load: (signal: AbortSignal, progress: MediaProgress) => Promise<string | null>,
    onProgress?: MediaProgress,
  ): Promise<string | null> {
    let task: Transfer | undefined;
    for (;;) {
      signal?.throwIfAborted();
      task = tasks.get(key);
      if (!task?.controller.signal.aborted) break;
      const closing = task.work.catch(() => undefined);
      await (signal ? bounded(closing, signal) : closing);
    }
    if (!task) {
      const controller = new AbortController();
      const consumers = new Set<Consumer>();
      const progress: [number, number] = [0, 0];
      const report = (received: number, total: number) => {
        progress[0] = received;
        progress[1] = total;
        for (const consumer of consumers) {
          try {
            consumer.progress?.(received, total);
          } catch {
            /* 单个监听者不影响其他调用。 */
          }
        }
      };
      const work = Promise.resolve()
        .then(() => load(controller.signal, report))
        .finally(() => tasks.delete(key));
      void work.catch(() => undefined);
      task = { controller, consumers, progress, work };
      tasks.set(key, task);
    }
    const active = task;
    const consumer: Consumer = { progress: onProgress };
    active.consumers.add(consumer);
    const release = () => {
      active.consumers.delete(consumer);
      if (!active.consumers.size && tasks.get(key) === active)
        active.controller.abort(signal?.reason);
    };
    signal?.addEventListener('abort', release, { once: true });
    try {
      onProgress?.(...task.progress);
      return await (signal ? bounded(active.work, signal) : active.work);
    } finally {
      signal?.removeEventListener('abort', release);
      release();
    }
  }

  private async runDownload(
    fileToken: string,
    cachePath: string,
    opts: DownloadOptions,
    onProgress: MediaProgress,
    signal: AbortSignal,
  ): Promise<string | null> {
    signal.throwIfAborted();
    const began = performance.now();
    const mediaId = hashToken(fileToken).slice(0, 16);
    if (existsSync(cachePath)) {
      this.logger.debug('media cache hit', { event: 'media-cache-hit', mediaId });
      return cachePath;
    }
    if (!this.allowOnline() || !scopedNetworkAllowed()) return null;

    const urls: Array<{ url: string; source: string }> = [];
    // Digit-only tokens are pre-rkey media: fetch the original directly, no rkey.
    if (opts.originalUrl && isAllDigits(fileToken)) {
      urls.push({ url: resolveOriginalUrl(opts.originalUrl), source: 'original' });
    }
    const allowed = opts.rkeyTypes ?? IMAGE_RKEY_TYPES;
    this.logger.debug('starting media download', {
      event: 'media-download-start',
      mediaId,
      allowedRkeyTypes: allowed,
      hasOriginalUrl: Boolean(opts.originalUrl),
    });
    for (const rkey of this.validRkeys(allowed)) {
      urls.push({ url: composeMediaDownloadUrl(fileToken, rkey), source: 'local-rkey' });
    }

    // 先试本机在线 QQ 自己获取的 rkey（含老图片的原始 URL）；全部失败且配置了
    // 外部 rkey 服务器时，再回退到它（可能触发一次网络拉取并缓存）。
    const failures: Record<string, number> = {};
    const note = (stage: string) => (reason: string) => {
      const key = `${stage}:${reason}`;
      failures[key] = (failures[key] ?? 0) + 1;
      this.logger.debug('媒体下载尝试', {
        event: 'media-download-attempt',
        mediaId,
        stage,
        reason,
      });
    };
    let source = 'unavailable';
    let externalCandidateCount = 0;
    const taskId = opts.activityTaskId ?? globalThis.crypto.randomUUID();
    const fetchCandidate = (url: string, stage: string) =>
      tryFetch(
        url,
        this.allowOnline,
        note(stage),
        cachePath,
        onProgress,
        signal,
        opts.reportActivity,
        opts.activity,
        opts.reportActivity
          ? {
              id: taskId,
              request: {
                type: 'chat-original',
                token: fileToken,
                originalUrl: /^\/(?!\/)[^?#]*$/.test(opts.originalUrl ?? '')
                  ? opts.originalUrl
                  : undefined,
                ext: opts.ext,
                rkeyTypes: opts.rkeyTypes,
              },
            }
          : undefined,
      );
    let bytes: number | null = null;
    for (const candidate of urls) {
      if (!this.allowOnline()) return null;
      bytes = await fetchCandidate(candidate.url, candidate.source);
      if (bytes) {
        source = candidate.source;
        break;
      }
    }
    signal.throwIfAborted();
    if (!urls.length) note('local-rkey')('no-candidates');
    if (!bytes && this.externalRkey && this.allowOnline()) {
      let externalRkeys: DownloadRkey[] = [];
      try {
        externalRkeys = await bounded(this.externalRkey.resolveRkeys(allowed, signal), signal);
      } catch (error) {
        signal.throwIfAborted();
        failures['external:resolve'] = 1;
        this.logger.debug('external rkey resolve failed', {
          event: 'media-download-external-resolve-failed',
          mediaId,
          ...logErrorContext(error),
        });
      }
      source = 'external-rkey';
      externalCandidateCount = externalRkeys.length;
      if (!externalCandidateCount) note('external')('no-candidates');
      for (const rkey of externalRkeys) {
        if (!this.allowOnline()) return null;
        bytes = await fetchCandidate(composeMediaDownloadUrl(fileToken, rkey), 'external');
        if (bytes) break;
      }
    }
    signal.throwIfAborted();
    if (bytes) {
      if (!this.allowOnline()) return null;
      summarizeMedia(source, Math.round(performance.now() - began));
      this.logger.debug('downloaded media into cache', {
        event: 'media-download-success',
        mediaId,
        source,
        size: bytes,
      });
      return cachePath;
    }
    if (!this.allowOnline()) return null;
    summarizeMedia(source, Math.round(performance.now() - began), true);
    this.logger.warn('media download exhausted all candidates', {
      event: 'media-download-failed',
      mediaId,
      failures,
      externalCandidateCount,
      externalConfigured: Boolean(this.externalRkey),
      durationMs: Math.round(performance.now() - began),
      candidateCount: urls.length,
    });
    return null;
  }

  private validRkeys(allowedTypes: number[]): DownloadRkey[] {
    const rkeys = this.accountConfig.getRecord()?.rkeys ?? [];
    const now = Date.now();
    return rkeys.filter((r) => allowedTypes.includes(r.type) && rkeyExpiryMs(r) > now);
  }
}

function isAllDigits(s: string): boolean {
  return /^\d+$/.test(s);
}

/** QQ 消息里的小图常只有相对路径。补同场景票据时保留原 fileid 和 spec。 */
function thumbnailRkeyType(url: URL): number | undefined {
  if (
    url.origin !== MEDIA_HOST ||
    url.pathname !== '/download' ||
    !url.searchParams.get('fileid') ||
    !/^(?:198|720)$/.test(url.searchParams.get('spec') ?? '')
  )
    return undefined;
  const appid = url.searchParams.get('appid');
  if (appid === '1406') return PRIVATE_IMAGE_RKEY_TYPE;
  if (appid === '1407') return GROUP_IMAGE_RKEY_TYPE;
  return undefined;
}

/** `originalUrl` is usually a host-relative path; join it onto the media host. */
export function resolveOriginalUrl(originalUrl: string): string {
  if (/^https?:\/\//i.test(originalUrl)) return originalUrl;
  return `${MEDIA_HOST}${originalUrl.startsWith('/') ? '' : '/'}${originalUrl}`;
}

/**
 * 媒体 CDN 直链：`…/download?appid=<1406|1407>&fileid=<token>&spec=0&rkey=…`。
 * 群场景用 appid 1407、私聊用 1406（由 rkey 的 type 反推）。
 */
export function composeMediaDownloadUrl(fileToken: string, rkey: DownloadRkey): string {
  const appid = GROUP_RKEY_TYPES.has(rkey.type) ? '1407' : '1406';
  // rkey.rkey already includes its "&rkey=" prefix as QQ returns it.
  return `${DOWNLOAD_BASE}?appid=${appid}&fileid=${encodeURIComponent(fileToken)}&spec=0${rkey.rkey}`;
}

async function tryFetch(
  url: string,
  allowed: () => boolean,
  note: (reason: string) => void,
  cachePath: string,
  onProgress: MediaProgress,
  signal: AbortSignal,
  reportActivity = false,
  activity?: DownloadOptions['activity'],
  activityResume?: ManagedDownload['activityResume'],
): Promise<number | null> {
  const check = () => {
    signal.throwIfAborted();
    if (!allowed()) throw new Error('账号来源已失活');
  };
  let bytes = 0;
  try {
    check();
    await mkdir(dirname(cachePath), { recursive: true });
    const transfer = new ManagedDownload({
      name: reportActivity ? '下载聊天媒体' : undefined,
      activityPageId: activity?.pageId,
      activityResume,
      state:
        activity &&
        ((state) => activity.onState(state, state.paused ? () => transfer.continue() : undefined)),
      deferOnPolicyPause: !reportActivity,
      signal,
      maxAttempts: 4,
      retryBaseMs: 300,
      fetcher: async (input, init) => {
        check();
        const response = await networkFetch(input, init).catch((error) => {
          if (!signal.aborted && allowed()) note('network');
          throw error;
        });
        if (!allowed() || signal.aborted) {
          await response.body?.cancel().catch(() => undefined);
          check();
        }
        if (!response.ok) note(`http-${response.status}`);
        else if ((response.headers.get('content-type') ?? '').startsWith('text/')) {
          note('text-response');
          await response.body?.cancel();
          throw new Error('媒体地址返回了文本');
        }
        return response;
      },
      validate: async (_path, _response, size) => {
        check();
        if (!size) {
          note('empty-response');
          throw new Error('媒体为空');
        }
        bytes = size;
      },
    });
    await transfer.file(url, cachePath, {}, (received, total) => {
      check();
      onProgress(received, total);
    });
    return bytes;
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof TransferDeferredError) throw error;
    return null;
  }
}

function hashToken(token: string): string {
  return createHash('sha1').update(token).digest('hex');
}
