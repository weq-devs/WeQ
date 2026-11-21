// @vitest-environment node
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { describeViewerFile } from '@weq/service';
import { registerViewerSource, closeViewerSources } from '../src/main/export_viewer';
import { handleMediaRequest } from '../src/main/media_protocol';
const roots: string[] = [],
  ids: string[] = [];
afterEach(() => {
  closeViewerSources(ids.splice(0));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it('离线导出媒体无需账号即可流式读取，保留视频 Range 与 CORS，并隔离活动内容', async () => {
  const root = mkdtempSync(join(tmpdir(), 'weq-viewer-media-'));
  roots.push(root);
  writeFileSync(join(root, 'chat.json'), '[]');
  writeFileSync(join(root, 'video.mp4'), '0123456789');
  const source = registerViewerSource(await describeViewerFile(join(root, 'chat.json')));
  ids.push(source.id);
  const url = `weq-media://exportviewer?id=${source.id}&path=video.mp4`;
  const response = await handleMediaRequest(new Request(url, { headers: { range: 'bytes=2-5' } }));
  expect(response.status).toBe(206);
  expect(await response.text()).toBe('2345');
  expect(response.headers.get('Content-Range')).toBe('bytes 2-5/10');
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
  expect(response.headers.get('Content-Security-Policy')).toContain('sandbox');
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  closeViewerSources([source.id]);
  expect((await handleMediaRequest(new Request(url))).status).toBe(404);
});
it('媒体协议不接受不存在的来源能力和外部路径', async () => {
  const response = await handleMediaRequest(
    new Request('weq-media://exportviewer?id=unknown&path=/etc/passwd'),
  );
  expect(response.status).toBe(404);
});

it.each([
  ['89504e470d0a1a0a0000000d49484452', 'image/png', '.png'],
  ['000000186674797069736f6d0000020069736f6d61766331', 'video/mp4', '.mp4'],
  ['00000018667479706176696600000000617669666d696631', 'image/avif', '.avif'],
  ['000000186674797074657374000000007465737400000000', 'application/octet-stream', ''],
])('无后缀归档媒体 %s 保留原路径，另存按文件头提供名称', async (hex, type, extension) => {
  const root = mkdtempSync(join(tmpdir(), 'weq-viewer-media-'));
  roots.push(root);
  writeFileSync(join(root, 'chat.json'), '[]');
  mkdirSync(join(root, 'media'));
  const bytes = Buffer.from(hex, 'hex');
  const hash = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(join(root, 'media', hash), bytes);
  const source = registerViewerSource(await describeViewerFile(join(root, 'chat.json')));
  ids.push(source.id);
  const url = `weq-media://exportviewer?id=${source.id}&path=media/${hash}`;
  const preview = await handleMediaRequest(new Request(url, { headers: { range: 'bytes=2-5' } }));
  expect(preview.status).toBe(206);
  expect(preview.headers.get('Content-Type')).toBe(type);
  expect(preview.headers.get('Content-Disposition')).toBeNull();
  expect(Buffer.from(await preview.arrayBuffer())).toEqual(bytes.subarray(2, 6));
  const download = await handleMediaRequest(new Request(`${url}&download=1`));
  expect(download.headers.get('Content-Disposition')).toBe(
    `attachment; filename*=UTF-8''${hash}${extension}`,
  );
  expect(Buffer.from(await download.arrayBuffer())).toEqual(bytes);
  expect(readdirSync(join(root, 'media'))).toEqual([hash]);
});
