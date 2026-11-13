import { afterEach, expect, it, vi } from 'vitest';
import { contactAgeText, contactBirth } from '../src/renderer/src/lib/contactBirth';

afterEach(() => vi.useRealTimers());
const now = new Date('2026-11-10T00:00:00+08:00');

it('有效原始年龄优先显示，完整生日单独决定精确排序值', () => {
  expect(
    contactBirth({ age: 23, birthYear: 2000, birthMonth: 2, birthDay: 29 }, now),
  ).toMatchObject({
    age: 23,
    ageOrder: -20000229,
  });
});

it.each([undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2.5])(
  '无效或缺失年龄 %s 使用完整生日补全',
  (age) => {
    expect(contactBirth({ age, birthYear: 2000, birthMonth: 11, birthDay: 10 }, now).age).toBe(26);
  },
);

it.each([
  { birthYear: 2001, birthMonth: 2, birthDay: 29 },
  { birthYear: 2000, birthMonth: 4, birthDay: 31 },
  { birthYear: 2000, birthMonth: 13, birthDay: 1 },
  { birthYear: 2000, birthMonth: 0, birthDay: 1 },
  { birthYear: 2000, birthMonth: 2, birthDay: 0 },
  { birthYear: 2000, birthMonth: 2, birthDay: 1.5 },
  { birthYear: 2000, birthMonth: 2 },
  { birthYear: 2000 },
  { birthMonth: 2, birthDay: 29 },
  { birthYear: 1899, birthMonth: 2, birthDay: 1 },
  { birthYear: 2026, birthMonth: 11, birthDay: 11 },
])('不从不完整、无效或未来生日推算年龄：%j', (profile) => {
  expect(contactBirth(profile, now).age).toBeNull();
});

it.each([
  [25, -20001232],
  [26, -20000100],
  [18, -20000100],
  [undefined, -20000100],
  [0, -20000100],
] as const)('只有出生年份时，年龄 %s 决定年末或年初排序占位，不改显示资料', (age, ageOrder) => {
  expect(contactBirth({ birthYear: 2000, age }, now)).toMatchObject({
    year: 2000,
    month: null,
    day: null,
    age: age && age > 0 ? age : null,
    ageOrder,
  });
});

it('年初年末占位严格排在该年全部真实日期两侧，未来年份不作为有效排序年份', () => {
  const first = contactBirth({ birthYear: 2000, birthMonth: 1, birthDay: 1 }, now).ageOrder!;
  const last = contactBirth({ birthYear: 2000, birthMonth: 12, birthDay: 31 }, now).ageOrder!;
  expect(contactBirth({ birthYear: 2000, age: 26 }, now).ageOrder).toBeGreaterThan(first);
  expect(contactBirth({ birthYear: 2000, age: 25 }, now).ageOrder).toBeLessThan(last);
  expect(contactBirth({ birthYear: 2027 }, now).ageOrder).toBeNull();
  expect(contactBirth({ birthYear: 2026, birthMonth: 11, birthDay: 11 }, now).ageOrder).toBeNull();
});

it('闰日出生在非闰年的三月一日增长周岁，生日当天出生可显示零岁', () => {
  const leap = { birthYear: 2000, birthMonth: 2, birthDay: 29 };
  expect(contactBirth(leap, new Date('2026-02-28T15:59:59Z')).age).toBe(25);
  expect(contactBirth(leap, new Date('2026-02-28T16:00:00Z')).age).toBe(26);
  expect(contactBirth({ birthYear: 2026, birthMonth: 11, birthDay: 10 }, now).age).toBe(0);
});

it('名片年龄共用推算规则，推算值无额外标记，未知显示问号', () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  expect(contactAgeText({ birthYear: 2000, birthMonth: 11, birthDay: 10 })).toBe('26 岁');
  expect(contactAgeText({ age: 26 })).toBe('26 岁');
  expect(contactAgeText({ birthYear: 2000 })).toBe('?? 岁');
});

const inferenceNow = new Date('2026-11-11T12:00:00+08:00');
const capricorn = { constellation: 12 };

it.each([
  [16, [{ year: 2010, start: 101, end: 119 }], -20100101, 101],
  [15, [{ year: 2010, start: 1222, end: 1231 }], -20101222, 1222],
] as const)(
  '出生年、摩羯座及 %s 周岁共同收窄日期，不改原始资料',
  (age, ranges, ageOrder, birthdayOrder) => {
    const profile = { birthYear: 2010, age, extInfo: capricorn };
    const before = structuredClone(profile);
    expect(contactBirth(profile, inferenceNow)).toMatchObject({
      year: 2010,
      month: null,
      day: null,
      age,
      inference: 'range',
      ranges,
      ageOrder,
      birthdayOrder,
      inferredYear: null,
      constellation: { id: 12, name: '摩羯座' },
    });
    expect(profile).toEqual(before);
  },
);

