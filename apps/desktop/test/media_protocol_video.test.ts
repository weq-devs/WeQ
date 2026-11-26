// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { withNetworkTransport } from '@weq/network';
import { LARGE_TRANSFER_BYTES } from '@weq/service/data-saver';
import { transferActivity } from '@weq/service/managed-download';
import { handleMediaRequest } from '../src/main/media_protocol';

const state = vi.hoisted(() => ({
  root: '',
  source: null as string | null,
  localAttachment: null as string | null,
  sign: vi.fn(),
  signFile: vi.fn(),
}));
vi.mock('../src/main/context/app_context', () => {
  const makeServices = () => ({
    fileSearch: { findFile: async () => ({ source: state.source }) },
    msgs: {
      getRawElements: async () => ({
        kind: 'group',
        elements: [
          { kind: 'video', fileToken: 'synthetic-video' },
          { kind: 'file', fileName: 'other.mov', fileToken: 'other-file' },
          { kind: 'file', fileName: 'clip.MOV', fileToken: 'synthetic-file' },
        ],
      }),
    },
    fileResource: { resolveSentFile: async () => state.localAttachment },
    mediaUrl: { resolveVideoUrl: state.sign, resolveFileUrl: state.signFile },
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
const movUrl = 'weq-media://file?name=clip.MOV&token=synthetic-file&msgId=41&conv=123';
beforeEach(async () => {
  state.root = await mkdtemp(join(tmpdir(), 'weq-video-preview-'));
  state.source = null;
  state.localAttachment = null;
  state.sign.mockReset().mockResolvedValue('https://fixture.invalid/video.mp4');
  state.signFile.mockReset().mockResolvedValue('https://fixture.invalid/attachment');
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

it('MOV 附件核对消息中的文件身份，再透传 QQ 字节范围和原片内容', async () => {
  const mov = Buffer.from('0000ftypqt  0000synthetic-video-data');
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    expect(new Headers(init?.headers).get('range')).toBe('bytes=4-11');
    return new Response(mov.subarray(4, 12), {
      status: 206,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Range': `bytes 4-11/${mov.length}`,
        'Content-Length': '8',
        'Accept-Ranges': 'bytes',
      },
    });
  });
  await withNetworkTransport(fetcher, async () => {
    for (const invalid of [
      movUrl.replace('clip.MOV', 'clip.pdf'),
      movUrl.replace('clip.MOV', 'other.mov'),
      movUrl.replace('synthetic-file', 'unknown-file'),
    ]) {
      expect((await handleMediaRequest(new Request(invalid))).status).toBe(404);
    }
    const response = await handleMediaRequest(
      new Request(movUrl, { headers: { Range: 'bytes=4-11', 'x-weq-web': '1' } }),
    );
    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Type')).toBe('video/quicktime');
    expect(response.headers.get('Content-Range')).toBe(`bytes 4-11/${mov.length}`);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(mov.subarray(4, 12));
  });
  expect(fetcher).toHaveBeenCalledOnce();
  expect(state.signFile).toHaveBeenCalledOnce();
  expect(state.signFile).toHaveBeenCalledWith(
    'group',
    123,
    expect.objectContaining({ fileToken: 'synthetic-file' }),
    'clip.MOV',
  );
  expect(state.sign).not.toHaveBeenCalled();
});

it('MOV 附件优先从对应的本地文件分段播放', async () => {
  const path = join(state.root, 'cached-without-extension');
  await writeFile(path, 'fixture-mov');
  state.localAttachment = path;
  const response = await handleMediaRequest(
    new Request(movUrl, { headers: { Range: 'bytes=8-10' } }),
  );
  expect(response.status).toBe(206);
  expect(response.headers.get('Content-Type')).toBe('video/quicktime');
  expect(await response.text()).toBe('mov');
  expect(state.signFile).not.toHaveBeenCalled();
});
