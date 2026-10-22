import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountSelector } from '../src/renderer/src/views/bootstrap/AccountSelector';

const accounts = Array.from({ length: 24 }, (_, i) => ({
  key: `synthetic-${i}`,
  configId: `synthetic-${i}`,
  uin: String(10000 + i),
  name: `合成账号${i + 1}的较长显示名称`,
  hasName: true,
  avatarUrl: null,
}));
let host: HTMLDivElement, root: Root;
const select = vi.fn(),
  remove = vi.fn();
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  select.mockClear();
  remove.mockClear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root.render(
      createElement(AccountSelector, {
        accounts,
        selected: accounts[0]!,
        onSelect: select,
        onDeleteAccount: remove,
        footer: createElement('button', { type: 'button' }, '登录新的账号'),
      }),
    ),
  );
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
function trigger() {
  return host.querySelector<HTMLButtonElement>('.weq-acct-switch')!;
}
function open() {
  act(() => {
    trigger().focus();
    trigger().click();
  });
}
function popup() {
  return document.querySelector<HTMLElement>('.weq-acct-pop')!;
}
function context() {
  act(() =>
    popup()
      .querySelector('.weq-acct-row')!
      .dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: 1000,
          clientY: 1000,
        }),
      ),
  );
}

describe('启动账号选择器浮层', () => {
  it('离开滚动裁切树，保留所有账号、完整名称提示和底部入口', () => {
    open();
    expect(host.contains(popup())).toBe(false);
    expect(popup().closest('.is-anchored-popover')).not.toBeNull();
    expect(popup().querySelectorAll('.weq-acct-row')).toHaveLength(accounts.length);
    expect(popup().querySelector<HTMLButtonElement>('.weq-acct-row')!.title).toBe(
      accounts[0]!.name,
    );
    expect(popup().querySelector('.weq-acct-foot')!.textContent).toBe('登录新的账号');
    expect(trigger().getAttribute('aria-haspopup')).toBe('menu');
  });
  it('非关闭按键不关闭右键菜单，Escape逐层关闭并归还焦点', () => {
    open();
    context();
    const menu = () => document.querySelector('.weq-acct-ctx-menu');
    expect(menu()!.closest('.is-anchored-popover')).not.toBeNull();
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' })));
    expect(menu()).not.toBeNull();
    act(() =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })),
    );
    expect(menu()).toBeNull();
    expect(popup()).not.toBeNull();
    expect(popup().contains(document.activeElement)).toBe(true);
    act(() =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })),
    );
    expect(popup()).toBeNull();
    expect(document.activeElement).toBe(trigger());
    expect(select).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });
  it('再次点击触发按钮只关闭菜单，不误开', () => {
    open();
    act(() => {
      trigger().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      trigger().click();
    });
    expect(popup()).toBeNull();
  });
  it('选择账号只回传对应对象并关闭', () => {
    open();
    act(() => popup().querySelectorAll<HTMLButtonElement>('.weq-acct-row')[3]!.click());
    expect(select).toHaveBeenCalledOnce();
    expect(select).toHaveBeenCalledWith(accounts[3]);
    expect(popup()).toBeNull();
  });
  it('明确删除才回传原账号并关闭两层菜单', () => {
    open();
    context();
    act(() => document.querySelector<HTMLButtonElement>('.weq-acct-ctx-menu button')!.click());
    expect(remove).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith(accounts[0]);
    expect(select).not.toHaveBeenCalled();
    expect(document.querySelector('.weq-acct-ctx-menu')).toBeNull();
    expect(popup()).toBeNull();
  });
  it('窗口失焦同时关闭两层，不触发账号操作', () => {
    open();
    context();
    act(() => window.dispatchEvent(new Event('blur')));
    expect(popup()).toBeNull();
    expect(document.querySelector('.weq-acct-ctx-menu')).toBeNull();
    expect(remove).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });
});
