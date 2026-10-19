import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoginPanel } from '../src/renderer/src/views/bootstrap/LoginPanel';
import type { UiAccount } from '../src/renderer/src/views/bootstrap/types';

const mocks = vi.hoisted(() => ({ selector: vi.fn(), managed: vi.fn(), select: vi.fn() }));
vi.mock('../src/renderer/src/views/bootstrap/AccountSelector', () => ({
  AccountSelector: (props: {
    selected: UiAccount;
    accounts: UiAccount[];
    onSelect(value: UiAccount): void;
  }) => {
    mocks.selector(props);
    return h('button', { onClick: () => props.onSelect(props.accounts[1]!) }, props.selected.name);
  },
}));
vi.mock('../src/renderer/src/views/bootstrap/ManagedQQPanel', () => ({
  ManagedQQPanel: (props: unknown) => {
    mocks.managed(props);
    return null;
  },
}));
vi.mock('../src/renderer/src/components/Dialog', () => ({
  useDialog: (read: (value: unknown) => unknown) => read({ showError: () => {} }),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({ client: {} }));
vi.mock('../src/renderer/src/lib/target', () => ({ IS_MAC: true }));
let close = () => {};
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
});
afterEach(() => {
  close();
  vi.unstubAllGlobals();
});
describe('保存的托管账号选择器', () => {
  it('进入托管分支后仍能选择另一个保存配置', () => {
    const accounts: UiAccount[] = ['a', 'b'].map((key, index) => ({
      key,
      configId: key,
      uin: String(10001 + index),
      managed: true,
      name: `Fixture ${key}`,
      hasName: true,
      avatarUrl: null,
    }));
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    close = () => {
      act(() => root.unmount());
      host.remove();
    };
    act(() =>
      root.render(
        h(LoginPanel, {
          mode: 'existing',
          accounts,
          selected: accounts[0]!,
          onSelect: mocks.select,
          installRoot: null,
          autoTarget: null,
          onEntered: () => {},
        }),
      ),
    );
    expect(mocks.selector).toHaveBeenCalled();
    expect(mocks.managed).toHaveBeenCalledWith(
      expect.objectContaining({ expectedUin: '10001', expectedConfigId: 'a' }),
    );
    act(() => host.querySelector('button')!.click());
    expect(mocks.select).toHaveBeenCalledWith(accounts[1]);
  });
});
