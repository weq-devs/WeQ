import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ContactBirthdayRow } from '../src/renderer/src/components/ContactBirthdayRow';
import { contactBirth, type BirthProfile } from '../src/renderer/src/lib/contactBirth';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function renderBirth(profile: BirthProfile) {
  const birth = contactBirth(profile, new Date('2026-11-11T12:00:00+08:00'));
  act(() => root.render(h(ContactBirthdayRow, { birth })));
}

it.each([
  [{ age: 16, extInfo: { constellation: 1 } }, '', '2010 年 1 月 20 日至 2 月 18 日'],
  [{ birthYear: 2010, birthDay: 25, extInfo: { constellation: 1 } }, '2010 年', '1 月 25 日'],
  [{ birthYear: 1905, extInfo: { constellation: 2 } }, '1905 年', '2 月 19 日至 3 月 20 日'],
  [{ extInfo: { constellation: 1 } }, '', '1 月 20 日至 2 月 18 日'],
] as const)('单个推算结果直接显示并标明来源：%j', (profile, recorded, range) => {
  renderBirth(profile);
  expect(host.textContent).toBe(`生日${recorded}${range} 按星座推算`);
  expect(host.querySelector('summary')).toBeNull();
  expect(host.querySelector('[data-privacy-sensitive]')?.textContent).toContain(range);
});

it('多个候选范围可通过查看可能日期展开', () => {
  renderBirth({ birthYear: 2010, extInfo: { constellation: 12 } });
  const details = host.querySelector('details');
  expect(details?.open).toBe(false);
  expect(details?.querySelector('summary')?.textContent).toBe('查看可能日期');
  expect(details?.textContent).toContain('1 月 1 日至 1 月 19 日');
  expect(details?.textContent).toContain('12 月 22 日至 12 月 31 日');
});

it('推算冲突时显示已知日期和原因', () => {
  renderBirth({ birthYear: 2010, age: 40, extInfo: { constellation: 12 } });
  expect(host.textContent).toBe('生日2010 年星座与现有生日或年龄资料不一致，未采用推断结果');
});

it.each([
  [{ birthYear: 2010, birthMonth: 1, birthDay: 20 }, '生日2010-01-20'],
  [{ birthMonth: 1, birthDay: 20 }, '生日1 月 20 日'],
  [{ age: 16 }, ''],
] as const)('按已有生日精度显示，无日期时省略：%j', (profile, text) => {
  renderBirth(profile);
  expect(host.textContent).toBe(text);
  expect(host.querySelector('summary')).toBeNull();
});
