import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import semver from 'semver';
import { z } from 'zod';
import { downloadSources, fetchSourceJson, networkFetch, orderSources } from '@weq/network';
import {
  ANNOUNCEMENT_ID,
  ANNOUNCEMENT_URL,
  MAX_ANNOUNCEMENT_BYTES,
  verifyAnnouncementFeed,
  type AnnouncementFeed,
  type AnnouncementPlatform,
  type OfficialAnnouncement,
} from '@weq/network/announcement-metadata';
import releaseKeys from '@weq/network/release-keys';
import { writeFileAtomic } from '@weq/service/atomic-write';

const REFRESH_INTERVAL = 15 * 60_000;
const RESERVATION_TIME = 15_000;
const receiptsSchema = z.object({
  read: z.array(z.string().regex(ANNOUNCEMENT_ID)),
  reminded: z.array(z.string().regex(ANNOUNCEMENT_ID)),
});
type Receipts = z.infer<typeof receiptsSchema>;
type FeedStatus = 'loading' | 'ready' | 'cached' | 'unavailable';
type VerifiedFeed = { feed: AnnouncementFeed; envelope: unknown; signature: string };

interface AnnouncementHostOptions {
  dataRoot: string;
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
  private receipts: Receipts = { read: [], reminded: [] };
  private updates: Promise<unknown> = Promise.resolve();
  private pending?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private reservation?: { id: string; token: string; expiresAt: number };
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
    this.controller.abort();
  }

  subscribe(listener: (change: number) => void) {
    const notify = () => listener(this.change);
    this.listeners.add(notify);
    notify();
    return () => this.listeners.delete(notify);
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
    const readJson = async (name: string): Promise<unknown> =>
      JSON.parse(await readFile(join(this.directory, name), 'utf8'));
    const [feed, receipts] = await Promise.allSettled([
      readJson('feed.json').then((value) => this.verify(value)),
      readJson('receipts.json').then((value) => receiptsSchema.parse(value)),
    ]);
    if (feed.status === 'fulfilled') {
      this.current = feed.value;
      this.status = 'cached';
    }
    if (receipts.status === 'fulfilled') this.receipts = receipts.value;
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

  private canRemind(entry: OfficialAnnouncement, now: number) {
    return (
      entry.level === 'important' &&
      !!entry.remindUntil &&
      now < Date.parse(entry.remindUntil) &&
      !this.receipts.read.includes(entry.id) &&
      !this.receipts.reminded.includes(entry.id)
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
    const entries = matching.map(({ id, title, level, publishedAt }) => ({
      id,
      title,
      level,
      publishedAt,
      unread: !this.receipts.read.includes(id),
    }));
    return {
      status: this.status,
      entries,
      unread: entries.filter((entry) => entry.unread).length,
      reminder: matching.find((entry) => this.canRemind(entry, now))?.id ?? null,
    };
  }

  async detail(id: string) {
    await this.loaded;
    const entry = this.current?.feed.entries.find((row) => row.id === id);
    return entry && this.matches(entry, this.now()) ? entry : null;
  }

  refresh(): Promise<void> {
    this.pending ??= this.check().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async check() {
    await this.loaded;
    const signal = this.controller.signal;
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
        { ...options, sources },
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
    this.emit();
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.updates.then(work);
    this.updates = next.catch(() => {});
    return next;
  }

  private async save(receipts: Receipts) {
    const ids = new Set(this.current?.feed.entries.map(({ id }) => id));
    const next = {
      read: receipts.read.filter((id) => ids.has(id)),
      reminded: receipts.reminded.filter((id) => ids.has(id)),
    };
    await mkdir(this.directory, { recursive: true });
    await writeFileAtomic(join(this.directory, 'receipts.json'), JSON.stringify(next));
    this.receipts = next;
    this.emit();
  }

  markRead(ids: readonly string[]) {
    return this.serialize(async () => {
      await this.loaded;
      const requested = new Set(ids);
      const now = this.now();
      const newReads = this.current?.feed.entries.filter(
        (entry) =>
          requested.has(entry.id) &&
          !this.receipts.read.includes(entry.id) &&
          this.matches(entry, now),
      );
      if (newReads?.length)
        await this.save({
          ...this.receipts,
          read: [...this.receipts.read, ...newReads.map(({ id }) => id)],
        });
      return this.list();
    });
  }

  claimBanner(id: string) {
    return this.serialize(async () => {
      const entry = await this.detail(id);
      const now = this.now();
      if (
        (this.reservation && this.reservation.expiresAt > now) ||
        !entry ||
        !this.host.bannerEnabled() ||
        !this.canRemind(entry, now)
      )
        return null;
      const token = randomUUID();
      this.reservation = { id, token, expiresAt: now + RESERVATION_TIME };
      return {
        token,
        title: entry.title,
        remainingMs: Date.parse(entry.remindUntil!) - now,
        leaseMs: RESERVATION_TIME,
      };
    });
  }

  finishBanner(token: string, shown: boolean) {
    return this.serialize(async () => {
      const pending = this.reservation;
      if (pending?.token !== token) return;
      try {
        if (shown)
          await this.save({ ...this.receipts, reminded: [...this.receipts.reminded, pending.id] });
      } finally {
        this.reservation = undefined;
      }
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
