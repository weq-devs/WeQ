// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { withNetworkTransport } from '@weq/network';
import { LARGE_TRANSFER_BYTES } from '@weq/service/data-saver';
import { transferActivity } from '@weq/service/managed-download';
import { handleMediaRequest } from '../src/main/media_protocol';

const state = vi.hoisted(() => ({ root: '', source: null as string | null, sign: vi.fn() }));
vi.mock('../src/main/context/app_context', () => {
  const makeServices = () => ({
    fileSearch: { findFile: async () => ({ source: state.source }) },
    msgs: {
      getRawElements: async () => ({
        kind: 'group',
        elements: [{ kind: 'video', fileToken: 'synthetic-video' }],
      }),
    },
    mediaUrl: { resolveVideoUrl: state.sign },
  });
  let root = '';
  let services = makeServices();
  return {
    getAppContext: () => {
      if (root !== state.root) {
        root = state.root;
        services = makeServices();
      }
      return {
        bootstrap: {
          userConfig: { cacheDir: () => state.root, getSharedPreference: () => ({}) },
        },
        services,
      };
    },
  };
});

const bytes = Buffer.alloc(LARGE_TRANSFER_BYTES);
bytes.write('ftyp', 4);
bytes.write('isom', 8);
const activity = vi.fn();
const url = 'weq-media://video?t=1&name=video.mp4&token=synthetic-video&msgId=41&conv=123';
beforeEach(async () => {
  state.root = await mkdtemp(join(tmpdir(), 'weq-video-preview-'));
  state.source = null;
  state.sign.mockReset().mockResolvedValue('https://fixture.invalid/video.mp4');
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

it('同一播放来源连续寻址只签一次，缓存签名被拒时重新签发', async () => {
  state.sign.mockResolvedValueOnce('https://fixture.invalid/expired.mp4');
  const fetcher = vi.fn<typeof fetch>(async (source, init) => {
    const range = new Headers(init?.headers).get('range');
    if (source.toString().endsWith('/expired.mp4') && range === 'bytes=8-15')
      return new Response('expired', { status: 403 });
    const start = range === 'bytes=8-15' ? 8 : 0;
    return new Response(bytes.subarray(start, start + 8), {
      status: 206,
      headers: {
        'Content-Range': `bytes ${start}-${start + 7}/${bytes.length}`,
        'Content-Length': '8',
        'Content-Type': 'video/mp4',
        ETag: '"fixture"',
      },
    });
  });
  await withNetworkTransport(fetcher, async () => {
    for (const range of ['bytes=0-7', 'bytes=0-7', 'bytes=8-15']) {
      const out = await handleMediaRequest(new Request(url, { headers: { Range: range } }));
      expect(out.status).toBe(206);
      expect((await out.arrayBuffer()).byteLength).toBe(8);
    }
  });
  expect(state.sign).toHaveBeenCalledTimes(2);
  expect(fetcher).toHaveBeenCalledTimes(3);
});
