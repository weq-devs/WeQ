/**
 * 红包皮肤离线目录（`redpack_catalog.ts`）的离线单测。
 *
 * 目录数据来自 `resources/redpack/skins.json`（`pnpm rpskin:fetch` 抓取，入库）。
 * 这里只验证「资源文件能解析、id→封面映射正确、没记录的 id 返回 null」——
 * 正是 `weq-media://redbag` 回退链第 1 档依赖的行为。
 *
 * 跑法（apps/desktop 没有 test 脚本，不进 `pnpm -r test`）：
 *   cd apps/desktop && node --import tsx --test test/redpack_catalog.test.ts
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resourceSkinCover } from '../src/main/redpack_catalog.ts';

test('离线目录命中：返回记录的封面 URL', () => {
  // 2658「生日祝福」的封面在 img/202604/…，不是固定 aio.png 路径。
  assert.equal(
    resourceSkinCover('2658'),
    'https://moggy-image-1251316161.file.myqcloud.com/img/202604/09ba71d5f3097d10b0efe49ffb5d63e4.png',
  );
});

test('数字与字符串 id 等价', () => {
  assert.equal(resourceSkinCover(2658), resourceSkinCover('2658'));
});

test('目录里没有记录的 id 返回 null（交给在线 / aio 回退）', () => {
  assert.equal(resourceSkinCover('999999'), null);
});

test('无封面的皮肤（preview 为空）返回 null', () => {
  // 2090「元梦之星」在抓取数据里没有 preview。
  assert.equal(resourceSkinCover('2090'), null);
});

test('非法 id 返回 null', () => {
  assert.equal(resourceSkinCover('abc'), null);
  assert.equal(resourceSkinCover('0'), null);
  assert.equal(resourceSkinCover('-1'), null);
});
