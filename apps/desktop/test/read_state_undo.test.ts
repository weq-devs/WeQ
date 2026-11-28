import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useReadStateUndo } from '../src/renderer/src/hooks/useReadStateUndo';
import { macApplicationMenu } from '../src/main/application_menu';

afterEach(() => vi.unstubAllGlobals());

it('系统编辑菜单在文字和会话模式各只提供一组撤销重做项', () => {
  const undo = vi.fn();
  const items = (readStateUndo?: Parameters<typeof macApplicationMenu>[3]) =>
    macApplicationMenu(vi.fn(), vi.fn(), 'zh-CN', readStateUndo).find(
      (item) => item.label === '编辑',
    )!.submenu as import('electron').MenuItemConstructorOptions[];

  expect(items().slice(0, 2)).toEqual([{ role: 'undo' }, { role: 'redo' }]);
  const business = items({ action: 'mark-read', click: undo });
  expect(business.slice(0, 2)).toEqual([
    { label: '撤销标为已读', accelerator: 'CmdOrCtrl+Z', click: undo },
    { label: '重做', enabled: false },
  ]);
  expect(business.map((item) => item.role)).toEqual(
    expect.arrayContaining(['cut', 'copy', 'paste', 'selectAll']),
  );
  expect(business.some((item) => item.role === 'undo' || item.role === 'redo')).toBe(false);
});

it('系统撤销处理当前标记，编辑框、弹窗及无可撤销标记时回退原生撤销，卸载解除监听', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let handler: (() => boolean) | undefined;
  const unsubscribe = vi.fn();
  const update = vi.fn();
  const originalQuery = Object.getOwnPropertyDescriptor(document, 'queryCommandEnabled');
  const query = vi.fn(() => true);
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
    expect(update).toHaveBeenLastCalledWith('mark-read');
    act(() => root.render(h(Fixture, { enabled: true, action: 'mark-unread' })));
    expect(update).toHaveBeenLastCalledWith('mark-unread');
    expect(handler!()).toBe(true);
    expect(undo).toHaveBeenCalledTimes(1);
    host.querySelector('input')!.focus();
    expect(update).toHaveBeenLastCalledWith(null);
    update.mockClear();
    document.dispatchEvent(new Event('input'));
    document.dispatchEvent(new Event('selectionchange'));
    await act(async () => host.append(document.createElement('span')));
    expect(query).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(handler!()).toBe(false);
    host.querySelector<HTMLElement>('[contenteditable]')!.focus();
    expect(update).not.toHaveBeenCalled();
    expect(handler!()).toBe(false);
    host.querySelector('button')!.focus();
    const modal = document.createElement('div');
    modal.setAttribute('aria-modal', 'true');
    await act(async () => host.append(modal));
    await vi.waitFor(() => expect(update).toHaveBeenLastCalledWith(null));
    expect(handler!()).toBe(false);
    modal.remove();
    await vi.waitFor(() => expect(update).toHaveBeenLastCalledWith('mark-unread'));
    act(() => root.render(h(Fixture, { enabled: false })));
    expect(update).toHaveBeenLastCalledWith(null);
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
