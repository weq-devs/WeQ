/**
 * `SysEmojiResourceService.listInnerFaces` 的单测。
 *
 * 这个方法是「随机表情」功能的**唯一数据源**（UI 不硬编码 faceId），判据纯粹是
 * 磁盘事实：`<faceId>/lottie/<faceId>_<n>.json`。这里用临时目录拼出真实目录形状，
 * 钉住几条容易错的约定：intro（`<faceId>.json`）不算、`surprise/` 等子目录里的
 * `100_padLandScape.json` 不能误判、非数字（unicode 字形）目录跳过、跨 root 合并。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SysEmojiResourceService } from '../src/account/sys_emoji_resource';

/** 在 root 下按相对路径写一个占位文件（自动建目录）。 */
function write(root: string, rel: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, '{}');
}

/** 以单个 root 构造服务（session / platform 只需满足 roots() 用到的那两处）。 */
function service(root: string, extraRoot?: () => string | null): SysEmojiResourceService {
  const platform = { emojiResourceDir: () => root } as never;
  const session = { context: { uin: '1' } } as never;
  return new SysEmojiResourceService(session, platform, extraRoot);
}

describe('SysEmojiResourceService.listInnerFaces', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'weq-sysemoji-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('只列 lottie 里的结果片段，忽略 intro 与子目录', async () => {
    // 358 骰子：6 个结果；同名 intro 358.json 不算。
    for (let n = 1; n <= 6; n += 1) write(root, `358/lottie/358_${n}.json`);
    write(root, '358/lottie/358.json');
    // surprise 子目录里的下划线文件不能误判成 innerId。
    write(root, '358/lottie/surprise/100_padLandScape.json');
    // 114 篮球：只有 1 个结果。
    write(root, '114/lottie/114_1.json');
    // 5：只有 intro，没有结果片段 → 不出现。
    write(root, '5/lottie/5.json');
    // 非数字目录（unicode 字形表情）一律跳过。
    write(root, '😊/lottie/😊_1.json');

    await expect(service(root).listInnerFaces()).resolves.toEqual([
      { faceId: 114, innerIds: ['1'] },
      { faceId: 358, innerIds: ['1', '2', '3', '4', '5', '6'] },
    ]);
  });

  it('跨 root 合并同名表情的结果编号', async () => {
    const extra = mkdtempSync(join(tmpdir(), 'weq-sysemoji-extra-'));
    try {
      write(root, '358/lottie/358_1.json');
      write(extra, '358/lottie/358_2.json');
      write(extra, '502/lottie/502_3.json');

      await expect(service(root, () => extra).listInnerFaces()).resolves.toEqual([
        { faceId: 358, innerIds: ['1', '2'] },
        { faceId: 502, innerIds: ['3'] },
      ]);
    } finally {
      rmSync(extra, { recursive: true, force: true });
    }
  });

  it('资源目录不存在时返回空表（不抛错）', async () => {
    await expect(service(join(root, 'missing')).listInnerFaces()).resolves.toEqual([]);
  });
});
