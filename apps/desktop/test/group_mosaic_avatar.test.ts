/**
 * 克隆群合成头像的铺格规则。
 *
 * 回归点：早先 3 个成员按 2×2 排，右下角空掉一格；少人数（2/3/4）也没有专门铺满。
 */

import { expect, it } from 'vitest';
import { mosaicLayout } from '../src/renderer/src/components/GroupMosaicAvatar';

it('单图 / 两人并排 / 三四人铺满 2×2', () => {
  expect(mosaicLayout(0)).toEqual({ columns: 1, rows: 1 });
  expect(mosaicLayout(1)).toEqual({ columns: 1, rows: 1 });
  expect(mosaicLayout(2)).toEqual({ columns: 2, rows: 1 });
  // 3 人时首张跨两行，格数正好等于人数，不再空一角。
  expect(mosaicLayout(3)).toEqual({ columns: 2, rows: 2 });
  expect(mosaicLayout(4)).toEqual({ columns: 2, rows: 2 });
});

it('五人以上切三列，最多 3 行、9 格', () => {
  expect(mosaicLayout(5)).toEqual({ columns: 3, rows: 2 });
  expect(mosaicLayout(6)).toEqual({ columns: 3, rows: 2 });
  expect(mosaicLayout(7)).toEqual({ columns: 3, rows: 3 });
  expect(mosaicLayout(9)).toEqual({ columns: 3, rows: 3 });
  expect(mosaicLayout(20)).toEqual({ columns: 3, rows: 3 });
});
