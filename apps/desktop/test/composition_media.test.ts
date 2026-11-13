// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { compositionMediaSource } from '../src/main/composition_media';
const f = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock('../src/main/media_protocol', () => ({ handleMediaRequest: f.resolve }));
it('合成导出调用现有完整媒体解析器，传递稳定定位字段并流式保存，取消不取新媒体', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weq-composition-media-'));
  try {
    f.resolve.mockResolvedValueOnce(
      new Response(Uint8Array.of(1, 2, 3), { headers: { 'content-type': 'image/png' } }),
    );
    const segment = {
      t: 'image',
      preview: {
        type: 'pic',
        data: {
          fileName: 'photo.png',
          fileToken: 'file-token',
          md5: 'hash',
          originalUrl: '/download/original',
          subType: 1,
        },
      },
    };
    const check = vi.fn();
    const path = await compositionMediaSource(
      segment,
      { time: 100, sourceMsgId: '23' },
      root,
      new AbortController().signal,
      check,
    );
    expect(await readFile(path!)).toEqual(Buffer.from([1, 2, 3]));
    const request = f.resolve.mock.calls[0]![0] as Request;
    const url = new URL(request.url);
    expect(url.protocol).toBe('weq-media:');
    expect(url.hostname).toBe('pic');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      t: '100000',
      token: 'file-token',
      md5: 'hash',
      msgId: '23',
      orig: '/download/original',
      recv: '1',
    });
    await expect(
      compositionMediaSource(segment, { time: 100 }, root, AbortSignal.abort(), check),
    ).rejects.toThrow();
    expect(f.resolve).toHaveBeenCalledOnce();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
