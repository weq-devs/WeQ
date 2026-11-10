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
  expect(contactBirth(profile, now)).toMatchObject({ age: null, ageOrder: null });
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
