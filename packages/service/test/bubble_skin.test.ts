/**
 * 气泡九宫格切片（`.9.png` 的 npTc）解析单测。
 *
 * 这里钉住的是一条**渲染正确性**约定：npTc 只给 2px 拉伸源，直接横拉 8~9 倍铺满中段
 * 会被插值抹成一条平滑竖条，和左右两角 0.5 倍缩放的颗粒在交界处对不上（看起来就是两条
 * 竖缝，一个字的消息最明显）。所以 {@link buildLocalBubbleSkin} 会把拉伸源单边加宽
 * {@link MIDDLE_GROW_PX} 像素，并按切片大小限一个 1/8 —— 渲染侧 width = slice × scale，
 * 边条因此仍是 0.5 倍自然缩放（贴图不变，只有中段的拉伸倍率降下来）。
 *
 * 只用最小 PNG：签名 + IHDR（给 pngSize 读宽高）+ npTc + IEND。切片解析只走 chunk 表，
 * 不需要真的像素数据。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildLocalBubbleSkin } from '../src/account/bubble_skin';

/**
 * 造一张只有几何信息的 `.9.png`。npTc 里存的就是 config.json 的 zoomPoint（实测 2116371
 * 那张存 67，解析后 +1 得到 68，对应 slice.left = 67）。
 */
function fakeNinePatch(
  w: number,
  h: number,
  zoomX: number,
  zoomY: number,
  withNpTc = true,
): Buffer {
  // chunk = 4 长度 + 4 类型 + 数据 + 4 CRC（CRC 不校验，留零）。
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(4 + 4 + 13 + 4);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'latin1');
  ihdr.writeUInt32BE(w, 8);
  ihdr.writeUInt32BE(h, 12);

  const iend = Buffer.alloc(12);
  iend.write('IEND', 4, 'latin1');
  if (!withNpTc) return Buffer.concat([signature, ihdr, iend]);

  // Android npTc 的头部：wasDeserialized / numXDivs / numYDivs / numColors，
  // 之后是 div 表（这里只填解析用得上的 x/y 两点）。
  const npTc = Buffer.alloc(4 + 4 + 84 + 4);
  npTc.writeUInt32BE(84, 0);
  npTc.write('npTc', 4, 'latin1');
  const body = 8;
  npTc.writeUInt8(0, body + 0);
  npTc.writeUInt8(1, body + 1);
  npTc.writeUInt8(1, body + 2);
  npTc.writeUInt8(0, body + 3);
  npTc.writeInt32BE(zoomX, body + 32);
  npTc.writeInt32BE(zoomY, body + 4 * 1 + 32);

  return Buffer.concat([signature, ihdr, npTc, iend]);
}

const dirs: string[] = [];

function skinOf(png: Buffer, itemId = 1) {
  const dir = mkdtempSync(join(tmpdir(), 'weq-bubble-skin-'));
  dirs.push(dir);
  const path = join(dir, 'aio_user_bg_nor.9.png');
  writeFileSync(path, png);
  return buildLocalBubbleSkin({ itemId, pngPath: path });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('buildLocalBubbleSkin', () => {
  it('把 2px 拉伸源单边加宽 3px（第五人格 2116371 那张的几何）', () => {
    const skin = skinOf(fakeNinePatch(128, 112, 67, 67));
    expect(skin?.imageSize).toEqual({ w: 128, h: 112 });
    // npTc：left 67 / top 67 / right 59 / bottom 43 → min 43，1/8 = 5，取上限 3。
    expect(skin?.slice).toEqual({ left: 64, top: 64, right: 56, bottom: 40 });
  });

  it('切片很小时按 1/8 收敛，不吃进边条里的装饰', () => {
    // 40×40、npTc 存 18：slice = {18,18,20,20} → min 18，1/8 = 2。
    const skin = skinOf(fakeNinePatch(40, 40, 18, 18));
    expect(skin?.slice).toEqual({ left: 16, top: 16, right: 18, bottom: 18 });
  });

  it('切片已经小到不能再吃时保持原值', () => {
    // 16×16、npTc 存 6：slice = {6,6,8,8} → min 6，1/8 = 0。
    const skin = skinOf(fakeNinePatch(16, 16, 6, 6));
    expect(skin?.slice).toEqual({ left: 6, top: 6, right: 8, bottom: 8 });
  });

  it('没有 npTc 的图直接放弃（宁可不渲染也不切错）', () => {
    expect(skinOf(fakeNinePatch(128, 112, 67, 67, false))).toBeNull();
  });
});
