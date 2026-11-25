import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import semver from 'semver';
import { downloadSources, fetchSourceJson, networkFetch, orderSources } from '@weq/network';
import {
  ANNOUNCEMENT_URL,
  MAX_ANNOUNCEMENT_BYTES,
  announcementReleaseUrl,
  verifyAnnouncementFeed,
  type AnnouncementFeed,
  type AnnouncementPlatform,
  type OfficialAnnouncement,
} from '@weq/network/announcement-metadata';
import releaseKeys from '@weq/network/release-keys';
import { getLogger } from '@weq/service';
import { writeFileAtomic } from '@weq/service/atomic-write';
import { notificationInlineText } from '../shared/notification_copy';
import { type AnnouncementReceipts, openAnnouncementReceipts } from './announcement_receipts';

const REFRESH_INTERVAL = 15 * 60_000;
const OPEN_REFRESH_MAX_AGE = 60_000;
const RECEIPT_POLL_INTERVAL = 1_000;
type FeedStatus = 'loading' | 'ready' | 'cached' | 'unavailable';
const logger = getLogger().child({ scope: 'announcements' });
type VerifiedFeed = { feed: AnnouncementFeed; envelope: unknown; signature: string };

interface AnnouncementHostOptions {
  dataRoot: string;
  sharedDataRoot?: string;
  platform: AnnouncementPlatform | null;
  version: string;
  bannerEnabled: () => boolean;
  fetcher?: typeof fetch;
  keys?: readonly string[];
  now?: () => number;
}

export function desktopAnnouncementPlatform(platform: NodeJS.Platform) {
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'windows';
  if (platform === 'linux') return 'linux';
  return null;
}

export class Announcements {
  private readonly directory: string;
  private readonly now: () => number;
  private readonly controller = new AbortController();
  private readonly listeners = new Set<() => void>();
  private readonly loaded: Promise<void>;
  private current?: VerifiedFeed;
  private status: FeedStatus = 'loading';
  private lastRefreshWarning?: 'cached' | 'unavailable';
  private receipts?: AnnouncementReceipts;
  private updates: Promise<unknown> = Promise.resolve();
  private pending?: Promise<void>;
  private lastCheckedAt?: number;
  private timer?: ReturnType<typeof setInterval>;
  private receiptTimer?: ReturnType<typeof setInterval>;
  private change = 0;

  constructor(private readonly host: AnnouncementHostOptions) {
    this.directory = join(host.dataRoot, 'announcements');
    this.now = host.now ?? Date.now;
    this.loaded = this.load();
  }

