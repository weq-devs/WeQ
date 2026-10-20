import { mkdtempSync, rmSync } from 'node:fs';
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
