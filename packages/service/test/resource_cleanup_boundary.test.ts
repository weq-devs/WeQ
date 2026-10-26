import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { AccountSession } from '@weq/account';
import type { Platform } from '@weq/platform';
import { ResourceCleanupService } from '../src/account/resource_cleanup';
import { MediaResourceService } from '../src/account/media_resource';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * 造一个目录链接。POSIX 用 `symlink`；Windows 创建符号链接需要管理员权限
 * （非提权跑单测时直接 EPERM），所以退而用 junction —— 它同样会被
 * `realpathSync` 解析成真实路径，正是这里要测的「链接逃逸」语义。
 */
function linkDir(target: string, path: string): void {
  try {
    symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    const code = (error as { code?: string }).code;
    // 非提权的 Windows 连 junction 都建不了时跳过，而不是假装测过。
    if (process.platform === 'win32' && (code === 'EPERM' || code === 'EACCES')) return;
    throw error;
  }
}

function fixture(linkedParent = false) {
  const root = mkdtempSync(join(tmpdir(), 'weq-cleanup-boundary-'));
  roots.push(root);
  const data = join(root, 'nt_data');
  const outside = join(root, 'outside');
  mkdirSync(data);
  mkdirSync(join(outside, 'Ori'), { recursive: true });
  const victim = join(outside, 'Ori', 'sentinel.bin');
  writeFileSync(victim, 'preserve');
  const pic = linkedParent ? join(data, 'linked', 'Pic') : join(data, 'Pic');
  if (linkedParent) {
    mkdirSync(join(outside, 'Pic', 'Ori'), { recursive: true });
    writeFileSync(join(outside, 'Pic', 'Ori', 'sentinel.bin'), 'preserve');
    linkDir(outside, join(data, 'linked'));
  } else linkDir(outside, pic);
  const service = new ResourceCleanupService(
    { context: { uin: 'fixture' } } as AccountSession,
    { ntDataDir: () => data, picDir: () => pic } as unknown as Platform,
  );
  return { data, outside, victim, pic, service };
}

it.each(['all', 'ori', 'thumb'] as const)(
  'refuses an outside target symlink for %s cleanup',
  async (variant) => {
    const f = fixture();
    expect(await f.service.cleanup([{ id: 'pic', variant }])).toEqual({
      freedBytes: 0,
      perTarget: [],
    });
    expect(existsSync(f.victim)).toBe(true);
    expect(existsSync(f.pic)).toBe(true);
  },
);

it('refuses a target reached through an outside linked parent', async () => {
  const f = fixture(true);
  await f.service.cleanup([{ id: 'pic', variant: 'ori' }]);
  expect(existsSync(join(f.outside, 'Pic', 'Ori', 'sentinel.bin'))).toBe(true);
});

it('removes contained originals while retaining thumbnails and nested symlinks', async () => {
  const f = fixture();
  rmSync(f.pic);
  mkdirSync(join(f.pic, 'Ori'), { recursive: true });
  mkdirSync(join(f.pic, 'Thumb'));
  writeFileSync(join(f.pic, 'Ori', 'original.bin'), 'delete');
  writeFileSync(join(f.pic, 'Thumb', 'preview.bin'), 'preserve');
  linkDir(f.outside, join(f.pic, 'nested'));
  const result = await f.service.cleanup([{ id: 'pic', variant: 'ori' }]);
  expect(result.perTarget[0]?.removed).toBe(1);
  expect(existsSync(join(f.pic, 'Ori', 'original.bin'))).toBe(false);
  expect(existsSync(join(f.pic, 'Thumb', 'preview.bin'))).toBe(true);
  expect(existsSync(f.victim)).toBe(true);
});

it('不把不支持的变体扩大成整目录删除', async () => {
  const f = fixture();
  const avatar = join(f.data, 'avatar');
  mkdirSync(avatar);
  writeFileSync(join(avatar, 'sentinel.bin'), 'preserve');
  expect(await f.service.cleanup([{ id: 'avatar', variant: 'thumb' }])).toEqual({
    freedBytes: 0,
    perTarget: [{ id: 'avatar', variant: 'thumb', freedBytes: 0, removed: 0, failed: 1 }],
  });
  expect(existsSync(join(avatar, 'sentinel.bin'))).toBe(true);
});

it('全部清理逐文件计数，重复指令不重复累计，外部链接原件保留', async () => {
  const f = fixture();
  rmSync(f.pic);
  mkdirSync(join(f.pic, 'Ori'), { recursive: true });
  mkdirSync(join(f.pic, 'Thumb'));
  writeFileSync(join(f.pic, 'Ori', 'original.bin'), 'delete');
  writeFileSync(join(f.pic, 'Thumb', 'preview.bin'), 'delete');
  linkDir(f.outside, join(f.pic, 'nested'));
  const result = await f.service.cleanup([
    { id: 'pic', variant: 'all' },
    { id: 'pic', variant: 'all' },
  ]);
  expect(result.freedBytes).toBe(12);
  expect(result.perTarget).toEqual([
    { id: 'pic', variant: 'all', freedBytes: 12, removed: 2, failed: 0 },
  ]);
  expect(existsSync(f.victim)).toBe(true);
});

it('真实表情父目录统计包含子目标但不重复；只读类别和主动下载不进入删除白名单', async () => {
  const f = fixture();
  const emoji = join(f.data, 'Emoji');
  const market = join(emoji, 'market');
  mkdirSync(market, { recursive: true });
  writeFileSync(join(market, 'sticker'), 'sticker');
  writeFileSync(join(emoji, 'metadata'), 'meta');
  const platform = {
    ntDataDir: () => f.data,
    marketFaceDir: () => market,
    emojiRelatedDir: () => null,
    picDir: () => f.pic,
    videoDir: () => null,
    emojiRecvDir: () => null,
    personalEmojiDir: () => null,
    pttDir: () => null,
    fileDir: () => null,
  } as unknown as Platform;
  const session = { context: { uin: 'fixture' } } as AccountSession;
  const cleanup = new ResourceCleanupService(session, platform);
  expect(await new MediaResourceService(session, platform).analyzeTree('emoji')).toMatchObject({
    files: 2,
    bytes: 11,
    complete: true,
  });
  expect((await cleanup.listTargets()).find((target) => target.id === 'marketface')).toMatchObject({
    files: 1,
    bytes: 7,
    complete: true,
  });
  await cleanup.cleanup([
    { id: 'sysEmoji', variant: 'all' },
    { id: 'marketPack', variant: 'all' },
    { id: 'downloadFile', variant: 'all' },
    { id: 'marketface', variant: 'all' },
  ]);
  expect(existsSync(join(emoji, 'metadata'))).toBe(true);
  expect(existsSync(join(market, 'sticker'))).toBe(false);
  expect(existsSync(f.victim)).toBe(true);
});
