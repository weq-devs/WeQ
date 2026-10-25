import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { AccountSession } from '@weq/account';
import type { Platform } from '@weq/platform';
import { FileSearchService } from '../src/account/file_search';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'weq-file-search-'));
  roots.push(root);
  const session = { context: { uin: '12345' } } as AccountSession;
  const platform = {
    picDir: () => root,
    videoDir: () => root,
    pttDir: () => root,
    emojiRecvDir: () => root,
    fileDir: () => root,
  } as unknown as Platform;
  const service = new FileSearchService(session, platform);
  const put = (name: string, bucket = 'Thumb', month = '2023-08') => {
    const dir = join(root, month, bucket);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, 'synthetic media');
    return path;
  };
  return { service, put };
}
const time = new Date(2023, 7, 15).getTime();
const hash = '1234567890abcdef1234567890abcdef';

it('空文件名不能匹配目录内第一张图片或表情', async () => {
  const { service, put } = fixture();
  put('unrelated_0.jpg');
  put('other.jpg', 'Ori');
  for (const type of ['pic', 'emoji', 'video', 'ptt'] as const) {
    expect(await service.findFile(time, '', type)).toEqual({ source: null, thumb: null });
  }
});
it('旧消息没有文件名时按完整 MD5 定位，不能借用其它文件', async () => {
  const { service, put } = fixture();
  put('unrelated_0.jpg');
  const thumb = put(`${hash.toUpperCase()}_0.jpg`);
  const source = put(`${hash}.png`, 'Ori');
  expect(await service.findFile(time, '', 'pic', hash)).toEqual({ source, thumb });
  expect(await service.findFile(time, 'unrelated.jpg', 'pic', hash)).toEqual({ source, thumb });
});
it('缺失目标哈希时不回退到其它同名图片或不完整哈希', async () => {
  const { service, put } = fixture();
  put(`prefix${hash}_0.jpg`);
  put(`${hash}ff_0.jpg`);
  put('image_0.jpg');
  expect(await service.findFile(time, 'image.jpg', 'pic', hash)).toEqual({
    source: null,
    thumb: null,
  });
  expect(await service.findFile(time, '', 'pic', 'invalid')).toEqual({ source: null, thumb: null });
});
it('已知文件名只匹配完整文件身份及数字缩略图后缀', async () => {
  const { service, put } = fixture();
  put('prefix-target_0.jpg');
  put('target-other_0.jpg');
  expect(await service.findFile(time, 'target.png', 'pic')).toEqual({ source: null, thumb: null });
  const thumb = put('target_720.jpg');
  const source = put('target.png', 'Ori');
  expect(await service.findFile(time, 'target.png', 'pic')).toEqual({ source, thumb });
});
it('相邻月份和跨月表情仍按精确身份查找', async () => {
  const { service, put } = fixture();
  const thumb = put(`${hash}_0.jpg`, 'Thumb', '2023-07');
  expect(await service.findFile(time, '', 'pic', hash)).toEqual({ source: null, thumb });
  const source = put('sticker.gif', 'Ori', '2022-01');
  expect(await service.findFile(time, 'sticker.gif', 'emoji')).toEqual({
    source: null,
    thumb: source,
  });
});
