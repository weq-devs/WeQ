// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { withNetworkTransport } from '@weq/network';
import { LARGE_TRANSFER_BYTES } from '@weq/service/data-saver';
import { transferActivity } from '@weq/service/managed-download';
import { handleMediaRequest } from '../src/main/media_protocol';

const state = vi.hoisted(() => ({ root: '', source: null as string | null }));
vi.mock('../src/main/context/app_context', () => ({
  getAppContext: () => ({
    bootstrap: {
      userConfig: { cacheDir: () => state.root, getSharedPreference: () => ({}) },
    },
    services: {
      fileSearch: { findFile: async () => ({ source: state.source }) },
      msgs: {
        getRawElements: async () => ({
          kind: 'group',
          elements: [{ kind: 'video', fileToken: 'synthetic-video' }],
        }),
      },
      mediaUrl: { resolveVideoUrl: async () => 'https://fixture.invalid/video.mp4' },
    },
  }),
}));

const bytes = Buffer.alloc(LARGE_TRANSFER_BYTES);
const activity = vi.fn();
const url = 'weq-media://video?t=1&name=video.mp4&token=synthetic-video&msgId=41&conv=123';
beforeEach(async () => {
  state.root = await mkdtemp(join(tmpdir(), 'weq-video-preview-'));
  state.source = null;
  activity.mockClear();
  transferActivity.on('state', activity);
});
afterEach(async () => {
  transferActivity.off('state', activity);
  await rm(state.root, { recursive: true, force: true });
});

it('未缓存视频的预览补全不登记下载任务，重播仍复用完整缓存', async () => {
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response(bytes, {
        headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(bytes.length) },
      }),
  );
  await withNetworkTransport(fetcher, async () => {
    const response = await handleMediaRequest(new Request(url));
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true);
    const replay = await handleMediaRequest(new Request(url, { headers: { Range: 'bytes=5-9' } }));
    expect(replay.status).toBe(206);
    expect(Buffer.from(await replay.arrayBuffer())).toEqual(bytes.subarray(5, 10));
  });
  expect(fetcher).toHaveBeenCalledOnce();
  expect(activity).not.toHaveBeenCalled();
});

it('Web／Remote 传送已缓存视频也不登记下载任务', async () => {
  state.source = join(state.root, 'video.mp4');
  await writeFile(state.source, bytes);
  const response = await handleMediaRequest(new Request(url, { headers: { 'x-weq-web': '1' } }));
  expect(response.status).toBe(200);
  expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true);
  expect(activity).not.toHaveBeenCalled();
});
