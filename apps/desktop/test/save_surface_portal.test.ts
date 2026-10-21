import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ServerSavePrompt } from '../src/renderer/src/components/ServerSavePrompt';
import { ExportSaveActions } from '../src/renderer/src/components/ExportSaveActions';
afterEach(() => vi.unstubAllGlobals());
function fixture() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div'),
    portal = document.createElement('div');
  document.body.append(host, portal);
  const root = createRoot(host);
  return {
    root,
    host,
    portal,
    close: () => {
      act(() => root.unmount());
      host.remove();
      portal.remove();
    },
  };
}
it.each([false, true])('服务器位置弹窗按指定宿主挂载，全屏宿主=%s', (scoped) => {
  const view = fixture(),
    choose = vi.fn();
  try {
    act(() =>
      view.root.render(
        h(ServerSavePrompt, {
          name: '合成报告',
          onChoose: choose,
          portalTarget: scoped ? view.portal : undefined,
        }),
      ),
    );
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(view.portal.contains(dialog)).toBe(scoped);
    act(() =>
      [...dialog!.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === '取消')!
        .click(),
    );
    expect(choose).toHaveBeenCalledWith(null);
  } finally {
    view.close();
  }
});
it.each([false, true])('本次保存菜单按指定宿主挂载，全屏宿主=%s', (scoped) => {
  const view = fixture(),
    select = vi.fn();
  try {
    act(() =>
      view.root.render(
        h(ExportSaveActions, { onSelect: select, portalTarget: scoped ? view.portal : undefined }),
      ),
    );
    act(() => view.host.querySelector<HTMLButtonElement>('button')!.click());
    const menu = document.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();
    expect(view.portal.contains(menu)).toBe(scoped);
    act(() =>
      [...menu!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
        .find((button) => button.textContent === '先生成，稍后保存')!
        .click(),
    );
    expect(select).toHaveBeenCalledWith({ mode: 'after' });
  } finally {
    view.close();
  }
});
