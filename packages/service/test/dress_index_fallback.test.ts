import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NtHelperBinding } from '@weq/native';
import type { TrpcNative } from '@weq/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DressSharedCache } from '../src/account/dress_shared_cache';
import {
  configureDressIndexResources,
  subscribeDressIndexResources,
} from '../src/account/dress_index';

const protocol = vi.hoisted(() => ({ bubble: vi.fn(async () => ({ staticZip: { ok: false } })) }));
vi.mock('@weq/protocol', () => ({
  getBubbleResources: protocol.bubble,
  getFontResource: vi.fn(),
  getPendantResources: vi.fn(),
}));
const directories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  protocol.bubble.mockClear();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture(pid: number | (() => number) = 42) {
  const root = await mkdtemp(join(tmpdir(), 'weq-dress-fallback-'));
  directories.push(root);
  const bytes = Buffer.concat([Buffer.from('NTDR\x01'), Buffer.alloc(32, 7)]);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  configureDressIndexResources({
    manifest: {
      schemaVersion: 1,
      tag: 'dress-fallback',
      nativeCommit: '1'.repeat(40),
      format: 'ntdr-v1',
      baseUrl: 'https://example.invalid/dress-fallback',
      parts: Object.fromEntries(
        ['bubble', 'font', 'widget'].map((kind) => [
          kind,
          {
            asset: `dress-${kind}.dat`,
            sha256,
            size: bytes.length,
          },
        ]),
      ),
    },
  });
  const native = {
    getBuildInfo: () => ({ isDev: false }),
    queryDressResourceUrl: () => null,
  } as unknown as NtHelperBinding;
  const cache = new DressSharedCache({} as TrpcNative, native, root, () =>
    typeof pid === 'function' ? pid() : pid,
  );
  return { root, cache, native, bytes };
}

describe('索引与装扮素材缓存分开处理', () => {
  it('已经缓存的气泡立即返回，不触发索引下载或在线换链', async () => {
    const { root, cache } = await fixture();
    await mkdir(join(root, 'bubbles'), { recursive: true });
    await writeFile(join(root, 'bubbles', '7.png'), Buffer.from('cached asset'));
    await writeFile(
      join(root, 'bubbles', '7.json'),
      JSON.stringify({
        slice: { top: 1, right: 1, bottom: 1, left: 1 },
        imageSize: { w: 10, h: 10 },
        textColor: '#000',
      }),
    );
    const fetch = vi.fn(async () => {
      throw new Error('不应联网');
    });
    vi.stubGlobal('fetch', fetch);
    expect(await cache.installBubble(7)).toMatchObject({ itemId: 7 });
    expect(fetch).not.toHaveBeenCalled();
    expect(protocol.bubble).not.toHaveBeenCalled();
  });

  it('索引下载失败后仍使用现有QQ协议补全，不把静态分发变成在线功能前置', async () => {
    const { cache } = await fixture();
    const fetch = vi.fn(async () => new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetch);
    expect(await cache.installBubble(8)).toBeNull();
    expect(protocol.bubble).toHaveBeenCalledWith(expect.anything(), 42, 8);
    await vi.waitFor(() => expect(cache.indexResources()[0]?.status).toBe('failed'));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('GitHub 请求挂起时，在线QQ协议立即补全，不等待索引下载', async () => {
    const { cache, bytes } = await fixture();
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const fetch = vi.fn(() => pending);
    vi.stubGlobal('fetch', fetch);
    try {
      const completed = cache.installBubble(10);
      expect(
        await Promise.race([
          completed.then(() => 'protocol-finished'),
          new Promise((resolve) => setTimeout(() => resolve('blocked'), 100)),
        ]),
      ).toBe('protocol-finished');
      expect(protocol.bubble).toHaveBeenCalledWith(expect.anything(), 42, 10);
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      expect(cache.indexResources()[0]?.status).toBe('downloading');
    } finally {
      finish(new Response(bytes));
      await vi.waitFor(() => expect(cache.indexResources()[0]?.status).toBe('ready'));
    }
  });

  it('在线协议先失败后，索引下载完成仍通知刷新，并能立即改用新索引', async () => {
    const { cache, native, bytes, root } = await fixture();
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const config = Buffer.from('{"fixture":"config"}');
    const fetch = vi.fn((url: string) =>
      url.endsWith('.dat') ? pending : Promise.resolve(new Response(config)),
    );
    vi.stubGlobal('fetch', fetch);
    native.queryDressResourceUrl = (_kind, _item, part) =>
      part === 'config.json' &&
      process.env.NT_HELPER_DRESS_DIR === join(root, 'index', 'dress-fallback') &&
      existsSync(join(process.env.NT_HELPER_DRESS_DIR, 'bubble.dat'))
        ? { url: 'https://cdn.invalid/config.json', size: config.length }
        : null;
    const ready = vi.fn();
    const unsubscribe = subscribeDressIndexResources(({ state }) => {
      if (state.status === 'ready') ready();
    });
    try {
      expect(
        await Promise.race([
          cache.bubbleConfigFile(11).then((value) => ({ value })),
          new Promise((resolve) => setTimeout(() => resolve('blocked'), 100)),
        ]),
      ).toEqual({ value: null });
      expect(protocol.bubble).toHaveBeenCalledWith(expect.anything(), 42, 11);
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      finish(new Response(bytes));
      await vi.waitFor(() => expect(ready).toHaveBeenCalledTimes(1));
      expect(cache.indexRevision()).toBeGreaterThan(0);
      expect(await cache.bubbleConfigFile(11)).toEqual(config);
      expect(protocol.bubble).toHaveBeenCalledTimes(1);
    } finally {
      finish(new Response(bytes));
      await vi.waitFor(() => expect(cache.indexResources()[0]?.status).toBe('ready'));
      unsubscribe();
    }
  });

  it('没有在线QQ时等待索引完成换链，不提前返回失败或调用协议', async () => {
    const { cache, native, bytes, root } = await fixture(() => {
      throw new Error('QQ account is not online.');
    });
    let finish!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const config = Buffer.from('{"fixture":"offline-index"}');
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        url.endsWith('.dat') ? pending : Promise.resolve(new Response(config)),
      ),
    );
    native.queryDressResourceUrl = (_kind, _item, part) =>
      part === 'config.json' &&
      process.env.NT_HELPER_DRESS_DIR === join(root, 'index', 'dress-fallback') &&
      existsSync(join(process.env.NT_HELPER_DRESS_DIR, 'bubble.dat'))
        ? { url: 'https://cdn.invalid/config.json', size: config.length }
        : null;
    const work = cache.bubbleConfigFile(12);
    let completed = false;
    void work.then(() => {
      completed = true;
    });
    try {
      await vi.waitFor(() => expect(cache.indexResources()[0]?.status).toBe('downloading'));
      expect(completed).toBe(false);
      expect(protocol.bubble).not.toHaveBeenCalled();
    } finally {
      finish(new Response(bytes));
      expect(await work).toEqual(config);
      expect(protocol.bubble).not.toHaveBeenCalled();
    }
  });
});
