// @vitest-environment node
/**
 * 红包皮肤离线目录（`redpack_catalog.ts`）的离线单测。
 *
 * 目录数据来自 `resources/redpack/skins.json`（`pnpm rpskin:fetch` 抓取，入库）。
 * 这里只验证「资源文件能解析、id→封面映射正确、没记录的 id 返回 null」——
 * 正是 `weq-media://redbag` 回退链第 1 档依赖的行为。
 *
 * 跑法：`pnpm --filter @weq/desktop test`（也随 `pnpm -r test` 进 CI）。
 */

import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  listRedPackSkins,
  redPackSkinField,
  resourceSkinCover,
} from '../src/main/redpack_catalog.ts';

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

// ── 展柜（个性装扮 → 红包封面）用到的两个导出 ──────────────────────────────

test('展柜目录按 id 升序，且记录总数', () => {
  const { skins, total, generatedAt } = listRedPackSkins();
  assert.ok(total > 0, 'skins.json 应当有条目');
  assert.equal(skins.length, total);
  for (let i = 1; i < skins.length; i++) assert.ok(skins[i - 1]!.id < skins[i]!.id);
  assert.ok(generatedAt > 0, '目录应当带抓取时间');
});

test('展柜目录按名称过滤，忽略空白差异', () => {
  const hit = listRedPackSkins('生日祝福');
  assert.ok(hit.skins.length >= 1);
  assert.ok(hit.skins.every((skin) => skin.name.includes('生日祝福')));
  // total 是全量，不随关键词变。
  assert.equal(hit.total, listRedPackSkins().total);
  // 全角/半角空格不会让匹配失败。
  const spaced = listRedPackSkins(' 生日 祝福 ');
  assert.ok(spaced.skins.length >= 1);
});

test('展柜目录的 keyword 无命中时返回空数组（total 不变）', () => {
  const miss = listRedPackSkins('这个名字一定不存在');
  assert.equal(miss.skins.length, 0);
  assert.ok(miss.total > 0);
});

test('redPackSkinField 只读本地目录记的字段', () => {
  // 2658「生日祝福」：四个图字段都有记录，但不在固定 aio.png 路径下。
  const preview = redPackSkinField(2658, 'preview');
  assert.equal(typeof preview, 'string');
  assert.ok(preview?.includes('/img/202604/'));
  assert.equal(redPackSkinField(2658, 'preview'), redPackSkinField('2658', 'preview'));
  assert.equal(redPackSkinField(999999, 'preview'), null);
  assert.equal(redPackSkinField('abc', 'preview'), null);
});

test('展柜卡片只列出目录里真有 URL 的图字段', () => {
  const skin = listRedPackSkins('生日祝福').skins.find((entry) => entry.id === 2658);
  assert.ok(skin);
  const present = (['preview', 'popup', 'background', 'image'] as const).filter((variant) =>
    Boolean(skin[variant]),
  );
  assert.deepEqual(present, ['preview', 'popup', 'background', 'image']);
});
