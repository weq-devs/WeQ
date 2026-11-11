// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { chatpicRelPaths } from '@weq/service';
import { handleMediaRequest } from '../src/main/media_protocol';
import { setupImageWorker } from './support/image-worker';

setupImageWorker();
const state = vi.hoisted(() => ({ services: {} as object, root: '', chatpicRoot: '' }));
vi.mock('../src/main/context/app_context', () => ({
  getAppContext: () => ({
    services: state.services,
    bootstrap: {
      userConfig: {
        cacheDir: () => state.root,
        getSettings: () => ({ externalChatpic: { enabled: true, dir: state.chatpicRoot } }),
      },
    },
  }),
  requirePlatform: () => ({}),
}));
vi.mock('@weq/service', async (original) => ({
  ...(await original<typeof import('@weq/service')>()),
  downloadUrlToFile: async () => ({ ok: false, reason: 'synthetic' }),
}));
afterEach(() => {
  if (state.root) rmSync(state.root, { recursive: true, force: true });
  state.chatpicRoot = '';
  if (vi.isMockFunction(console.error)) console.error.mockRestore();
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
  // 使用真实的合成 JPEG；缩略图安全策略不再把无法解码的文本原样返回。
  writeFileSync(
    thumb,
    await sharp({ create: { width: 40, height: 20, channels: 3, background: '#336699' } })
      .jpeg()
      .toBuffer(),
  );
  const findFile = vi.fn(async () => ({ source, thumb }));
  state.services = { fileSearch: { findFile } };
  const md5 = '1234567890abcdef1234567890abcdef';
  const url = `weq-media://pic?t=1692144000000&name=&md5=${md5}&lookup=2`;
  const thumbResponse = await handleMediaRequest(new Request(`${url}&v=thumb`));
  expect(thumbResponse.headers.get('content-type')).toBe('image/webp');
  const thumbnail = await sharp(Buffer.from(await thumbResponse.arrayBuffer())).metadata();
  expect(thumbnail).toMatchObject({ format: 'webp', width: 40, height: 20 });
  expect(await (await handleMediaRequest(new Request(url))).text()).toBe('synthetic original');
  expect(findFile.mock.calls).toEqual([
    [1692144000000, '', 'pic', md5],
    [1692144000000, '', 'pic', md5],
  ]);
});

it('添加表情的原图请求不上传普通缩略图，但保留接收表情原始字节', async () => {
  state.root = mkdtempSync(join(tmpdir(), 'weq-protocol-emoji-'));
  const thumb = join(state.root, 'received.gif');
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  writeFileSync(thumb, gif);
  const download = vi.fn(async () => null);
  state.services = {
    fileSearch: { findFile: async () => ({ source: null, thumb }) },
    mediaDownload: { download },
  };
  const url = 'weq-media://pic?t=1&name=received.gif&token=token&v=original';
  expect((await handleMediaRequest(new Request(url))).status).toBe(404);
  expect(download).toHaveBeenCalledWith('token', { originalUrl: '' });
  const response = await handleMediaRequest(new Request(`${url}&recv=1`));
  expect(Buffer.from(await response.arrayBuffer())).toEqual(gif);
  expect(download).toHaveBeenCalledOnce();
});

it('严格原图请求不从安卓备份的 chatimg/chatthumb 降级，仍可使用 chatraw', async () => {
  state.root = state.chatpicRoot = mkdtempSync(join(tmpdir(), 'weq-protocol-chatraw-'));
  const md5 = '1234567890abcdef1234567890abcdef';
  const paths = chatpicRelPaths(md5);
  for (const kind of ['chatimg', 'chatthumb'] as const) {
    const path = join(state.root, paths[kind]);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'synthetic preview');
  }
  state.services = {
    fileSearch: { findFile: async () => ({ source: null, thumb: null }) },
    mediaDownload: { download: async () => null },
  };
  const url = `weq-media://pic?md5=${md5}&v=original`;
  expect((await handleMediaRequest(new Request(url))).status).toBe(404);
  const raw = join(state.root, paths.chatraw);
  mkdirSync(dirname(raw), { recursive: true });
  writeFileSync(raw, 'synthetic original');
  expect(await (await handleMediaRequest(new Request(url))).text()).toBe('synthetic original');
});
