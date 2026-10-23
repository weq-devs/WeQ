/**
 * 商城响应归一化 —— 旧 `tools/dress_mall.ts` 的单测化。本来就是纯离线的：
 * 直接喂仓库里的原始响应（`resources/dress/ranking-*.json`），tmp 下的 HAR
 * 在本机有就多测一份（CI 没有，跳过）。
 *
 * 重点：`normalizeMallItems` 对两种形状通吃 —— 排行榜包了一层 `items[].item`，
 * 搜索是直接的 `results[]`；字体 immersiveMaterial 为空串、挂件没有
 * immersiveMaterial 时不炸；垃圾输入一律回空数组而不是抛错（装扮页要能降级）。
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { normalizeMallItems } from '../src/account/web/dress_mall';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** 取 HAR 里第一条响应的 JSON body。 */
function harBody(path: string): unknown {
  const har = JSON.parse(readFileSync(path, 'utf8')) as {
    log: { entries: Array<{ response: { content: { text: string } } }> };
  };
  return JSON.parse(har.log.entries[0]!.response.content.text);
}

const SAMPLES: Array<{ label: string; path: string; kind: 'json' | 'har'; minItems: number }> = [
  {
    label: '静态排行(气泡)',
    path: 'resources/dress/ranking-bubble.json',
    kind: 'json',
    minItems: 20,
  },
  { label: '排行 HAR(气泡)', path: 'tmp/bubble.har', kind: 'har', minItems: 20 },
  { label: '搜索 HAR(气泡)', path: 'tmp/bubble_search.har', kind: 'har', minItems: 40 },
  { label: '排行 HAR(字体)', path: 'tmp/font.har', kind: 'har', minItems: 20 },
  { label: '搜索 HAR(字体)', path: 'tmp/font_search.har', kind: 'har', minItems: 40 },
  {
    label: '静态排行(字体)',
    path: 'resources/dress/ranking-font.json',
    kind: 'json',
    minItems: 20,
  },
  {
    label: '静态排行(挂件)',
    path: 'resources/dress/ranking-widget.json',
    kind: 'json',
    minItems: 20,
  },
  {
    // 通话背景（appId 17）。服务端**没有**这一类的排行榜，这份是搜索结果的快照，
    // 专门给离线/静态列表用 —— 所以条数按搜集到的来（常见词也就几十条）。
    label: '静态排行(通话背景)',
    path: 'resources/dress/ranking-callbg.json',
    kind: 'json',
    minItems: 40,
  },
  { label: '排行 HAR(挂件)', path: 'tmp/ranking.har', kind: 'har', minItems: 20 },
  { label: '搜索 HAR(挂件)', path: 'tmp/search.har', kind: 'har', minItems: 40 },
];

function assertNormalized(
  label: string,
  path: string,
  kind: 'json' | 'har',
  minItems: number,
): void {
  const abs = join(REPO_ROOT, path);
  const payload = kind === 'har' ? harBody(abs) : JSON.parse(readFileSync(abs, 'utf8'));
  const items = normalizeMallItems(payload);

  expect(items.length, `${label}: 条数 ≥${minItems}`).toBeGreaterThanOrEqual(minItems);
  const bad = items.filter((i) => !i.itemId || !i.appId || !i.name || !i.previewUrl);
  expect(bad, `${label}: 字段不全`).toEqual([]);

  const first = items[0]!;
  expect(first.labels).toBeInstanceOf(Array);
}

describe('通话背景条目', () => {
  it('appId 17 的条目带动态视频，且不会把 mp4 当成大图', () => {
    const payload = JSON.parse(
      readFileSync(join(REPO_ROOT, 'resources/dress/ranking-callbg.json'), 'utf8'),
    );
    const items = normalizeMallItems(payload);
    expect(items.length).toBeGreaterThan(0);
    // 全部是来电类
    expect(items.every((i) => i.appId === 17)).toBe(true);
    // 每一条都应该有视频（通话背景的核心素材）
    const withVideo = items.filter((i) => i.videoUrl && /\.mp4(\?|$)/.test(i.videoUrl));
    expect(withVideo.length).toBe(items.length);
    // 大图不能误取成 mp4
    const badLarge = items.filter((i) => i.previewLargeUrl && /\.mp4(\?|$)/.test(i.previewLargeUrl));
    expect(badLarge).toEqual([]);
    // 静态首帧可当兜底图
    expect(items.every((i) => Boolean(i.previewUrl))).toBe(true);
  });
});

describe('normalizeMallItems (offline golden responses)', () => {
  for (const s of SAMPLES) {
    it(`normalizes ${s.label}`, () => {
      if (!existsSync(join(REPO_ROOT, s.path))) return; // tmp HAR 本机才有，CI 跳过
      assertNormalized(s.label, s.path, s.kind, s.minItems);
    });
  }
});

describe('normalizeMallItems (degraded input)', () => {
  it.each([
    ['空对象', {}],
    ['缺 items', { response: {} }],
    ['空 items', { response: { items: [] } }],
    ['null', null],
    ['字符串', 'nope'],
  ])('%s → 空数组', (_label, junk) => {
    expect(normalizeMallItems(junk)).toEqual([]);
  });
});
