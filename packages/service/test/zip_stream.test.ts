import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { readZipEntries, writeZipFile } from '../src/common/zip';

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'weq-stream-zip-'));
  roots.push(root);
  const image = join(root, 'input');
  const bytes = Buffer.alloc(200_000);
  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
  await writeFile(image, bytes);
  return { root, image, bytes, output: join(root, 'output.zip') };
}
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it('逐块生成的 UTF-8 ZIP 可经严格 CRC 校验读回，不丢失跨块字节', async () => {
  const f = await fixture();
  await writeZipFile(f.output, [{ name: '我的表情/动画.gif', path: f.image }]);
  expect(
    readZipEntries(await readFile(f.output), {
      maxEntries: 2,
      maxEntryBytes: f.bytes.length,
      maxTotalBytes: f.bytes.length,
    }),
  ).toEqual([{ name: '我的表情/动画.gif', data: f.bytes }]);
});

it('空来源生成合法空 ZIP', async () => {
  const f = await fixture();
  await writeZipFile(f.output, []);
  expect(
    readZipEntries(await readFile(f.output), { maxEntries: 1, maxEntryBytes: 1, maxTotalBytes: 1 }),
  ).toEqual([]);
});

it('取消时不发布不完整文件，并清除本次 part 文件', async () => {
  const f = await fixture();
  const controller = new AbortController();
  await expect(
    writeZipFile(f.output, [{ name: 'a', path: f.image }], {
      signal: controller.signal,
      progress: () => controller.abort(),
    }),
  ).rejects.toThrow();
  expect(await readdir(f.root)).toEqual(['input']);
});

it('不覆盖已存在的目标文件，来源失败时也清理 part', async () => {
  const f = await fixture();
  await writeFile(f.output, 'original');
  await expect(writeZipFile(f.output, [{ name: 'a', path: f.image }])).rejects.toThrow();
  expect(await readFile(f.output, 'utf8')).toBe('original');
  await expect(
    writeZipFile(join(f.root, 'missing.zip'), [{ name: 'a', path: join(f.root, 'absent') }]),
  ).rejects.toThrow();
  expect((await readdir(f.root)).some((name) => name.endsWith('.part'))).toBe(false);
});

it('拒绝越界或重复路径，不创建产物', async () => {
  const f = await fixture();
  await expect(writeZipFile(f.output, [{ name: '../a', path: f.image }])).rejects.toThrow();
  await expect(
    writeZipFile(f.output, [
      { name: 'a', path: f.image },
      { name: 'a', path: f.image },
    ]),
  ).rejects.toThrow('重复');
  expect(await readdir(f.root)).toEqual(['input']);
});
