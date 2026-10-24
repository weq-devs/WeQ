import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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
