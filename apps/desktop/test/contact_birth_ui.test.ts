import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ContactBirthdayRow } from '../src/renderer/src/components/ContactBirthdayRow';
import { contactBirth } from '../src/renderer/src/lib/contactBirth';

afterEach(() => vi.unstubAllGlobals());

it.each([
  [
    { age: 16, extInfo: { constellation: 1 } },
    '2010年（推断） · 水瓶座',
    '推断生日：2010年1月20日至2月18日',
  ],
  [
    { birthYear: 2010, birthDay: 25, extInfo: { constellation: 1 } },
    '2010年 · 水瓶座',
    '推断生日：2010年1月25日',
  ],
  [
    { birthYear: 1905, extInfo: { constellation: 2 } },
    '1905年 · 双鱼座',
    '推断生日：1905年2月19日至3月20日',
  ],
  [{ extInfo: { constellation: 1 } }, '水瓶座', '推断生日：1月20日至2月18日'],
  [
    { birthYear: 2010, age: 40, extInfo: { constellation: 12 } },
    '2010年 · 摩羯座',
    '星座与现有生日或年龄资料不一致，未采用推断结果',
  ],
] as const)(
  '生日详情内联可展开，原始资料及排序边界不伪装成完整生日：%j',
  (profile, summary, detail) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    try {
      const birth = contactBirth(profile, new Date('2026-11-11T12:00:00+08:00'));
      act(() => root.render(h(ContactBirthdayRow, { birth })));
      expect(host.querySelector('summary')?.textContent).toBe(summary);
      expect(host.textContent).not.toContain('月日未记录');
      expect(host.textContent).not.toContain('候选生日');
      expect(host.querySelector('p')?.textContent).toBe(detail);
      expect(host.querySelector('[aria-label^="生日详情："]')?.getAttribute('aria-label')).toBe(
        `生日详情：${summary}`,
      );
      expect(host.querySelector('details')?.open).toBe(false);
      expect(host.querySelector('[data-privacy-sensitive]')).not.toBeNull();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  },
);

it('完整生日仍直接展示，不出现推断详情', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    act(() =>
      root.render(
        h(ContactBirthdayRow, {
          birth: contactBirth({ birthYear: 2010, birthMonth: 1, birthDay: 20 }),
        }),
      ),
    );
    expect(host.textContent).toBe('生日2010年1月20日');
    expect(host.querySelector('details')).toBeNull();
  } finally {
    act(() => root.unmount());
  }
});