it('摩羯座保留两个同年区段，不能补成跨出生年份的连续范围', () => {
  expect(contactBirth({ birthYear: 2010, extInfo: capricorn }, inferenceNow)).toMatchObject({
    ranges: [
      { year: 2010, start: 101, end: 119 },
      { year: 2010, start: 1222, end: 1231 },
    ],
    age: null,
    inferredYear: null,
    birthdayOrder: 101,
  });
});

it('只有年龄和摩羯座时保留两个可能出生年份，年度排序固定使用年初入口', () => {
  expect(contactBirth({ age: 16, extInfo: capricorn }, inferenceNow)).toMatchObject({
    year: null,
    inferredYear: null,
    ranges: [
      { year: 2009, start: 1222, end: 1231 },
      { year: 2010, start: 101, end: 119 },
    ],
    ageOrder: -20091222,
    birthdayOrder: 101,
  });
});

it('年龄和水瓶座限定唯一出生年，单独返回推断年份', () => {
  expect(contactBirth({ age: 16, extInfo: { constellation: 1 } }, inferenceNow)).toMatchObject({
    year: null,
    inferredYear: 2010,
    ranges: [{ year: 2010, start: 120, end: 218 }],
    ageOrder: -20100120,
    birthdayOrder: 120,
  });
});

it('既无年份也无年龄时只提供年度区段，不推算年龄', () => {
  expect(contactBirth({ extInfo: { constellation: 1 } }, inferenceNow)).toMatchObject({
    inferredYear: null,
    age: null,
    ageOrder: null,
    ranges: [{ year: null, start: 120, end: 218 }],
    birthdayOrder: 120,
  });
});

it('合法的部分月份、日号参与求交，唯一日期仍单独标注为推断', () => {
  expect(
    contactBirth({ birthYear: 2010, birthMonth: 1, extInfo: capricorn }, inferenceNow).ranges,
  ).toEqual([{ year: 2010, start: 101, end: 119 }]);
  expect(
    contactBirth({ birthYear: 2010, birthDay: 25, extInfo: { constellation: 1 } }, inferenceNow),
  ).toMatchObject({
    inference: 'exact',
    inferredDate: 20100125,
    ranges: [{ year: 2010, start: 125, end: 125 }],
    month: null,
    day: null,
  });
});

it.each([
  { birthYear: 2010, age: 40, extInfo: capricorn },
  { birthYear: 2010, birthMonth: 6, extInfo: capricorn },
  { birthYear: 2001, birthMonth: 2, birthDay: 29, extInfo: { constellation: 2 } },
  { birthYear: 2027, extInfo: capricorn },
])('冲突或未来年份不覆盖明确资料，回退旧排序：%j', (profile) => {
  const legacy = contactBirth({ ...profile, extInfo: undefined }, inferenceNow);
  expect(contactBirth(profile, inferenceNow)).toMatchObject({
    inference: 'conflict',
    ranges: [],
    inferredYear: null,
    ageOrder: legacy.ageOrder,
    birthdayOrder: legacy.birthdayOrder,
  });
});

it.each([0, 13, -1, 1.5, Number.NaN])('非法星座 %s 不改变原有生日排序', (constellation) => {
  expect(
    contactBirth({ birthYear: 2010, age: 16, extInfo: { constellation } }, inferenceNow),
  ).toMatchObject({ inference: 'none', ranges: [], ageOrder: -20100100, birthdayOrder: null });
});

it('完整月日优先于缓存星座，缺年份也不追加旧算法没有的反推', () => {
  expect(
    contactBirth({ age: 16, birthMonth: 6, birthDay: 1, extInfo: capricorn }, inferenceNow),
  ).toMatchObject({
    inference: 'none',
    inferredYear: null,
    birthdayOrder: 601,
    ageOrder: -20101111,
    constellation: { id: 5, name: '双子座' },
  });
});

it('完整出生日期不被冲突的年龄或缓存星座改写', () => {
  expect(
    contactBirth(
      { age: 40, birthYear: 2010, birthMonth: 1, birthDay: 1, extInfo: { constellation: 1 } },
      inferenceNow,
    ),
  ).toMatchObject({
    inference: 'none',
    ranges: [],
    inferredYear: null,
    year: 2010,
    month: 1,
    day: 1,
    age: 40,
    ageOrder: -20100101,
    constellation: { id: 12, name: '摩羯座' },
  });
});

it('年龄约束按北京时间跨日，闰日继续在非闰年三月一日增长周岁', () => {
  const profile = { birthYear: 2000, birthMonth: 2, age: 26, extInfo: { constellation: 2 } };
  expect(contactBirth(profile, new Date('2026-02-28T15:59:59Z')).ranges).toEqual([
    { year: 2000, start: 219, end: 228 },
  ]);
  expect(contactBirth(profile, new Date('2026-02-28T16:00:00Z')).ranges).toEqual([
    { year: 2000, start: 219, end: 229 },
  ]);
});
