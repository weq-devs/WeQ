import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ANNOUNCEMENT_REPOSITORY,
  ANNOUNCEMENT_URL,
  signAnnouncementFeed,
  type AnnouncementPlatform,
  type OfficialAnnouncement,
  type SignedAnnouncementFeed,
} from '@weq/network/announcement-metadata';
import {
  normalizeNotificationEvents,
  notificationGroupState,
} from '@weq/service/notification-settings';
import { Announcements } from '../src/main/announcements';

const keys = generateKeyPairSync('ed25519', {
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const publishedAt = '2026-11-18T16:00:00Z';
const remindUntil = '2026-11-19T16:00:00Z';
const regular: OfficialAnnouncement = {
  id: 'release-notice',
  title: '使用提示',
  body: '请查看说明。',
  publishedAt,
  level: 'normal',
};
const important: OfficialAnnouncement = {
  ...regular,
  id: 'maintenance',
  title: '维护安排',
  level: 'important',
  publishedAt: '2026-11-18T17:00:00Z',
  remindUntil,
};
function signed(revision: number, entries: OfficialAnnouncement[]) {
  return signAnnouncementFeed(
    {
      schemaVersion: 1,
      kind: 'official-announcements',
      repository: ANNOUNCEMENT_REPOSITORY,
      revision,
      entries,
    },
    keys.privateKey,
  );
}

describe('宿主官方公告', () => {
  let dataRoot: string;
  let now: number;
  let enabled: boolean;
  let origin: SignedAnnouncementFeed | 'offline' | null;
  let mirror: SignedAnnouncementFeed | null;
  let instances: Announcements[];
  beforeEach(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'weq-announcements-test-'));
    instances = [];
    now = Date.parse('2026-11-19T02:00:00Z');
    enabled = true;
    origin = null;
    mirror = null;
  });
  afterEach(async () => {
    for (const host of instances) host.stop();
    await rm(dataRoot, { recursive: true, force: true });
  });
  function host(platform: AnnouncementPlatform = 'macos', version = '2.7.4') {
    const fetcher = vi.fn<typeof fetch>(async (url) => {
      const feed = url === ANNOUNCEMENT_URL ? origin : mirror;
      if (feed === 'offline') throw new Error('offline');
      return feed ? Response.json(feed) : new Response(null, { status: 404 });
    });
    const instance = new Announcements({
      dataRoot,
      platform,
      version,
      now: () => now,
      bannerEnabled: () => enabled,
      keys: [keys.publicKey],
      fetcher,
    });
    instances.push(instance);
    return { instance, fetcher };
  }

  it('以已确认的官方 404 表示初次未发布，随后按宿主平台与版本共同匹配', async () => {
    const { instance, fetcher } = host('macos', '2.7.4-beta.1');
    await Promise.all([instance.refresh(), instance.refresh()]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await instance.list()).toMatchObject({ status: 'ready', entries: [] });
    const targeted = { ...regular, platforms: ['macos'] as const, versionRange: '>=2.7.0 <2.8.0' };
    origin = signed(1, [
      { ...targeted, platforms: [...targeted.platforms] },
      { ...important, platforms: ['macos'], versionRange: '>=2.8.0' },
      { ...important, id: 'standalone-only', platforms: ['web'] },
      { ...regular, id: 'future', publishedAt: '2026-11-20T16:00:00Z' },
    ]);
    await instance.refresh();
    expect((await instance.list()).entries.map(({ id }) => id)).toEqual([regular.id]);
    expect((await instance.list()).entries[0]).not.toHaveProperty('body');
    expect(await instance.detail('standalone-only')).toBeNull();
    const web = host('web').instance;
    expect((await web.list()).entries.map(({ id }) => id)).toEqual(['standalone-only']);
  });

  it('只接受前进的验签快照，断网保留读过的内容，签名空清单能撤回', async () => {
    const { instance } = host();
    origin = signed(5, [regular, important]);
    await instance.refresh();
    await instance.markRead([regular.id]);
    origin = { ...signed(6, []), signature: signed(4, []).signature };
    mirror = signed(4, []);
    await instance.refresh();
    expect(await instance.list()).toMatchObject({ status: 'cached', unread: 1 });
    origin = 'offline';
    const restarted = host().instance;
    await restarted.refresh();
    expect((await restarted.detail(regular.id))?.body).toBe(regular.body);
    expect(await restarted.list()).toMatchObject({ status: 'cached', unread: 1 });
    mirror = signed(6, [{ ...regular, title: '修订标题' }]);
    await restarted.refresh();
    expect(await restarted.list()).toMatchObject({ status: 'ready', unread: 0 });
    expect(await restarted.detail(important.id)).toBeNull();
    origin = signed(6, []);
    await restarted.refresh();
    expect(await restarted.detail(regular.id)).not.toBeNull();
    origin = signed(7, []);
    await restarted.refresh();
    expect(await restarted.list()).toMatchObject({ status: 'ready', entries: [] });
  });

  it('打开公告时复用近期检查，多端共用在途请求，失败后可立即重试', async () => {
    const { instance, fetcher } = host();
    origin = signed(1, [regular]);
    await Promise.all([instance.refresh(), instance.refresh({ ifStale: true })]);
    expect(fetcher).toHaveBeenCalledTimes(1);

    origin = signed(2, [regular, important]);
    await instance.refresh({ ifStale: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
    now += 60_000;
    await Promise.all([instance.refresh({ ifStale: true }), instance.refresh({ ifStale: true })]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect((await instance.list()).entries.map(({ id }) => id)).toEqual([important.id, regular.id]);

    origin = 'offline';
    now += 60_000;
    await instance.refresh({ ifStale: true });
    expect(await instance.list()).toMatchObject({ status: 'cached', unread: 2 });
    origin = signed(3, [regular]);
    await instance.refresh();
    expect(await instance.list()).toMatchObject({ status: 'ready', unread: 1 });
  });

  it('升级后保留发布公告，只对低于公告版本的宿主返回更新入口', async () => {
    origin = signed(1, [regular, { ...important, releaseVersion: '2.10.0' }]);
    const older = host('macos', '2.9.9').instance;
    await older.refresh();
    expect(await older.detail(important.id)).toMatchObject({
      body: important.body,
      releasePageUrl: 'https://github.com/weq-devs/WeQ/releases/tag/v2.10.0',
    });
    expect(await older.detail(regular.id)).toMatchObject({ releasePageUrl: null });
    for (const version of ['2.10.0', '2.11.0']) {
      const current = host('macos', version).instance;
      expect(await current.detail(important.id)).toMatchObject({
        body: important.body,
        releasePageUrl: null,
      });
      expect((await current.list()).entries.map(({ id }) => id)).toContain(important.id);
    }
  });

  it('只写入用户看到的已读项，多个订阅端同时收到变更', async () => {
    const { instance } = host();
    origin = signed(1, [regular]);
    await instance.refresh();
    const seenIds = (await instance.list()).entries.map(({ id }) => id);
    const clients = [vi.fn(), vi.fn()];
    const unsubscribers = clients.map((listener) => instance.subscribe(listener));
    origin = signed(2, [regular, important]);
    await instance.refresh();
    await instance.markRead(seenIds);
    expect((await instance.list()).entries.map(({ id, unread }) => [id, unread])).toEqual([
      [important.id, true],
      [regular.id, false],
    ]);
    expect(clients[0].mock.calls).toEqual(clients[1].mock.calls);
    for (const listener of clients) expect(listener).toHaveBeenCalledTimes(3);
    for (const unsubscribe of unsubscribers) unsubscribe();
  });

  it('只允许一个前台领取，放弃不消费，展示不读，截止后只剩历史', async () => {
    const { instance } = host();
    const expiring = { ...important, id: 'other-important' };
    origin = signed(1, [important, expiring, regular]);
    await instance.refresh();
    expect(await instance.claimBanner(regular.id)).toBeNull();
    enabled = false;
    expect(await instance.claimBanner(important.id)).toBeNull();
    enabled = true;
    const claims = await Promise.all([
      instance.claimBanner(important.id),
      instance.claimBanner(important.id),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    await instance.finishBanner(claims[0]!.token, false);
    const shown = await instance.claimBanner(important.id);
    expect(shown).not.toBeNull();
    await instance.finishBanner(shown!.token, true);
    expect(await instance.claimBanner(important.id)).toBeNull();
    const restarted = host().instance;
    expect(await restarted.claimBanner(important.id)).toBeNull();
    expect(await restarted.list()).toMatchObject({ unread: 3, reminder: expiring.id });
    now = Date.parse(remindUntil);
    expect(await restarted.claimBanner(expiring.id)).toBeNull();
    expect(await restarted.list()).toMatchObject({ unread: 3, reminder: null });
  });
});

it('公告横幅可单独关闭，并不占用系统通知的事件组开关', () => {
  const values = normalizeNotificationEvents({
    officialAnnouncement: { banner: false, system: true },
  });
  expect(values.officialAnnouncement).toEqual({ banner: false, system: false });
  expect(notificationGroupState(['officialAnnouncement', 'taskFailure'], 'system', values)).toEqual(
    { checked: true, mixed: false },
  );
});
