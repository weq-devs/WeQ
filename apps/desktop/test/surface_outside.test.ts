import { act, createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { Modal, useDialog } from '../src/renderer/src/components/Dialog';
import { OverlayLayer } from '../src/renderer/src/components/OverlayLayer';
import {
  DraftCloseContext,
  useDraftClose,
  useDraftProtection,
} from '../src/renderer/src/lib/draftClose';

let dispose = () => {};
afterEach(() => {
  dispose();
  useDialog.setState({ current: null });
  vi.unstubAllGlobals();
});
function mount(content: ReturnType<typeof h>) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(content));
  dispose = () => {
    act(() => root.unmount());
    host.remove();
  };
}
function press(target: Element) {
  act(() => {
    target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
  });
  // 覆盖真实鼠标尾随 click，同时清理用于防穿透的一次性监听。
  act(() => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

it.each(['popover', 'panel'] as const)('%s 小窗点外关闭，点内容不关闭', (presentation) => {
  const close = vi.fn();
  mount(h(Modal, { presentation, onClose: close }, h('button', { 'data-inside': true }, '内容')));
  press(document.querySelector('[data-inside]')!);
  expect(close).not.toHaveBeenCalled();
  press(document.body);
  expect(close).toHaveBeenCalledOnce();
});
it('点父窗只关最上层子窗，且不触发父窗按钮', () => {
  const parent = vi.fn(),
    child = vi.fn(),
    action = vi.fn();
  mount(
    h(
      Modal,
      { onClose: parent },
      h('button', { 'data-parent-action': true, onClick: action }, '操作'),
      h(OverlayLayer, { presentation: 'popover', onClose: child }, h('div', null, '子窗')),
    ),
  );
  press(document.querySelector('[data-parent-action]')!);
  expect(child).toHaveBeenCalledOnce();
  expect(parent).not.toHaveBeenCalled();
  expect(action).not.toHaveBeenCalled();
});
it.each(['floating', 'modal'] as const)(
  '工具浮窗和显式禁止关闭的 %s 不响应点外',
  (presentation) => {
    const close = vi.fn();
    mount(h(Modal, { presentation, dismissOnOutside: false, onClose: close }, '内容'));
    press(document.body);
    expect(close).not.toHaveBeenCalled();
  },
);
it('不可关闭的子模态框阻止点外关闭父窗', () => {
  const close = vi.fn();
  mount(h(Modal, { presentation: 'popover', onClose: close }, h(Modal, {}, '验证中')));
  press(document.body);
  expect(close).not.toHaveBeenCalled();
});
it('隐藏子页的草稿仍保护父窗，继续编辑不丢内容，确认放弃才关闭', async () => {
  const close = vi.fn();
  let edit = () => {};
  function Draft() {
    const [value, setValue] = useState('');
    edit = () => setValue('未保存内容');
    useDraftProtection(value);
    return h('div', { hidden: true }, value);
  }
  function Editor() {
    const guard = useDraftClose(close, null);
    return h(
      Modal,
      { onClose: guard.requestClose },
      h(DraftCloseContext.Provider, { value: guard.drafts }, h(Draft)),
    );
  }
  mount(h(Editor));
  act(() => edit());
  press(document.body);
  expect(close).not.toHaveBeenCalled();
  expect(useDialog.getState().current?.confirm).toBeDefined();
  await act(async () => {
    useDialog.getState().current?.confirm?.resolve(false);
    useDialog.getState().close();
  });
  expect(document.body.textContent).toContain('未保存内容');
  press(document.body);
  await act(async () => {
    useDialog.getState().current?.confirm?.resolve(true);
    useDialog.getState().close();
  });
  expect(close).toHaveBeenCalledOnce();
});
it('保存中不关闭，保存成功更新基线后无需放弃确认', () => {
  const close = vi.fn();
  let change = () => {},
    save = () => {},
    finish = () => {};
  function Editor() {
    const [value, setValue] = useState('');
    const [busy, setBusy] = useState(false);
    const guard = useDraftClose(close, value, busy);
    change = () => setValue('新内容');
    save = () => setBusy(true);
    finish = () => {
      guard.markSaved();
      setBusy(false);
    };
    return h(Modal, { onClose: guard.requestClose }, '编辑器');
  }
  mount(h(Editor));
  act(() => {
    change();
    save();
  });
  press(document.body);
  expect(close).not.toHaveBeenCalled();
  expect(useDialog.getState().current).toBeNull();
  act(() => finish());
  press(document.body);
  expect(close).toHaveBeenCalledOnce();
});
