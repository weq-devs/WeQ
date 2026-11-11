import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ContactBirthdayRow } from '../src/renderer/src/components/ContactBirthdayRow';
import { contactBirth } from '../src/renderer/src/lib/contactBirth';

afterEach(() => vi.unstubAllGlobals());

it.each([
  [{ age: 16, extInfo: { constellation: 1 } }, '2010 年（推断）', '候选生日'],
  [{ birthYear: 2010, birthDay: 25, extInfo: { constellation: 1 } }, '2010 年', '推断生日'],
  [{ birthYear: 2010, age: 40, extInfo: { constellation: 12 } }, '摩羯座', '不一致'],
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
      expect(host.querySelector('summary')?.textContent).toContain(summary);
      expect(host.querySelector('summary')?.textContent).toContain('月日未记录');
      expect(host.querySelector('p')?.textContent).toContain(detail);
      expect(
        host.querySelector('[aria-label^="生日详情："]')?.getAttribute('aria-label'),
      ).toContain(summary);
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
    expect(host.textContent).toBe('生日2010 年 1 月 20 日');
    expect(host.querySelector('details')).toBeNull();
  } finally {
    act(() => root.unmount());
  }
});
