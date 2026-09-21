/**
 * 字体炫彩帧（`eimg`）的分组单测。
 *
 * 帧图是 nt_helper 从 `eimg` 表里逐槽位导出来的（`frame_<槽位>.png`），而一款字体里
 * 往往存着**好几段画布尺寸不同的动画**（客户端按文字占几行挑一段播）——实测 20405 的
 * 109 帧是 350×141×15 / 350×76×21 / 350×49×15 / 350×82×28 / 350×109×30 五段连续块。
 * 分组错了就是「五段动画混着依次播」的一团乱，而它在界面上只是「看着怪」，不会报错，
 * 所以把这条约定钉在这里：
 *
 *  - 按**槽位号**排序（非 PNG 槽位会被跳过，编号因此有洞；字符串排序在 999/1000 这种
 *    位数不同时也会错）；
 *  - 尺寸相同且**连续**的归一段，尺寸一变就开新段；
 *  - 读不出尺寸的帧（截断/非 PNG）忽略，不把整段带塌；
 *  - 目录不存在 / 一帧都没解出来 → null（渲染侧据此完全不播）。
 *
 * 这里只写 PNG 头 24 字节 —— 分组只用 IHDR 的宽高（见 zip.ts 的 pngSize）。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readFontFx } from '../src/account/dress_shared_cache';

/** 只够 pngSize 用的最小 PNG：签名 + IHDR 长度/类型 + 宽高。 */
function pngHead(w: number, h: number): Buffer {
  const b = Buffer.alloc(24);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

const dirs: string[] = [];

function makeDir(frames: Array<[slot: number, size: [number, number] | null]>): string {
  const dir = mkdtempSync(join(tmpdir(), 'weq-fontfx-'));
  dirs.push(dir);
  for (const [slot, size] of frames) {
    const name = join(dir, `frame_${String(slot).padStart(3, '0')}.png`);
    writeFileSync(name, size ? pngHead(size[0], size[1]) : Buffer.from('not a png'));
  }
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('readFontFx', () => {
  it('尺寸连续相同的归一段，尺寸一变就开新段', () => {
    const dir = makeDir([
      [0, [350, 141]],
      [1, [350, 141]],
      [2, [350, 76]],
      [3, [350, 76]],
      [4, [350, 76]],
      [5, [350, 49]],
    ]);

    expect(readFontFx(dir)).toEqual({
      variants: [
        { width: 350, height: 141, frames: [0, 1] },
        { width: 350, height: 76, frames: [2, 3, 4] },
        { width: 350, height: 49, frames: [5] },
      ],
    });
  });

  it('按槽位号排序而不是文件名（跳过非 PNG 后编号是有洞的）', () => {
    // 9 / 10 / 100 三个槽位：字典序会排成 10 < 100 < 9，槽位序才是 9 < 10 < 100。
    const dir = makeDir([
      [100, [10, 10]],
      [9, [10, 10]],
      [10, [10, 10]],
    ]);

    expect(readFontFx(dir)?.variants).toEqual([{ width: 10, height: 10, frames: [9, 10, 100] }]);
  });

  it('读不出尺寸的帧忽略，但不影响同段其余帧', () => {
    const dir = makeDir([
      [0, [20, 20]],
      [1, null],
      [2, [20, 20]],
    ]);

    expect(readFontFx(dir)?.variants).toEqual([{ width: 20, height: 20, frames: [0, 2] }]);
  });

  it('目录不存在 / 没有可用的帧 → null（渲染侧据此不播）', () => {
    expect(readFontFx(join(tmpdir(), 'weq-fontfx-does-not-exist'))).toBeNull();
    expect(readFontFx(makeDir([[0, null]]))).toBeNull();
  });
});
