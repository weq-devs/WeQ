import { AsyncLocalStorage } from 'node:async_hooks';

export interface QzonePaginationSettings {
  windowSeconds: number;
  maxPages: number;
}

export const DEFAULT_QZONE_PAGINATION: QzonePaginationSettings = {
  windowSeconds: 10,
  maxPages: 5,
};

export function normalizeQzonePagination(
  value: Partial<QzonePaginationSettings> | undefined,
  fallback: QzonePaginationSettings = DEFAULT_QZONE_PAGINATION,
): QzonePaginationSettings {
  const valid = (n: unknown, max: number): n is number =>
    typeof n === 'number' && Number.isSafeInteger(n) && n >= 1 && n <= max;
  return {
    windowSeconds: valid(value?.windowSeconds, 3600) ? value.windowSeconds : fallback.windowSeconds,
    maxPages: valid(value?.maxPages, 1000) ? value.maxPages : fallback.maxPages,
  };
}

type Waiter = {
  resolve: () => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  cancel: () => void;
};

/** One FIFO sliding window shared by browsing, exports and hidden comment pagination. */
export class QzonePaginationLimiter {
  private settings = { ...DEFAULT_QZONE_PAGINATION };
  private starts: number[] = [];
  private queue: Waiter[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  configure(settings: QzonePaginationSettings): void {
    this.settings = normalizeQzonePagination(settings);
    // Keep the recent admissions: editing settings must not reset the quota.
    this.drain();
  }

  acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('空间翻页已取消'));
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        signal,
        cancel: () => {
          const index = this.queue.indexOf(waiter);
          if (index < 0) return;
          this.queue.splice(index, 1);
          signal?.removeEventListener('abort', waiter.cancel);
          reject(signal?.reason ?? new Error('空间翻页已取消'));
          this.drain();
        },
      };
      this.queue.push(waiter);
      signal?.addEventListener('abort', waiter.cancel, { once: true });
      this.drain();
    });
  }

  private drain(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const now = performance.now();
    // At most 1000 admissions are relevant to any allowed future setting.
    this.starts = this.starts.filter((at) => at > now - 3600_000).slice(-1000);
    while (this.queue.length) {
      const at = this.starts.at(-this.settings.maxPages);
      const delay = at === undefined ? 0 : at + this.settings.windowSeconds * 1000 - now;
      if (delay > 0) {
        this.timer = setTimeout(() => this.drain(), Math.ceil(delay));
        return;
      }
      const waiter = this.queue.shift()!;
      waiter.signal?.removeEventListener('abort', waiter.cancel);
      this.starts.push(now);
      if (this.starts.length > 1000) this.starts.shift();
      waiter.resolve();
    }
  }
}

export const qzonePaginationLimiter = new QzonePaginationLimiter();
const waits = new AsyncLocalStorage<(change: 1 | -1) => void>();

export async function waitForQzonePage(signal?: AbortSignal): Promise<void> {
  const observer = waits.getStore();
  observer?.(1);
  try {
    await qzonePaginationLimiter.acquire(signal);
  } finally {
    observer?.(-1);
  }
}

/** The operation watchdog counts work time, not time intentionally spent in the quota queue. */
export async function withQzonePaginationTimeout<T>(
  controller: AbortController,
  timeoutMs: number,
  work: () => Promise<T>,
): Promise<T> {
  let remaining = timeoutMs;
  let since = performance.now();
  let waiting = 0;
  let closed = false;
  const expire = () => controller.abort(new Error('空间加载超时，请重试。'));
  let timer = setTimeout(expire, remaining);
  try {
    return await waits.run((change) => {
      if (closed) return;
      if (change === 1 && waiting++ === 0) {
        remaining = Math.max(0, remaining - (performance.now() - since));
        clearTimeout(timer);
      } else if (change === -1 && --waiting === 0) {
        since = performance.now();
        timer = setTimeout(expire, remaining);
      }
    }, work);
  } finally {
    closed = true;
    clearTimeout(timer);
  }
}

const PAGE_PATHS = new Set([
  '/cgi-bin/emotion_cgi_msglist_v6',
  '/cgi-bin/emotion_cgi_getcmtreply_v6',
  '/cgi-bin/emotion_cgi_ic_getcomments',
  '/cgi-bin/emotion_cgi_get_fullrelay_v6',
  '/cgi-bin/feeds/feeds3_html_more',
  '/cgi-bin/feeds/feeds_html_module',
  '/cgi-bin/feeds/feeds_html_act_all',
  '/cgi-bin/feeds/feeds2_html_picfeed_qqtab',
  '/cgi-bin/feeds/feeds2_html_picfeed',
  '/cgi-bin/feeds/feeds2_html_pav_all',
  '/cgi-bin/feeds/feeds2_html_today_lastyear',
  '/fcgi-bin/fcg_list_album_v3',
  '/fcgi-bin/cgi_list_photo',
  '/cgi-bin/likes/get_like_list_app',
  '/cgi-bin/app/cgi_pcomment_xml_v2',
]);

export function isQzonePageRequest(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!['user.qzone.qq.com', 'h5.qzone.qq.com', 'rc.qzone.qq.com'].includes(parsed.hostname))
    return false;
  const target = parsed.pathname.match(/^\/proxy\/domain\/([^/]+)(\/.*)$/);
  if (!target || !/^(?:[a-z0-9-]+\.)*(?:qzone\.qq\.com|taotao\.qq\.com)$/.test(target[1]!))
    return false;
  return PAGE_PATHS.has(target[2]!);
}
