import { act, createElement as h, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TabActivity } from '../src/renderer/src/components/RetainedTabs';
import { RetainedSettingsPage } from '../src/renderer/src/components/settings/RetainedSettingsPage';
import type { ResolvedSettingsTarget } from '../src/renderer/src/components/settings/navigation';
import { SETTINGS_SEARCH_HIGHLIGHT_MS } from '../src/renderer/src/components/settings/searchTarget';

vi.mock('../src/renderer/src/components/settings/SettingsReset', () => ({
  SettingsResetProvider: ({ children }: { children: ReactNode }) => children,
}));

const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function fixture() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = ({ revision = 1, active = true, settingId = 'mail-unread-badge' } = {}) =>
    act(() =>
      root.render(
        h(
          TabActivity,
          { active },
          h(
            RetainedSettingsPage,
            {
              pageId: 'global',
              target: { section: 'global', settingId } satisfies ResolvedSettingsTarget,
              revision,
            },
            h(
              'div',
              { 'data-setting-id': 'mail-unread-badge' },
              h('button', { type: 'button' }, '邮箱红点'),
            ),
          ),
        ),
      ),
    );
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  render();
  return { host, render, row: host.querySelector<HTMLElement>('[data-setting-id]')! };
}

describe('设置定位高亮生命周期', () => {
  it('同一跳转目标持续重渲染也在原定时间消退，消退后不重新高亮', () => {
    const f = fixture();
    expect(f.row.dataset.searchHighlight).toBe('true');
    for (let frame = 0; frame < 4; frame++) {
      act(() => vi.advanceTimersByTime(SETTINGS_SEARCH_HIGHLIGHT_MS / 4));
      f.render();
    }
    expect(f.row.hasAttribute('data-search-highlight')).toBe(false);
    f.render();
    expect(f.row.hasAttribute('data-search-highlight')).toBe(false);
  });

  it('新的跳转 revision 重新定位并重新计时，普通刷新不抢焦点', () => {
    const f = fixture();
    act(() => vi.advanceTimersByTime(SETTINGS_SEARCH_HIGHLIGHT_MS));
    const other = document.createElement('button');
    f.host.append(other);
    other.focus();
    f.render();
    expect(document.activeElement).toBe(other);
    expect(f.row.hasAttribute('data-search-highlight')).toBe(false);
    f.render({ revision: 2 });
    expect(f.row.dataset.searchHighlight).toBe('true');
    expect(document.activeElement).toBe(f.row.querySelector('button'));
    act(() => vi.advanceTimersByTime(SETTINGS_SEARCH_HIGHLIGHT_MS));
    expect(f.row.hasAttribute('data-search-highlight')).toBe(false);
  });

  it('失活后立即清除高亮与计时，切换到另一个目标不留下旧高亮', () => {
    const f = fixture();
    f.render({ active: false });
    expect(f.row.hasAttribute('data-search-highlight')).toBe(false);
    f.render();
    expect(f.row.dataset.searchHighlight).toBe('true');
    f.render({ settingId: 'other-setting' });
    expect(f.row.hasAttribute('data-search-highlight')).toBe(false);
    act(() => vi.advanceTimersByTime(SETTINGS_SEARCH_HIGHLIGHT_MS));
    expect(f.row.hasAttribute('data-search-highlight')).toBe(false);
  });
});
