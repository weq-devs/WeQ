import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useReadStateUndo } from '../src/renderer/src/hooks/useReadStateUndo';
import { macApplicationMenu } from '../src/main/application_menu';

afterEach(() => vi.unstubAllGlobals());

it('系统编辑菜单使用自定义撤销并保留原生重做和剪贴板操作', () => {
  const undo = vi.fn();
  const edit = macApplicationMenu(vi.fn(), 'zh-CN', undo).find((item) => item.label === '编辑')!;
  const items = edit.submenu as import('electron').MenuItemConstructorOptions[];
  expect(items[0]).toMatchObject({ label: '撤销', accelerator: 'CmdOrCtrl+Z', click: undo });
  expect(items.map((item) => item.role)).toEqual(
    expect.arrayContaining(['redo', 'cut', 'copy', 'paste', 'selectAll']),
  );
});

it('系统撤销处理当前标记，编辑框、弹窗及无可撤销标记时回退原生撤销，卸载解除监听', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let handler: (() => boolean) | undefined;
  const unsubscribe = vi.fn();
  vi.stubGlobal('weq', {
    editUndo: {
      onUndo: (listener: () => boolean) => {
        handler = listener;
        return unsubscribe;
      },
    },
  });
  const undo = vi.fn();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  function Fixture({ enabled }: { enabled: boolean }) {
    useReadStateUndo(enabled, undo);
    return h(
      'div',
      null,
      h('button', null, '会话'),
      h('input'),
      h('div', { contentEditable: true, tabIndex: 0 }),
    );
  }
  try {
    act(() => root.render(h(Fixture, { enabled: true })));
    host.querySelector('button')!.focus();
    expect(handler!()).toBe(true);
    expect(undo).toHaveBeenCalledTimes(1);
    host.querySelector('input')!.focus();
    expect(handler!()).toBe(false);
    host.querySelector<HTMLElement>('[contenteditable]')!.focus();
    expect(handler!()).toBe(false);
    host.querySelector('button')!.focus();
    const modal = document.createElement('div');
    modal.setAttribute('aria-modal', 'true');
    host.append(modal);
    expect(handler!()).toBe(false);
    modal.remove();
    act(() => root.render(h(Fixture, { enabled: false })));
    expect(handler!()).toBe(false);
    expect(undo).toHaveBeenCalledTimes(1);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
  expect(unsubscribe).toHaveBeenCalledTimes(1);
});
