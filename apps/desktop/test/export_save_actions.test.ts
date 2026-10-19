import { act, createElement as h, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ExportSaveActions } from '../src/renderer/src/components/ExportSaveActions';

vi.mock('../src/renderer/src/components/OverlayLayer', () => ({
  OverlayLayer: ({ children }: { children: ReactNode }) => children,
}));
afterEach(() => vi.unstubAllGlobals());
it('保存菜单只发出本次意图，关闭菜单后可再次选择，不提供全局默认配置', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host),
    select = vi.fn();
  try {
    act(() => root.render(h(ExportSaveActions, { onSelect: select })));
    for (const label of ['另存到…', '先生成，稍后保存']) {
      act(() => host.querySelector<HTMLButtonElement>('[aria-label="本次保存选项"]')!.click());
      const button = [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
        (node) => node.textContent === label,
      )!;
      expect(button).toBeDefined();
      act(() => button.click());
      expect(host.querySelector('[role="menu"]')).toBeNull();
    }
    expect(select.mock.calls).toEqual([[{ mode: 'before' }], [{ mode: 'after' }]]);
    expect(host.querySelector('fieldset')).toBeNull();
    act(() => root.render(h(ExportSaveActions, { disabled: true, onSelect: select })));
    expect(host.querySelector<HTMLButtonElement>('[aria-label="本次保存选项"]')!.disabled).toBe(
      true,
    );
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
