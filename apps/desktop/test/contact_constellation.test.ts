import { expect, it } from 'vitest';
import {
  cachedConstellation,
  constellationFromBirthday,
} from '../src/renderer/src/lib/contactConstellation';

it.each([
  [1, '水瓶座', 1, 20, 2, 18],
  [2, '双鱼座', 2, 19, 3, 20],
  [3, '白羊座', 3, 21, 4, 19],
  [4, '金牛座', 4, 20, 5, 20],
  [5, '双子座', 5, 21, 6, 21],
  [6, '巨蟹座', 6, 22, 7, 22],
  [7, '狮子座', 7, 23, 8, 22],
  [8, '处女座', 8, 23, 9, 22],
  [9, '天秤座', 9, 23, 10, 23],
  [10, '天蝎座', 10, 24, 11, 22],
  [11, '射手座', 11, 23, 12, 21],
  [12, '摩羯座', 12, 22, 1, 19],
] as const)('缓存编号 %s 与既有星座分界 %s 一致', (id, name, sm, sd, em, ed) => {
  // 射手座开始日沿用仓库原来的 11 月 23 日分界。
  expect(cachedConstellation(id)?.name).toBe(name);
  expect(constellationFromBirthday(sm, sd)?.id).toBe(id);
  expect(constellationFromBirthday(em, ed)?.id).toBe(id);
});

it('摩羯座年初与年末均可定位，非法月日不匹配星座', () => {
  expect(constellationFromBirthday(1, 1)?.id).toBe(12);
  expect(constellationFromBirthday(12, 31)?.id).toBe(12);
  expect(constellationFromBirthday(2, 29)?.id).toBe(2);
  expect(constellationFromBirthday(2, 30)).toBeNull();
  expect(constellationFromBirthday(13, 1)).toBeNull();
});
