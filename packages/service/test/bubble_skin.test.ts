import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bubbleConfigMetadata,
  buildLocalBubbleSkin,
  readBubbleGeometry,
} from '../src/account/bubble_skin';
import { ninePatch } from './support/nine_patch';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('手机气泡几何', () => {
  it.each([
    // 真实 npTc 几何：149 和 2179288；预期值不从旧切片公式产生。
    [[76, 77], [49, 50], { left: 76, right: 51, top: 49, bottom: 62 }],
    [[63, 65], [55, 57], { left: 63, right: 63, top: 55, bottom: 55 }],
  ] as const)('保留完整 1px / 2px 拉伸区：%j %j', (x, y, slice) => {
    expect(readBubbleGeometry(ninePatch(128, 112, x, y))).toEqual({
      imageSize: { w: 128, h: 112 },
      slice,
    });
  });

  it('配置 zoom_point 分支构造 1px 中段，无效配置回退原图端点', () => {
    const png = ninePatch(128, 112, [63, 65], [55, 57]);
    expect(readBubbleGeometry(png, [64, 56])?.slice).toEqual({
      left: 64,
      right: 63,
      top: 56,
      bottom: 55,
    });
    expect(readBubbleGeometry(png, [128, -1])).toEqual(readBubbleGeometry(png));
  });

  it('拒绝截断、倒序、越界、奇数或多段端点，不用恒等式自证几何', () => {
    const png = ninePatch(128, 112, [63, 65], [55, 57]);
    expect(readBubbleGeometry(png.subarray(0, 60))).toBeNull();
    for (const [x, y] of [
      [
        [65, 63],
        [55, 57],
      ],
      [
        [63, 129],
        [55, 57],
      ],
      [[63], [55]],
      [
        [20, 21, 60, 61],
        [55, 57],
      ],
    ])
      expect(readBubbleGeometry(ninePatch(128, 112, x!, y!))).toBeNull();
  });

  it('解析官方正文色、链接色与配置拉伸点并进入完整 skin', () => {
    const config = bubbleConfigMetadata({
      color: '0xFF112233',
      link_color: '0xFF445566',
      zoom_point: ['63', 55],
    });
    const dir = mkdtempSync(join(tmpdir(), 'weq-bubble-skin-'));
    dirs.push(dir);
    const pngPath = join(dir, 'bubble.png');
    writeFileSync(pngPath, ninePatch(128, 112, [63, 65], [55, 57]));
    expect(buildLocalBubbleSkin({ itemId: 1, pngPath, ...config })).toMatchObject({
      configuredPatch: true,
      textColor: 'rgb(17 34 51)',
      linkColor: 'rgb(68 85 102)',
      slice: { left: 63, right: 64, top: 55, bottom: 56 },
    });
    expect(
      buildLocalBubbleSkin({ itemId: 1, pngPath, zoomPoint: [128, 55] })?.configuredPatch,
    ).toBeUndefined();
    expect(
      bubbleConfigMetadata({ link_color: 'invalid', zoom_point: [-1, 2] }).linkColor,
    ).toBeUndefined();
    expect(bubbleConfigMetadata({ zoom_point: ['', '55'] }).zoomPoint).toBeUndefined();
  });
});
