import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AccountSelector } from '../src/renderer/src/views/bootstrap/AccountSelector';

const accounts = Array.from({ length: 24 }, (_, i) => ({
  key: `synthetic-${i}`,
  configId: `synthetic-${i}`,
  uin: '10001',
  name: `合成账号${i + 1}的较长显示名称`,
  hasName: true,
  avatarUrl: null,
  sourceDir: `/synthetic/snapshot-${i}`,
  static: true,
  lastLoginAt: Date.parse('2026-10-25T02:00:00Z'),
}));
let host: HTMLDivElement, root: Root;
const select = vi.fn(),
  remove = vi.fn();
function render(disabled = false) {
  act(() =>
    root.render(
      createElement(AccountSelector, {
        accounts,
        selected: accounts[0]!,
        onSelect: select,
        onDeleteAccount: remove,
        disabled,
      }),
    ),
  );
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  render();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
function openMenu(index = 0) {
  const account = host.querySelectorAll<HTMLButtonElement>('.weq-account-select')[index]!;
  act(() =>
    account.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })),
  );
  return account;
}
it('所有账号直接显示，同 QQ 的备份以目录区分并显示北京时间', () => {
  expect(host.querySelectorAll('.weq-account-select')).toHaveLength(accounts.length);
  expect(host.textContent).toContain('/synthetic/snapshot-23');
  expect(host.textContent).toContain('本地备份');
  expect(host.textContent).toContain('10-25 10:00');
  expect(host.querySelector<HTMLButtonElement>('.weq-account-select')!.title).toContain(
    accounts[0]!.sourceDir,
  );
});
it('选择账号只回传对应来源，不因同 QQ 号误选', () => {
  act(() => host.querySelectorAll<HTMLButtonElement>('.weq-account-select')[3]!.click());
  expect(select).toHaveBeenCalledWith(accounts[3]);
  expect(remove).not.toHaveBeenCalled();
});
it('键盘可打开账号菜单，Escape 收起菜单并归还焦点', () => {
  const account = host.querySelector<HTMLButtonElement>('.weq-account-select')!;
  act(() => {
    account.focus();
    account.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true }),
    );
  });
  expect(document.activeElement).toBe(document.querySelector('[role="menuitem"]'));
  act(() =>
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })),
  );
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(account);
  expect(remove).not.toHaveBeenCalled();
});
it('右键菜单只移除该次打开菜单的账号', () => {
  openMenu(2);
  act(() => document.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click());
  expect(remove).toHaveBeenCalledWith(accounts[2]);
  expect(select).not.toHaveBeenCalled();
  expect(document.querySelector('[role="menu"]')).toBeNull();
});
it('点回原账号卡片会收起菜单，不会触发账号操作', () => {
  const account = openMenu(2);
  act(() => {
    account.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
    account.click();
  });
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(select).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
});
it('失焦收起菜单，在途禁用账号和配置操作', () => {
  openMenu();
  act(() => window.dispatchEvent(new Event('blur')));
  expect(document.querySelector('[role="menu"]')).toBeNull();
  openMenu();
  render(true);
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect([...host.querySelectorAll('button')].every((button) => button.disabled)).toBe(true);
});
