import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useReadStateUndo } from '../src/renderer/src/hooks/useReadStateUndo';
import { macApplicationMenu } from '../src/main/application_menu';

afterEach(() => vi.unstubAllGlobals());

it('系统编辑菜单按桥接状态控制撤销和重做，保留原生剪贴板操作', () => {
  const undo = vi.fn();
  const redo = vi.fn();
  const edit = macApplicationMenu(vi.fn(), 'zh-CN', undo, redo).find(
    (item) => item.label === '编辑',
  )!;
  const items = edit.submenu as import('electron').MenuItemConstructorOptions[];
  expect(items.find((item) => item.id === 'weq-edit-undo')).toMatchObject({
    label: '撤销',
    accelerator: 'CmdOrCtrl+Z',
    click: undo,
    enabled: false,
    acceleratorWorksWhenHidden: false,
  });
  expect(items.find((item) => item.id === 'weq-edit-redo')).toMatchObject({
    label: '重做',
    accelerator: 'CmdOrCtrl+Shift+Z',
    click: redo,
    enabled: false,
    acceleratorWorksWhenHidden: false,
  });
  expect(items.find((item) => item.id === 'weq-edit-native-undo')).toMatchObject({
    role: 'undo',
    visible: false,
    acceleratorWorksWhenHidden: false,
  });
  expect(items.find((item) => item.id === 'weq-edit-native-redo')).toMatchObject({
    role: 'redo',
    visible: false,
    acceleratorWorksWhenHidden: false,
  });
  expect(items.map((item) => item.role)).toEqual(
    expect.arrayContaining(['cut', 'copy', 'paste', 'selectAll']),
  );
});

it('系统撤销处理当前标记，编辑框、弹窗及无可撤销标记时回退原生撤销，卸载解除监听', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let handler: (() => boolean) | undefined;
  const unsubscribe = vi.fn();
  const update = vi.fn();
  const originalQuery = Object.getOwnPropertyDescriptor(document, 'queryCommandEnabled');
  const query = vi.fn((command: string) => command === 'redo');
  Object.defineProperty(document, 'queryCommandEnabled', { configurable: true, value: query });
  vi.stubGlobal('weq', {
    editUndo: {
      update,
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
  function Fixture({
    enabled,
    action = 'mark-read',
  }: {
    enabled: boolean;
    action?: 'mark-read' | 'mark-unread';
  }) {
    useReadStateUndo(enabled, undo, action);
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
    expect(update).toHaveBeenLastCalledWith({ undo: 'mark-read', redo: null });
    act(() => root.render(h(Fixture, { enabled: true, action: 'mark-unread' })));
    expect(update).toHaveBeenLastCalledWith({ undo: 'mark-unread', redo: null });
    expect(handler!()).toBe(true);
    expect(undo).toHaveBeenCalledTimes(1);
    host.querySelector('input')!.focus();
    expect(update).toHaveBeenLastCalledWith({ undo: null, redo: 'text' });
    query.mockReturnValue(true);
    document.dispatchEvent(new Event('input'));
    expect(update).toHaveBeenLastCalledWith({ undo: 'text', redo: 'text' });
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
    expect(update).toHaveBeenLastCalledWith({ undo: null, redo: null });
    expect(handler!()).toBe(false);
    expect(undo).toHaveBeenCalledTimes(1);
  } finally {
    act(() => root.unmount());
    host.remove();
    if (originalQuery) Object.defineProperty(document, 'queryCommandEnabled', originalQuery);
    else Reflect.deleteProperty(document, 'queryCommandEnabled');
  }
  expect(unsubscribe).toHaveBeenCalledTimes(1);
});
