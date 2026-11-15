// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { makeSolidPng } from '@weq/protocol';
import { MediaCacheService } from '@weq/service';
import { UNKNOWN_NETWORK } from '@weq/service/data-saver';
import { updateTransferPolicy } from '@weq/service/transfer-policy';
import { handleMediaRequest } from '../src/main/media_protocol';

const state = vi.hoisted(() => ({ cache: null as MediaCacheService | null }));
vi.mock('../src/main/context/app_context', () => ({
  getAppContext: () => ({ bootstrap: { avatarCache: state.cache } }),
}));
const image = Buffer.from(makeSolidPng(8, 4, [42, 150, 96]));
const luckyChar = 'https://tianquan.gtimg.cn/groupluckyword/item/10001/pic-3.png';
const dress = 'https://tianquan.gtimg.cn/pendant/item/10001/aio_50.png';
const upstream = vi.fn();
let root = '';

function request(src: string, clientRestricted = false, web = false) {
  const query = new URLSearchParams({ src });
  if (clientRestricted) query.set('ds', '1');
  if (web) query.set('cid', 'fixture-client');
  return new Request(`weq-media://dress?${query}`, {
    headers: web ? { 'x-weq-web': '1' } : {},
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'weq-group-lucky-char-'));
  state.cache = new MediaCacheService({
    cacheDir: (subdir: string) => {
      const path = join(root, subdir);
      mkdirSync(path, { recursive: true });
      return path;
    },
  });
  upstream
    .mockReset()
    .mockImplementation(
      async () => new Response(new Uint8Array(image), { headers: { 'Content-Type': 'image/png' } }),
    );
  vi.stubGlobal('fetch', upstream);
  updateTransferPolicy('auto', UNKNOWN_NETWORK, {
    dataSaverAvatars: false,
    dataSaverDress: false,
    dataSaverPrefetch: false,
    dataSaverImageLoading: 'none',
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  updateTransferPolicy('auto', UNKNOWN_NETWORK);
  state.cache = null;
  rmSync(root, { recursive: true, force: true });
});

it.each([
  { mode: 'always' as const, clientRestricted: false, web: false },
  { mode: 'always' as const, clientRestricted: false, web: true },
  { mode: 'auto' as const, clientRestricted: true, web: true },
])('省流量下幸运字符正常下载并复用缓存：$mode/$web/$clientRestricted', async (scenario) => {
  updateTransferPolicy(scenario.mode, UNKNOWN_NETWORK, {
    dataSaverAvatars: false,
    dataSaverDress: false,
    dataSaverPrefetch: false,
    dataSaverImageLoading: 'none',
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await handleMediaRequest(
      request(luckyChar, scenario.clientRestricted, scenario.web),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(image);
  }
  expect(upstream).toHaveBeenCalledOnce();
  expect(upstream.mock.calls[0]?.[0]).toBe(luckyChar);
});

it('字符和点亮人数变化后按新地址取图', async () => {
  for (const src of [
    luckyChar,
    luckyChar.replace('pic-3', 'pic-0'),
    luckyChar.replace('pic-3', 'pic-4'),
    luckyChar.replace('10001', '10002'),
  ]) {
    const response = await handleMediaRequest(request(src, true, true));
    expect(response.status).toBe(200);
    await response.arrayBuffer();
  }
  expect(upstream).toHaveBeenCalledTimes(4);
});

it('其他未缓存装扮仍暂缓自动下载，已有缓存照常使用', async () => {
  expect((await handleMediaRequest(request(dress, true))).status).toBe(404);
  expect(upstream).not.toHaveBeenCalled();
  await state.cache!.get(dress, 'dress');
  const cached = await handleMediaRequest(request(dress, true));
  expect(cached.status).toBe(200);
  expect(Buffer.from(await cached.arrayBuffer())).toEqual(image);
  expect(upstream).toHaveBeenCalledOnce();
});

it.each([
  'https://example.invalid/groupluckyword/item/10001/pic-3.png',
  'http://tianquan.gtimg.cn/groupluckyword/item/10001/pic-3.png',
  'https://tianquan.gtimg.cn/groupluckyword/item/10001/other.png',
  'https://tianquan.gtimg.cn/groupluckyword/item/10001/pic-3.png/other.png',
])('不把其他主机、协议或素材路径当幸运字符放行：%s', async (src) => {
  expect((await handleMediaRequest(request(src, true))).status).toBe(404);
  expect(upstream).not.toHaveBeenCalled();
});
