import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { walkResourceTree } from '../src/account/resource_tree_walk';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, lstat: vi.fn(actual.lstat) };
});

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'weq-resource-walk-'));
  roots.push(root);
  for (const name of ['a', 'b', 'c']) writeFileSync(join(root, name), name);
  return root;
}

it('单目录达到上限也必须截断，不能报完整或继续处理文件', async () => {
  const root = fixture();
  const visit = vi.fn();
  expect(await walkResourceTree(root, visit, 2)).toEqual({
    present: true,
    complete: false,
    errors: 0,
    truncated: true,
  });
  expect(visit).toHaveBeenCalledTimes(2);
});
it('读取失败保留已有统计并明确不完整，缺失根目录则为空目录', async () => {
  const root = fixture();
  const original = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises'))
    .lstat;
  vi.mocked(fs.lstat).mockImplementation((...args) => {
    if (args[0] === join(root, 'b')) return Promise.reject(new Error('合成读取失败'));
    return original(...args);
  });
  const visit = vi.fn();
  expect(await walkResourceTree(root, visit)).toMatchObject({ complete: false, errors: 1 });
  expect(visit).toHaveBeenCalledTimes(2);
  expect(await walkResourceTree(join(root, 'missing'), visit)).toEqual({
    present: false,
    complete: true,
    errors: 0,
    truncated: false,
  });
});
it('父目录只累计自身遍历，链接目录不扩大统计到外部原件', async () => {
  const root = fixture();
  const child = join(root, 'child');
  mkdirSync(child);
  writeFileSync(join(child, 'nested'), 'nested');
  const outside = mkdtempSync(join(tmpdir(), 'weq-resource-original-'));
  roots.push(outside);
  writeFileSync(join(outside, 'original'), 'preserve');
  symlinkSync(outside, join(child, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const visit = vi.fn();
  expect(await walkResourceTree(root, visit)).toMatchObject({ complete: true });
  expect(visit).toHaveBeenCalledTimes(4);
  expect(await walkResourceTree(join(child, 'linked'), visit)).toMatchObject({ complete: false });
  expect(visit).toHaveBeenCalledTimes(4);
});
