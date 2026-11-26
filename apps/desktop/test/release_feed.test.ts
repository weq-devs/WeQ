// @vitest-environment node
import { generateKeyPairSync, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import {
  RESOURCE_FEED_TAG,
  signReleaseIndex,
  type ReleaseIndex,
} from '@weq/network/release-metadata';
import { clearSourceHealth } from '@weq/network';
import { ReleaseFeed } from '../src/main/update/release_feed';
import { selectUpdateRelease } from '../src/main/update/releases';

const roots: string[] = [];
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const keys = [publicKey.export({ type: 'spki', format: 'pem' }).toString()];
afterEach(async () => {
  vi.restoreAllMocks();
  clearSourceHealth();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
function index(version = '2.7.2'): ReleaseIndex {
  return {
    schemaVersion: 1,
    kind: 'release-index',
    repository: 'weq-devs/WeQ',
    generatedAt: '2026-11-16T00:00:00Z',
    releases: [
      {
        tag: `v${version}`,
        version,
        prerelease: false,
        publishedAt: '2026-11-16T00:00:00Z',
        catalogs: {},
        assets: [
          {
            name: 'latest-mac.yml',
            size: 1,
            sha256: createHash('sha256').update('x').digest('hex'),
          },
          {
            name: `weQ-${version}-mac-arm64.zip`,
            size: 4,
            sha256: createHash('sha256').update('data').digest('hex'),
          },
        ],
      },
    ],
  };
}
it('GitHub API 不可达仍可通过镜像选择更新及取得目标版本的摘要和安装哈希', async () => {
  const feed = new ReleaseFeed('weq-devs/WeQ', undefined, keys);
  const next = index();
  next.releases[0]!.summary = '增设重要消息索引。';
  const fetcher = vi.fn<typeof fetch>(async (url) =>
    String(url).startsWith('https://github.com/')
      ? new Response('', { status: 503 })
      : Response.json(signReleaseIndex(next, privatePem)),
  );
  const result = await feed.read(true, undefined, fetcher);
  const release = feed.latest(false, result!);
  expect(
    selectUpdateRelease(
      [
        {
          tag_name: release!.tag,
          prerelease: false,
          draft: false,
          published_at: release!.publishedAt,
          assets: release!.assets,
        },
      ],
      false,
      'latest-mac.yml',
    ).version,
  ).toBe('2.7.2');
  expect(feed.summary('2.7.2')).toBe('增设重要消息索引。');
  expect(feed.summary('2.7.1')).toBeUndefined();
  expect(await feed.archive('2.7.2', 'weQ-2.7.2-mac-arm64.zip')).toMatchObject({ size: 4 });
  expect(fetcher.mock.calls.every(([url]) => !String(url).includes('api.github.com'))).toBe(true);
});
const resourceRepository = 'weq-devs/dress-resources';
function resourceIndex(tag: string, publishedAt: string): ReleaseIndex {
  const descriptor = 'enhancement-dress-v2.json';
  const catalog = '{}';
  return {
    schemaVersion: 1,
    kind: 'resource-release-index',
    repository: resourceRepository,
    generatedAt: publishedAt,
    releases: [
      {
        tag,
        track: 'dress',
        version: null,
        prerelease: false,
        publishedAt,
        catalogs: { [descriptor]: catalog },
        assets: [
          {
            name: descriptor,
            size: Buffer.byteLength(catalog),
            sha256: createHash('sha256').update(catalog).digest('hex'),
          },
        ],
      },
    ],
  };
}
it('重新检查统一资源索引时能绕过固定下载地址的缓存', async () => {
  const feed = new ReleaseFeed(resourceRepository, undefined, keys, RESOURCE_FEED_TAG);
  const old = 'dress-index-old';
  const next = 'dress-index-new';
  let published = resourceIndex(old, '2026-11-24T00:00:00Z');
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(published.generatedAt));
  const cached = new Map<string, ReturnType<typeof signReleaseIndex>>();
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (!cached.has(url)) cached.set(url, signReleaseIndex(published, privatePem));
    return Response.json(cached.get(url));
  };
  expect((await feed.read(true, undefined, fetcher))?.releases[0]?.tag).toBe(old);

  published = resourceIndex(next, '2026-11-25T00:00:00Z');
  clock.mockReturnValue(Date.parse(published.generatedAt));
  expect((await feed.read(true, undefined, fetcher))?.releases[0]?.tag).toBe(next);
});
it('带刷新参数的统一索引不可用时可从原镜像地址验签读取', async () => {
  const feed = new ReleaseFeed(resourceRepository, undefined, keys, RESOURCE_FEED_TAG);
  const tag = 'dress-index-new';
  const envelope = signReleaseIndex(resourceIndex(tag, '2026-11-25T00:00:00Z'), privatePem);
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === 'github.com') return new Response(null, { status: 404 });
    if (url.search) return new Response(null, { status: 403 });
    return Response.json(envelope);
  };
  expect((await feed.read(true, undefined, fetcher))?.releases[0]?.tag).toBe(tag);
});
it('磁盘缓存重新验签；离线检查不冒称新鲜，但明确版本可以继续核验', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weq-release-feed-'));
  roots.push(root);
  const feed = new ReleaseFeed('weq-devs/WeQ', root, keys);
  await feed.read(true, undefined, async () =>
    Response.json(signReleaseIndex(index(), privatePem)),
  );
  const restored = new ReleaseFeed('weq-devs/WeQ', root, keys);
  const [, archive] = await Promise.all([
    restored.load(),
    restored.archive('2.7.2', 'weQ-2.7.2-mac-arm64.zip'),
  ]);
  expect(archive).toMatchObject({ size: 4 });
  expect(
    await restored.read(true, undefined, async () => new Response('', { status: 404 })),
  ).toBeNull();
  expect(await restored.archive('2.7.2', 'weQ-2.7.2-mac-arm64.zip')).toMatchObject({ size: 4 });
});
it('拒绝无效签名和倒退版本，不以缓存伪装成功检查', async () => {
  const feed = new ReleaseFeed('weq-devs/WeQ', undefined, keys);
  await feed.read(true, undefined, async () =>
    Response.json(signReleaseIndex(index(), privatePem)),
  );
  await expect(
    feed.read(true, undefined, async () =>
      Response.json(signReleaseIndex(index('2.7.1'), privatePem)),
    ),
  ).rejects.toThrow('倒退');
  const bad = {
    ...signReleaseIndex(index(), privatePem),
    signature: Buffer.alloc(64).toString('base64'),
  };
  expect(
    await new ReleaseFeed('weq-devs/WeQ', undefined, keys).read(true, undefined, async () =>
      Response.json(bad),
    ),
  ).toBeNull();
});
