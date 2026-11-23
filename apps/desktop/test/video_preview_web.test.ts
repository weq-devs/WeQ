// @vitest-environment node
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setNetworkTransport } from '@weq/network';
import { startServer } from '../src/main/web/http';

const state = vi.hoisted(() => ({ root: '' }));
vi.mock('../src/main/context/app_context', () => {
  const context = {
    bootstrap: {
      userConfig: { cacheDir: () => join(state.root, 'cache'), getSharedPreference: () => ({}) },
    },
    services: {
      fileSearch: { findFile: async () => ({ source: null }) },
      msgs: {
        getRawElements: async (id: bigint) => ({
          kind: 'group',
          elements: [{ kind: 'video', fileToken: id === 1n ? 'progressive.webm' : 'tail.mp4' }],
        }),
      },
      mediaUrl: {
        resolveVideoUrl: async (_kind: string, _group: number, element: { fileToken: string }) =>
          `https://fixture.invalid/${element.fileToken}`,
      },
    },
  };
  return { getAppContext: () => context };
});

let server: Awaited<ReturnType<typeof startServer>>['server'];
let base = '';
beforeEach(async () => {
  state.root = await mkdtemp(join(tmpdir(), 'weq-video-web-'));
  await writeFile(
    join(state.root, 'index.html'),
    '<!doctype html><title>Video stream</title><video muted controls style="width:640px;max-width:100%"></video>',
  );
  const started = await startServer({
    port: 0,
    host: '127.0.0.1',
    publicDir: state.root,
    auth: { isAuthed: () => true, login: async () => false, logout: () => {} },
    trpc: (_req, res) => res.end(),
  });
  server = started.server;
  base = `http://127.0.0.1:${started.port}`;
});
afterEach(async () => {
  setNetworkTransport();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(state.root, { recursive: true, force: true });
});

it('Web 在收到上游响应头之前断连，也取消宿主媒体请求', async () => {
  let upstream: AbortSignal | undefined;
  setNetworkTransport(async (_url, init) => {
    upstream = init?.signal ?? undefined;
    return new Promise(() => {});
  });
  const controller = new AbortController();
  const outcome = fetch(`${base}/_media/video?token=progressive.webm&msgId=1&conv=123`, {
    signal: controller.signal,
  }).catch((error: unknown) => error);
  await vi.waitFor(() => expect(upstream).toBeDefined());
  controller.abort();
  await expect(outcome).resolves.toMatchObject({ name: 'AbortError' });
  await vi.waitFor(() => expect(upstream?.aborted).toBe(true));
});

it.runIf(!!process.env.WEQ_PLAYWRIGHT_IMPORT)(
  '真实浏览器边收边播，并能播放 moov 在尾部的 MP4 与拖动进度',
  async () => {
    const run = promisify(execFile);
    for (const [name, codec] of [
      ['progressive.webm', 'libvpx'],
      ['tail.mp4', 'libx264'],
    ])
      await run('ffmpeg', [
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=320x180:rate=12',
        '-t',
        '12',
        '-c:v',
        codec!,
        '-pix_fmt',
        'yuv420p',
        '-g',
        '12',
        '-an',
        join(state.root, name!),
      ]);
    const mp4Path = join(state.root, 'tail.mp4');
    const mp4 = await readFile(mp4Path);
    const boxes: Array<{ kind: string; offset: number }> = [];
    for (let offset = 0; offset + 8 <= mp4.length; ) {
      const size = mp4.readUInt32BE(offset);
      expect(size).toBeGreaterThanOrEqual(8);
      boxes.push({ kind: mp4.toString('ascii', offset + 4, offset + 8), offset });
      offset += size;
    }
    const moov = boxes.find((box) => box.kind === 'moov')!;
    expect(moov.offset).toBeGreaterThan(boxes.find((box) => box.kind === 'mdat')!.offset);
    // 扩大合法 free box，让浏览器必须实际跳过中段并读取尾部索引。
    const free = Buffer.alloc(1024 * 1024);
    free.writeUInt32BE(free.length);
    free.write('free', 4);
    await writeFile(
      mp4Path,
      Buffer.concat([mp4.subarray(0, moov.offset), free, mp4.subarray(moov.offset)]),
    );
    let completed = false;
    const ranges: string[] = [];
    setNetworkTransport(async (input, init) => {
      const name = new URL(String(input)).pathname.slice(1);
      const bytes = await readFile(join(state.root, name));
      const range = new Headers(init?.headers).get('range');
      if (range) ranges.push(range);
      const match = /^bytes=(\d+)-(\d*)$/.exec(range ?? '');
      const start = match ? Number(match[1]) : 0;
      const end = match?.[2] ? Math.min(Number(match[2]), bytes.length - 1) : bytes.length - 1;
      const headers = new Headers({
        'Content-Type': name.endsWith('mp4') ? 'video/mp4' : 'video/webm',
        'Content-Length': String(end - start + 1),
        'Accept-Ranges': 'bytes',
      });
      if (match) headers.set('Content-Range', `bytes ${start}-${end}/${bytes.length}`);
      let offset = start;
      return new Response(
        new ReadableStream(
          {
            async pull(stream) {
              if (offset > end) {
                if (name === 'progressive.webm') completed = true;
                stream.close();
                return;
              }
              await new Promise((resolve) =>
                setTimeout(resolve, name === 'progressive.webm' ? 100 : 5),
              );
              if (init?.signal?.aborted) {
                stream.error(init.signal.reason);
                return;
              }
              const next = Math.min(end + 1, offset + 2048);
              stream.enqueue(bytes.subarray(offset, next));
              offset = next;
            },
          },
          { highWaterMark: 0 },
        ),
        { status: match ? 206 : 200, headers },
      );
    });
    await mkdir(join(state.root, 'cache'), { recursive: true });
    const { stdout } = await run(
      process.execPath,
      [join(__dirname, 'browser/run-video-preview-streaming.mjs'), base],
      { env: process.env, timeout: 45_000 },
    );
    expect(JSON.parse(stdout)).toMatchObject({ played: true, sought: true, width: 320 });
    expect(completed).toBe(false);
    expect(ranges.length).toBeGreaterThan(0);
    expect(ranges.some((range) => /^bytes=[1-9]/.test(range))).toBe(true);
  },
  60_000,
);
