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
    expect(findJiebaDictDir(undefined, root)).toBe(dir);
  });

  it('returns null when QQ never downloaded the dictionary', () => {
    expect(findJiebaDictDir(undefined, tmpRoot())).toBeNull();
  });
});
