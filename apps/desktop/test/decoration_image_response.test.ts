import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { makeSolidPng } from '@weq/protocol';
import { decorationImageResponse } from '../src/main/decoration_image_response';

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture(data: Uint8Array) {
  const dir = mkdtempSync(join(tmpdir(), 'weq-frame-limit-'));
  directories.push(dir);
  const path = join(dir, 'frame.png');
  writeFileSync(path, data);
  return path;
}
it('正常首帧继续流式响应并支持预检 Range', async () => {
  const path = fixture(makeSolidPng(4, 4, [32, 140, 100]));
  const response = await decorationImageResponse(
    path,
    new Request('https://fixture.invalid', { headers: { Range: 'bytes=0-23' } }),
  );
  expect(response.status).toBe(206);
  expect((await response.arrayBuffer()).byteLength).toBe(24);
});
it('异常大帧和损坏文件在 CSS 或 Image 取得字节前拒绝', async () => {
  const png = makeSolidPng(4, 4, [32, 140, 100]);
  const head = Uint8Array.from(png.subarray(0, 24));
  new DataView(head.buffer).setUint32(16, 8192);
  new DataView(head.buffer).setUint32(20, 8192);
  for (const data of [head, new Uint8Array(24), new Uint8Array(2)]) {
    const response = await decorationImageResponse(fixture(data));
    expect(response.status).toBe(413);
  }
});
it('字体帧保留重新验证行为，文件缺失仍返回 404', async () => {
  const path = fixture(makeSolidPng(4, 4, [32, 140, 100]));
  const first = await decorationImageResponse(path, undefined, true);
  const modified = first.headers.get('Last-Modified')!;
  await first.body?.cancel();
  expect(
    (
      await decorationImageResponse(
        path,
        new Request('https://fixture.invalid', { headers: { 'If-Modified-Since': modified } }),
        true,
      )
    ).status,
  ).toBe(304);
  expect((await decorationImageResponse(`${path}.missing`)).status).toBe(404);
});