  start() {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_INTERVAL).unref();
  }

  stop() {
    clearInterval(this.timer);
    clearInterval(this.receiptTimer);
    this.receipts?.close?.();
    this.receipts = undefined;
    this.controller.abort();
  }

  subscribe(listener: (change: number) => void) {
    const notify = () => listener(this.change);
    this.listeners.add(notify);
    if (this.host.sharedDataRoot) {
      this.receiptTimer ??= setInterval(() => {
        try {
          if (this.receipts?.pollChanged?.()) this.emit();
        } catch (error) {
          logger.debug('跨窗口公告回执检查失败', { error: String(error) });
        }
      }, RECEIPT_POLL_INTERVAL).unref();
    }
    notify();
    return () => {
      this.listeners.delete(notify);
      if (this.listeners.size) return;
      clearInterval(this.receiptTimer);
      this.receiptTimer = undefined;
    };
  }

  private emit() {
    this.change++;
    for (const listener of this.listeners) listener();
  }

  private verify(envelope: unknown): VerifiedFeed {
    const feed = verifyAnnouncementFeed(envelope, this.host.keys ?? releaseKeys);
    return { feed, envelope, signature: (envelope as { signature: string }).signature };
  }

  private async load() {
    const [feed, receipts] = await Promise.allSettled([
      readFile(join(this.directory, 'feed.json'), 'utf8').then((value) =>
        this.verify(JSON.parse(value)),
      ),
      openAnnouncementReceipts(this.host.dataRoot, this.host.sharedDataRoot),
    ]);
    if (this.controller.signal.aborted) {
      if (receipts.status === 'fulfilled') receipts.value.close?.();
      return;
    }
    if (feed.status === 'fulfilled') {
      this.current = feed.value;
      this.status = 'cached';
    }
    if (receipts.status === 'fulfilled') this.receipts = receipts.value;
    else logger.warn('无法加载公告已读状态', { error: String(receipts.reason) });
  }

  private matches(entry: OfficialAnnouncement, now: number) {
    return (
      Date.parse(entry.publishedAt) <= now &&
      (!entry.platforms ||
        (this.host.platform !== null && entry.platforms.includes(this.host.platform))) &&
      (!entry.versionRange ||
        semver.satisfies(this.host.version, entry.versionRange, { includePrerelease: true }))
    );
  }

  private withinReminderPeriod(entry: OfficialAnnouncement, now: number) {
    return (
      entry.level === 'important' && !!entry.remindUntil && now < Date.parse(entry.remindUntil)
    );
  }

  async list() {
    await this.loaded;
    const now = this.now();
    const matching = (this.current?.feed.entries ?? [])
      .filter((entry) => this.matches(entry, now))
      .sort(
        (a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt) || a.id.localeCompare(b.id),
      );
    let reminder: { id: string; title: string; summary: string; remainingMs: number } | null = null;
    const bannerEnabled = this.host.bannerEnabled();
    const entries: Array<
      Pick<OfficialAnnouncement, 'id' | 'title' | 'level' | 'publishedAt'> & { unread: boolean }
    > = [];
    for (const entry of matching) {
      const { id, title, level, publishedAt } = entry;
      const receipt = this.receipts?.get(id);
      if (
        !reminder &&
        bannerEnabled &&
        receipt &&
        !receipt.read &&
        !receipt.reminded &&
        this.withinReminderPeriod(entry, now)
      )
        reminder = {
          id,
          title,
          summary: notificationInlineText(entry.body, 140),
          remainingMs: Date.parse(entry.remindUntil!) - now,
        };
      entries.push({ id, title, level, publishedAt, unread: !receipt?.read });
    }
    return {
      status: this.status,
      entries,
      unread: entries.filter((entry) => entry.unread).length,
      reminder,
    };
  }

  async detail(id: string) {
    await this.loaded;
    const entry = this.current?.feed.entries.find((row) => row.id === id);
    if (!entry || !this.matches(entry, this.now())) return null;
    const releasePageUrl =
      entry.releaseVersion &&
      semver.valid(this.host.version) &&
      semver.gt(entry.releaseVersion, this.host.version)
        ? announcementReleaseUrl(entry.releaseVersion)
        : null;
    return { ...entry, releasePageUrl };
  }

  refresh({ ifStale = false }: { ifStale?: boolean } = {}): Promise<void> {
    if (this.pending) return this.pending;
    if (
      ifStale &&
      this.lastCheckedAt !== undefined &&
      this.now() - this.lastCheckedAt < OPEN_REFRESH_MAX_AGE
    )
      return Promise.resolve();
    this.pending = this.check().finally(() => {
      this.lastCheckedAt = this.now();
      this.pending = undefined;
    });
    return this.pending;
  }

  private async check() {
    await this.loaded;
    const signal = this.controller.signal;
    if (signal.aborted) return;
    const current = this.current;
    let officialMissing = false;
    const transport = this.host.fetcher ?? networkFetch;
    const fetcher: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set('Cache-Control', 'no-cache');
      const response = await transport(input, { ...init, headers });
      if (input === ANNOUNCEMENT_URL && response.status === 404) officialMissing = true;
      return response;
    };
    const options = { signal, fetcher, maxBytes: MAX_ANNOUNCEMENT_BYTES };
    const read = (sources: string[], mirror: boolean) =>
      fetchSourceJson(
        ANNOUNCEMENT_URL,
        (envelope) => {
          const value = this.verify(envelope);
          if (
            current &&
            value.feed.revision <= current.feed.revision &&
            (mirror || value.signature !== current.signature)
          )
            throw new Error('官方公告修订未前进');
          return value;
        },
        {
          ...options,
          sources,
          onSourceFailure: (source, failure) => {
            const error =
              failure instanceof Error
                ? (/(?:net::)?ERR_[A-Z0-9_]+/.exec(failure.message)?.[0] ?? failure.name)
                : undefined;
            logger.debug(mirror ? '公告镜像请求失败' : '公告官方源请求失败', {
              address: new URL(source).hostname,
              code: error,
            });
          },
        },
      );
    try {
      const next = await read([ANNOUNCEMENT_URL], false).catch((error: unknown) => {
        if (officialMissing || signal.aborted) throw error;
        const mirrors = orderSources(downloadSources(ANNOUNCEMENT_URL))
          .filter((url) => url !== ANNOUNCEMENT_URL)
          .slice(0, 3);
        return read(mirrors, true);
      });
      signal.throwIfAborted();
      if (next.signature !== current?.signature) {
        await mkdir(this.directory, { recursive: true });
        await writeFileAtomic(join(this.directory, 'feed.json'), JSON.stringify(next.envelope));
        this.current = next;
      }
      this.status = 'ready';
    } catch {
      if (signal.aborted) return;
      this.status = current ? 'cached' : officialMissing ? 'ready' : 'unavailable';
    }
    const warning = this.status === 'ready' ? undefined : this.status;
    if (warning && this.lastRefreshWarning !== warning) {
      logger.warn(
        warning === 'cached'
          ? '官方公告刷新失败，显示已验签缓存'
          : '官方公告暂不可用，可在公告页重试',
      );
    }
    this.lastRefreshWarning = warning;
    this.emit();
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.updates.then(work);
    this.updates = next.catch(() => {});
    return next;
  }

  markRead(ids: readonly string[]) {
    return this.serialize(async () => {
      await this.loaded;
      const requested = new Set(ids);
      const now = this.now();
      const entries = this.current?.feed.entries ?? [];
      const seen = entries
        .filter((entry) => requested.has(entry.id) && this.matches(entry, now))
        .map(({ id }) => id);
      if (seen.length) {
        if (!this.receipts) throw new Error('公告已读状态暂不可用');
        const feedIds = entries.map(({ id }) => id);
        if (await this.receipts.markRead(seen, feedIds)) this.emit();
      }
      return this.list();
    });
  }

  dismissBanner(id: string) {
    return this.serialize(async () => {
      const entry = await this.detail(id);
      if (!entry || !this.withinReminderPeriod(entry, this.now())) return;
      if (!this.receipts) throw new Error('公告提醒状态暂不可用');
      const feedIds = this.current?.feed.entries.map(({ id }) => id) ?? [];
      if (await this.receipts.dismissBanner(id, feedIds)) this.emit();
    });
  }
}

let service: Announcements | undefined;
export function startAnnouncements(host: AnnouncementHostOptions) {
  const instance = new Announcements(host);
  service = instance;
  instance.start();
  return () => instance.stop();
}

export function getAnnouncements() {
  if (!service) throw new Error('官方公告尚未准备好');
  return service;
}
