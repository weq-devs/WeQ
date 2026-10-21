/**
 * 气泡内容内边距：**横向与纵向用同一个比例（0.6 × 切片）**。
 *
 * 这里钉住的是一条**观感正确性**约定。历史上横向用的是 `max(左切片, 右切片)`（比例
 * 1.0），比纵向的 0.6 宽出一大截：切片深的款（149 / 2134173）文字被推到边条装饰之外，
 * 短短一句话左右各空出十几像素，和 QQ 本体的观感差得很远。
 *
 * 判据来自官方素材自己：`.9.png` 的 npTc chunk 里存着 QQ 的权威内容内边距
 * （偏移 12/16/20/24 = L/R/T/B，源图像素）。对缓存里 201 款气泡逐款量过 ——
 * 凡带权威值的款，`padding ÷ slice` 的中位数横竖都在 0.58~0.64；不带值的 9 款
 * （2014 那批老素材）用 0.6 也会落在同样的 20px 附近。所以两轴统一取 0.6。
 *
 * 测试用下面三款的**真实几何**（2014 / 2025 / 2026 各一代），公式一旦改回 1.0、
 * 或者纵横比例被拆开，这里立刻红。
 */

import { describe, expect, it } from 'vitest';
import { bubblePreviewCss } from '../src/renderer/src/lib/dressSkin';

const SCALE = 0.5;
/** 与 dressSkin.ts 的 PAD_RATIO 同源。 */
const PAD_RATIO = 0.6;

/**
 * 三款真实气泡的切片（来源：共享缓存 `dress_shared/bubbles/<id>.png` 的 npTc）。
 * `npTcPad` 是同一 chunk 里的权威内边距，仅用于交叉验证 0.6 这个比例选得对不对。
 */
const BUBBLES = [
  {
    id: 149,
    slice: { left: 73, top: 46, right: 47, bottom: 58 },
    // 2014 老素材，权威 padding 全 0。
    npTcPad: null,
  },
  {
    id: 2134173,
    slice: { left: 52, top: 52, right: 68, bottom: 52 },
    npTcPad: { l: 40, r: 40, t: 32, b: 32 },
  },
  {
    id: 2146597,
    slice: { left: 63, top: 67, right: 57, bottom: 37 },
    npTcPad: { l: 40, r: 40, t: 32, b: 32 },
  },
] as const;

function skinOf(b: (typeof BUBBLES)[number]) {
  return {
    itemId: b.id,
    slice: b.slice,
    imageSize: { w: 128, h: 112 },
    textColor: 'rgb(17 17 17)',
    localFile: null,
  };
}

/** 从生成的 CSS 里抠出 `padding: T R B L` 四个值（px）。 */
function paddingOf(css: string): [number, number, number, number] {
  const m = css.match(/padding:\s*([\d.]+)px\s+([\d.]+)px\s+([\d.]+)px(?!\s+[\d.]+px)/);
  if (!m) throw new Error(`no padding in css:\n${css}`);
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[2])];
}

describe('气泡内容内边距', () => {
  it.each(BUBBLES)('$id：横向 = 0.6 × max(左切片, 右切片)', (b) => {
    const css = bubblePreviewCss(skinOf(b), '.probe');
    const [, padR] = paddingOf(css);
    const expected =
      Math.round(Math.max(b.slice.left, b.slice.right) * SCALE * PAD_RATIO * 100) / 100;
    expect(padR).toBeCloseTo(expected, 2);
  });

  it.each(BUBBLES)('$id：横向与纵向比例一致（不再有 1.0 的横向特例）', (b) => {
    const css = bubblePreviewCss(skinOf(b), '.probe');
    const [padT, padR, padB] = paddingOf(css);

    // 纵向是「切片 × 0.6 + 不对称补偿」，所以拿它反推比例时要先扣掉补偿项。
    const avg = (b.slice.top + b.slice.bottom) / 2;
    const ratioOf = (pad: number, slice: number) =>
      (pad - (avg - slice) * SCALE * 0.5) / (slice * SCALE);

    expect(ratioOf(padT, b.slice.top)).toBeCloseTo(PAD_RATIO, 2);
    expect(ratioOf(padB, b.slice.bottom)).toBeCloseTo(PAD_RATIO, 2);
    // 横向量与纵向量处在同一量级（老公式会高出 60%）。
    expect(padR).toBeGreaterThan(0);
    expect(padR / ((padT + padB) / 2)).toBeGreaterThan(0.75);
    expect(padR / ((padT + padB) / 2)).toBeLessThan(2.2);
  });

  it('149：切片深的一侧不再把文字推到装饰之外（回归：横向曾 36.5px）', () => {
    const css = bubblePreviewCss(skinOf(BUBBLES[0]), '.probe');
    const [, padR] = paddingOf(css);
    // 149 本体可见区在源图 x=20..107，中心 63.5；0.6 比例给出 ≈21.9px。
    expect(padR).toBeCloseTo(21.9, 1);
    expect(padR).toBeLessThan(25);
  });

  it('三款横向内边距收敛到同一档（老公式下有 5px 落差，观感差得最明显）', () => {
    const pads = BUBBLES.map((b) => paddingOf(bubblePreviewCss(skinOf(b), '.probe'))[1]);
    const spread = Math.max(...pads) - Math.min(...pads);
    // 老公式：36.5 / 34 / 31.5 → 落差 5px；新公式 21.9 / 20.4 / 18.9 → 落差 3px。
    expect(spread).toBeLessThan(3.5);
  });

  it('有权威 npTc padding 的款，0.6 比例与官方值的偏差在 2px 以内', () => {
    for (const b of BUBBLES) {
      if (!b.npTcPad) continue;
      const [, padR] = paddingOf(bubblePreviewCss(skinOf(b), '.probe'));
      const official = b.npTcPad.r * SCALE;
      expect(Math.abs(padR - official)).toBeLessThan(2);
    }
  });
});
