/**
 * Win32 path-resolution tests —— 重点覆盖 `nt_qq/global/nt_data/search/resource_jieba`
 * 这一共享词典路径（与账号目录 `<uin>/nt_qq/nt_data` 无关）。
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { findJiebaDictDir } from '../src/win32/paths';

const tmpRoots: string[] = [];

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'weq-win32-paths-'));
  tmpRoots.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

describe('jieba dictionary (shared nt_qq/global tree)', () => {
  it('resolves <root>/nt_qq/global/nt_data/search/resource_jieba', () => {
    const root = tmpRoot();
    const dir = join(root, 'nt_qq', 'global', 'nt_data', 'search', 'resource_jieba');
    mkdirSync(dir, { recursive: true });
    expect(findJiebaDictDir(tmpRoot(), root)).toBe(dir);
  });

  it('returns null when QQ never downloaded the dictionary', () => {
    // home 也必须是空的临时目录：候选根里还有 `<home>/Documents/Tencent Files`
    // 和 `user_data_info` 里记的路径，拿真实 home 跑会扫到开发机自己的 QQ 数据。
    expect(findJiebaDictDir(tmpRoot(), tmpRoot())).toBeNull();
  });
});
