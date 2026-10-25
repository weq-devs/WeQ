import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ServerSavePrompt } from '../src/renderer/src/components/ServerSavePrompt';
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
it.each([false, true])('保存选择器提交当前服务器位置，全屏宿主=%s', (scoped) => {
  const view = fixture(),
    select = vi.fn();
  try {
    act(() =>
      view.root.render(
        h(ServerSavePrompt, {
          name: '合成结果',
          onChoose: select,
          portalTarget: scoped ? view.portal : undefined,
        }),
      ),
    );
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(view.portal.contains(dialog)).toBe(scoped);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    act(() =>
      [...dialog.querySelectorAll<HTMLButtonElement>('button')]
        .find((button) => button.textContent === '保存')!
        .click(),
    );
    expect(select).toHaveBeenCalledWith('');
  } finally {
    view.close();
  }
});
