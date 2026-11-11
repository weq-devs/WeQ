import { expect, it } from 'vitest';
import {
  QQ_PROFESSIONS,
  occupationText,
  bloodTypeText,
  chineseZodiacText,
  profileTimeSeconds,
  profileTimeText,
} from '../src/profile-values';

it('编辑目录与尚未核实的缓存编号分开，未知值保真', () => {
  expect(QQ_PROFESSIONS.find((item) => item.value === 13)?.label).toBe('学生');
  expect(occupationText(13)).toBe('职业（编号 13）');
  expect(occupationText(900)).toBe('职业（编号 900）');
  expect(bloodTypeText(5)).toBe('血型（编号 5）');
  expect(chineseZodiacText(1)).toBe('鼠');
  expect(chineseZodiacText(12)).toBe('猪');
  expect(chineseZodiacText(20)).toBe('生肖（编号 20）');
  for (const bad of [undefined, null, 0, -1, 1.5, NaN, Infinity, '13']) {
    expect(occupationText(bad)).toBeNull();
    expect(bloodTypeText(bad)).toBeNull();
    expect(chineseZodiacText(bad)).toBeNull();
  }
});

it('Unix 秒使用北京时间并保留秒，不猜测毫秒或非法日期', () => {
  const seconds = Date.parse('2026-11-10T16:01:02Z') / 1000;
  expect(profileTimeText(seconds)).toBe('2026-11-11 00:01:02');
  for (const bad of [0, -1, NaN, Infinity, 1.5, seconds * 1000, Number.MAX_SAFE_INTEGER]) {
    expect(profileTimeSeconds(bad)).toBeNull();
    expect(profileTimeText(bad)).toBeNull();
  }
});
