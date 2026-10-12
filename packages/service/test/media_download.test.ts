import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadUrlToFile } from '../src/account/media_url';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64',
);
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'weq-media-'));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await rm(directory, { recursive: true, force: true });
});
const response = (bytes: Uint8Array | string, type = 'image/png') =>
  new Response(bytes, { headers: { 'content-type': type } });

describe('verified media publication', () => {
  it('streams a valid image and records byte count and hash', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(png)),
    );
    const result = await downloadUrlToFile(
      'https://fixture.invalid/image',
      join(directory, 'image.png'),
      { expectedKind: 'image' },
    );
    expect(result).toMatchObject({ ok: true, bytes: png.length });
    expect(await readFile(join(directory, 'image.png'))).toEqual(png);
    expect(await readdir(directory)).toEqual(['image.png']);
  });
  it('rejects an HTML error page disguised as binary', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response('<html>expired</html>', 'application/octet-stream')),
    );
    expect(
      await downloadUrlToFile('https://fixture.invalid/image', join(directory, 'image.png'), {
        expectedKind: 'image',
      }),
    ).toMatchObject({ ok: false });
    expect(await readdir(directory)).toEqual([]);
  });
  it('rejects the wrong media kind and a mismatched expected size', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(png)),
    );
    expect(
      await downloadUrlToFile('https://fixture.invalid/video', join(directory, 'video.mp4'), {
        expectedKind: 'video',
      }),
    ).toMatchObject({ ok: false });
    expect(
      await downloadUrlToFile('https://fixture.invalid/image', join(directory, 'image.png'), {
        expectedSize: 1,
      }),
    ).toMatchObject({ ok: false });
    expect(await readdir(directory)).toEqual([]);
  });
  it('preserves a different existing file', async () => {
    const dest = join(directory, 'image.png');
    await writeFile(dest, 'existing-original');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(png)),
    );
    expect(
      await downloadUrlToFile('https://fixture.invalid/image', dest, { expectedKind: 'image' }),
    ).toMatchObject({ ok: false });
    expect(await readFile(dest, 'utf8')).toBe('existing-original');
    expect(await readdir(directory)).toEqual(['image.png']);
  });
  it('accepts an identical existing file without replacement', async () => {
    const dest = join(directory, 'image.png');
    await writeFile(dest, png);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(png)),
    );
    expect(
      await downloadUrlToFile('https://fixture.invalid/image', dest, { expectedKind: 'image' }),
    ).toMatchObject({ ok: true });
    expect(await readdir(directory)).toEqual(['image.png']);
  });
  it('does not issue a request after cancellation', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const controller = new AbortController();
    controller.abort();
    expect(
      await downloadUrlToFile('https://fixture.invalid/image', join(directory, 'image.png'), {
        signal: controller.signal,
      }),
    ).toMatchObject({ ok: false });
    expect(fetch).not.toHaveBeenCalled();
  });
});
