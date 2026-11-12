// @vitest-environment node
import { expect, it } from 'vitest';
import { educationDegree } from '../src/renderer/src/lib/profileEducation';

// Android QQ 9.3.75 PersonalInfoComponent.getDegreeName 及对应资源，非按学历顺序推算。
it.each([
  [1, '小学'],
  [2, '中学'],
  [3, '中学'],
  [4, '中专'],
  [5, '大专'],
  [6, '本科'],
  [7, '研究生'],
  [8, '博士'],
  [9, '博士后'],
])('学历编号 %i 显示为 %s', (value, label) => {
  expect(educationDegree(value)).toBe(label);
});

it('未填写学历不展示，未知编号保留原始值', () => {
  expect(educationDegree(null)).toBeNull();
  expect(educationDegree(0)).toBeNull();
  expect(educationDegree(77)).toBe('学历编号 77');
});
