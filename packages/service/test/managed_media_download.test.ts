import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { managedMediaDownload } from '../src/account/managed_media_download';
import { LARGE_TRANSFER_BYTES } from '../src/common/data_saver';
import { transferActivity, type TransferActivity } from '../src/common/managed_download';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it.each([true, false])(
  '媒体传输可独立控制任务登记（reportActivity=%s）',
  async (reportActivity) => {
    const root = await mkdtemp(join(tmpdir(), 'weq-managed-media-'));
    roots.push(root);
    const path = join(root, 'video.mp4');
    const bytes = Buffer.alloc(LARGE_TRANSFER_BYTES);
    const activity = vi.fn();
    transferActivity.on('state', activity);
    try {
      const result = await managedMediaDownload('https://fixture.invalid/video', path, {
        ...(reportActivity ? {} : { reportActivity: false }),
        fetcher: async () =>
          new Response(bytes, {
            headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(bytes.length) },
          }),
      });
      expect(result).toMatchObject({ ok: true, bytes: bytes.length });
      expect((await readFile(path)).equals(bytes)).toBe(true);
      if (reportActivity)
        expect(activity).toHaveBeenLastCalledWith(expect.objectContaining({ done: true }));
      else expect(activity).not.toHaveBeenCalled();
    } finally {
      transferActivity.off('state', activity);
    }
  },
);

it('中止已经登记的传输时发送取消状态，不报告下载失败', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weq-managed-media-cancel-'));
  roots.push(root);
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  const activity = vi.fn((state: TransferActivity) => {
    if (state.total) started.resolve();
  });
  transferActivity.on('state', activity);
  try {
    const work = managedMediaDownload('https://fixture.invalid/image', join(root, 'image.png'), {
      signal: controller.signal,
      fetcher: async () =>
        new Response(new ReadableStream({}), {
          headers: { 'Content-Type': 'image/png', 'Content-Length': String(LARGE_TRANSFER_BYTES) },
        }),
    });
    await started.promise;
    controller.abort();
    expect(await work).toMatchObject({ ok: false });
    expect(activity).toHaveBeenLastCalledWith(expect.objectContaining({ cancelled: true }));
    expect(activity.mock.calls.at(-1)?.[0].error).toBeUndefined();
  } finally {
    transferActivity.off('state', activity);
  }
});
