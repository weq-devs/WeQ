import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { handleMediaRequest } from '../src/main/media_protocol';
const state = vi.hoisted(() => ({ services: {} as object, root: '' }));
vi.mock('../src/main/context/app_context', () => ({
  getAppContext: () => ({
    services: state.services,
    bootstrap: { userConfig: { cacheDir: () => state.root } },
  }),
  requirePlatform: () => ({}),
}));
vi.mock('@weq/service', async (original) => ({
  ...(await original<typeof import('@weq/service')>()),
  downloadUrlToFile: async () => ({ ok: false, reason: 'synthetic' }),
}));
afterEach(() => {
  if (state.root) rmSync(state.root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
it('保存读取缓存期间切换来源，后续元素查找不能进入新来源', async () => {
  state.root = mkdtempSync(join(tmpdir(), 'weq-protocol-binding-'));
  const lookup = vi.fn(async () => ({
    kind: 'group',
    elements: [{ kind: 'video', fileToken: 'other-source-token' }],
  }));
  const newer = { msgs: { getRawElements: lookup } };
  const resolve = vi.fn(async () => 'https://synthetic.invalid/video');
  const original = {
    fileSearch: {
      findFile: async () => {
        state.services = newer;
        return { source: null, thumb: null };
      },
    },
    mediaUrl: { resolveVideoUrl: resolve },
  };
  state.services = original;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const response = await handleMediaRequest(
    new Request('weq-media://video?t=1&name=video.mp4&token=old-token&msgId=41&conv=123'),
    () => {
      if (state.services !== original) throw new Error('来源已切换');
    },
  );
  expect(response.ok).toBe(false);
  expect(lookup).not.toHaveBeenCalled();
  expect(resolve).not.toHaveBeenCalled();
});

it('图片协议将旧消息 MD5 交给文件查找，缩略图和原图分别返回', async () => {
  state.root = mkdtempSync(join(tmpdir(), 'weq-protocol-pic-'));
  const source = join(state.root, 'source.png');
  const thumb = join(state.root, 'thumb.jpg');
  writeFileSync(source, 'synthetic original');
  writeFileSync(thumb, 'synthetic thumbnail');
  const findFile = vi.fn(async () => ({ source, thumb }));
  state.services = { fileSearch: { findFile } };
  const md5 = '1234567890abcdef1234567890abcdef';
  const url = `weq-media://pic?t=1692144000000&name=&md5=${md5}&lookup=2`;
  expect(await (await handleMediaRequest(new Request(`${url}&v=thumb`))).text()).toBe(
    'synthetic thumbnail',
  );
  expect(await (await handleMediaRequest(new Request(url))).text()).toBe('synthetic original');
  expect(findFile.mock.calls).toEqual([
    [1692144000000, '', 'pic', md5],
    [1692144000000, '', 'pic', md5],
  ]);
});
