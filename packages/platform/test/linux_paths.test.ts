/**
 * Linux path-resolution tests —— 重点覆盖 `global/` 共享资源（结巴词典）的解析，
 * 以及它与账号目录 `nt_qq_<hash>` 无关这一点。
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { accountDirName, findJiebaDictDir, findNtDataDir } from '../src/linux/paths';

const tmpRoots: string[] = [];

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'weq-linux-paths-'));
  tmpRoots.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
});

describe('jieba dictionary (shared global/ tree)', () => {
  it('resolves <root>/global/nt_data/search/resource_jieba', () => {
    const root = tmpRoot();
    const dir = join(root, 'global', 'nt_data', 'search', 'resource_jieba');
    mkdirSync(dir, { recursive: true });
    expect(findJiebaDictDir('/home/test', root)).toBe(dir);
  });

  it('returns null when QQ never downloaded the dictionary', () => {
    expect(findJiebaDictDir('/home/test', tmpRoot())).toBeNull();
  });

  it('does NOT fall back to the legacy nt_qq/global path (edge feature)', () => {
    const root = tmpRoot();
    // 老布局给 login.db 留的遗产路径：结巴词典刻意不认它。
    mkdirSync(join(root, 'nt_qq', 'global', 'nt_data', 'search', 'resource_jieba'), {
      recursive: true,
    });
    expect(findJiebaDictDir('/home/test', root)).toBeNull();
  });

  it('is account-independent (no nt_qq_<hash> involved)', () => {
    const root = tmpRoot();
    const dir = join(root, 'global', 'nt_data', 'search', 'resource_jieba');
    mkdirSync(dir, { recursive: true });
    // 账号级 nt_data 存在与否都不影响解析结果。
    mkdirSync(join(root, 'nt_qq_abcdef', 'nt_data'), { recursive: true });
    expect(findJiebaDictDir('/home/test', root)).toBe(dir);
  });
});

describe('per-account nt_data still resolves under nt_qq_<hash>', () => {
  it('is unaffected by the global helper', () => {
    const root = tmpRoot();
    const uid = 'u_LKt3AdAIMP-CUfn6ydzDzw';
    const dir = join(root, accountDirName(uid), 'nt_data');
    mkdirSync(dir, { recursive: true });
    expect(findNtDataDir(uid, '/home/test', root)).toBe(dir);
  });
});
