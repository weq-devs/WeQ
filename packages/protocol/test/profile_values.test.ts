import { expect, it } from 'vitest';
import {
  QQ_PROFESSIONS,
  occupationText,
  bloodTypeText,
  chineseZodiacText,
  profileTimeSeconds,
  profileTimeText,
} from '../src/profile-values';

it('职业缓存显示 QQ 职业目录名称，目录外编号保真', () => {
  expect(QQ_PROFESSIONS.find((item) => item.value === 13)?.label).toBe('学生');
  expect(occupationText(1)).toBe('计算机／互联网／通信');
  expect(occupationText(13)).toBe('学生');
  expect(occupationText(14)).toBe('其他职业');
  for (const item of QQ_PROFESSIONS) expect(occupationText(item.value)).toBe(item.label);
  expect(occupationText(15)).toBe('职业（编号 15）');
  expect(occupationText(900)).toBe('职业（编号 900）');
});

it('血型按 QQ 枚举显示，O 型与 AB 型不按字母顺序错位', () => {
  expect([1, 2, 3, 4, 5].map(bloodTypeText)).toEqual(['A型', 'B型', 'O型', 'AB型', '其他']);
  expect(bloodTypeText(6)).toBe('血型（编号 6）');
  expect(bloodTypeText(900)).toBe('血型（编号 900）');
});

it('生肖及空值保持原有语义，不将数字字符串或非法编号当作资料', () => {
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
