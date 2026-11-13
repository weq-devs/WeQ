// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { afterEach, expect, it, vi } from 'vitest';
import { handleMediaRequest } from '../src/main/media_protocol';
import { setupImageWorker } from './support/image-worker';
import { updateTransferPolicy } from '@weq/service/transfer-policy';
import { UNKNOWN_NETWORK } from '@weq/service/data-saver';
setupImageWorker();
const state = vi.hoisted(() => ({
  source: null as string | null,
  thumb: null as string | null,
  download: vi.fn(async () => null as string | null),
}));
vi.mock('../src/main/context/app_context', () => ({
  getAppContext: () => ({
    services: {
      fileSearch: { findFile: async () => ({ source: state.source, thumb: state.thumb }) },
      mediaDownload: { download: state.download, cachedFile: () => null },
    },
    bootstrap: {
      userConfig: {
        getSharedPreference: () => ({ dataSaverMode: 'auto' }),
        getSettings: () => ({}),
      },
    },
  }),
}));
const roots: string[] = [];
afterEach(async () => {
  updateTransferPolicy('auto', UNKNOWN_NETWORK);
  state.source = state.thumb = null;
  state.download.mockClear();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it('不自动加载仅允许现有缓存，携带小图地址也不发起下载', async () => {
  updateTransferPolicy('always', UNKNOWN_NETWORK, { dataSaverImageLoading: 'none' });
  const response = await handleMediaRequest(
    new Request(
      'weq-media://pic?t=1&name=x&token=token&small=https%3A%2F%2Fgchat.qpic.cn%2Fsmall&ds=1',
    ),
  );
  expect(response.status).toBe(409);
  expect(state.download).not.toHaveBeenCalled();
});
it('选择自动原图时使用完整在线下载链路，不再强制仅小图', async () => {
  updateTransferPolicy('always', UNKNOWN_NETWORK, { dataSaverImageLoading: 'original' });
  await handleMediaRequest(new Request('weq-media://pic?t=1&name=x&token=token&ds=1'));
  expect(state.download).toHaveBeenCalledOnce();
});
it('表情自动下载开关独立于普通图片档位', async () => {
  updateTransferPolicy('always', UNKNOWN_NETWORK, {
    dataSaverImageLoading: 'original',
    dataSaverEmoji: false,
  });
  const response = await handleMediaRequest(
    new Request('weq-media://pic?t=1&name=x&token=token&recv=1&ds=1'),
  );
  expect(response.status).toBe(409);
  expect(state.download).not.toHaveBeenCalled();
  updateTransferPolicy('always', UNKNOWN_NETWORK, {
    dataSaverImageLoading: 'none',
    dataSaverEmoji: true,
  });
  await handleMediaRequest(new Request('weq-media://pic?t=1&name=x&token=token&recv=1&ds=1'));
  expect(state.download).toHaveBeenCalledOnce();
});
it('省流量缩图缺失不偷偷下载原图，显式点击仍使用现有下载服务', async () => {
  const automatic = await handleMediaRequest(
    new Request('weq-media://pic?t=1&name=x&token=token&v=thumb&ds=1'),
  );
  expect(automatic.status).toBe(409);
  expect(automatic.headers.get('X-WeQ-Media-State')).toBe('deferred');
  expect(state.download).not.toHaveBeenCalled();
  await handleMediaRequest(
    new Request('weq-media://pic?t=1&name=x&token=token&intent=interactive&ds=1'),
  );
  expect(state.download).toHaveBeenCalledOnce();
});
it('宿主已有原图时自动响应真实小图，原图点击才传原始内容', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weq-data-saver-media-'));
  roots.push(root);
  state.source = join(root, 'original.png');
  const original = await sharp({
    create: { width: 2000, height: 1000, channels: 3, background: '#bb4455' },
  })
    .png()
    .toBuffer();
  await writeFile(state.source, original);
  const automatic = await handleMediaRequest(
    new Request('weq-media://pic?t=1&name=x&v=thumb&ds=1'),
  );
  const small = Buffer.from(await automatic.arrayBuffer());
  expect(automatic.status).toBe(200);
  expect(small.length).toBeLessThan(original.length);
  expect((await sharp(small).metadata()).width).toBeLessThan(2000);
  const interactive = await handleMediaRequest(
    new Request('weq-media://pic?t=1&name=x&intent=interactive&ds=1'),
  );
  expect(Buffer.from(await interactive.arrayBuffer())).toEqual(original);
  expect(state.download).not.toHaveBeenCalled();
});
