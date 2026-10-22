import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RailAccountFooter } from '../src/renderer/src/components/RailAccountFooter';

const fixture = vi.hoisted(() => ({
  mutate: vi.fn(),
  refetch: vi.fn(async () => ({ data: undefined })),
  mode: 'ready' as 'ready' | 'loading' | 'empty' | 'error' | 'stale',
  accounts: Array.from({ length: 24 }, (_, i) => ({
    configId: `synthetic-${i}`,
    uin: String(10000 + i),
    displayName: `合成账号${i + 1}的较长显示名称`,
    dbKey: '',
    static: true,
    dataDir: '/synthetic',
  })),
}));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ removeQueries: vi.fn() }),
  useQuery: () => ({ data: { configured: false, available: false } }),
}));
vi.mock('../src/renderer/src/trpc/client', () => {
  const proxy = (path = ''): unknown =>
    new Proxy(() => undefined, {
      get(_target, key) {
        if (key === 'useQuery')
          return () => ({
            data: path.endsWith('listAccountConfigs')
              ? fixture.mode === 'ready' || fixture.mode === 'stale'
                ? fixture.accounts
                : fixture.mode === 'empty'
                  ? []
                  : undefined
              : path.endsWith('getAccountConfig')
                ? { configId: 'current' }
                : path.endsWith('getSettings')
                  ? { appLock: { enabled: false } }
                  : undefined,
            isLoading: path.endsWith('listAccountConfigs') && fixture.mode === 'loading',
            error:
              path.endsWith('listAccountConfigs') && ['error', 'stale'].includes(fixture.mode)
                ? new Error('合成账号读取失败')
                : null,
            isFetching: false,
            refetch: fixture.refetch,
          });
        if (key === 'mutate') return fixture.mutate;
        if (key === 'query') return async () => null;
        return proxy(`${path}.${String(key)}`);
      },
    });
  return { trpc: proxy(), client: proxy() };
});

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.mutate.mockClear();
  fixture.refetch.mockClear();
  fixture.mode = 'ready';
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root.render(
      createElement(RailAccountFooter, { currentUin: '99999', currentName: '合成当前账号' }),
    ),
  );
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
function open() {
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="切换账号"]')!.click());
}
function popup() {
  return document.querySelector<HTMLElement>('.weq-rail-account-popover')!;
}

describe('账号菜单的公共浮层契约', () => {
  it.each(['error', 'stale'] as const)(
    '读取失败不冒充空账号列表，%s 可重试并保留已有数据',
    (mode) => {
      fixture.mode = mode;
      open();
      expect(popup().querySelector('[role="alert"]')?.textContent).toContain('合成账号读取失败');
      expect(popup().textContent).not.toContain('暂无其它账号');
      expect(popup().querySelectorAll('.weq-rail-account-item')).toHaveLength(
        mode === 'stale' ? fixture.accounts.length : 0,
      );
      act(() =>
        popup().querySelector<HTMLButtonElement>('[aria-label="重新读取账号列表"]')!.click(),
      );
      expect(fixture.refetch).toHaveBeenCalledOnce();
      expect(fixture.mutate).not.toHaveBeenCalled();
    },
  );
  it.each([
    ['loading', '加载中'],
    ['empty', '暂无其它账号'],
  ] as const)('%s 保留独立状态', (mode, text) => {
    fixture.mode = mode;
    open();
    expect(popup().textContent).toContain(text);
    expect(popup().querySelector('[role="alert"]')).toBeNull();
  });
  it('菜单离开侧栏裁切树，完整保留账号与名称提示，内部点击不关闭', () => {
    open();
    expect(host.contains(popup())).toBe(false);
    expect(popup().closest('.weq-overlay-layer')).not.toBeNull();
    expect(popup().querySelectorAll('.weq-rail-account-item')).toHaveLength(
      fixture.accounts.length,
    );
    expect(popup().querySelector<HTMLButtonElement>('.weq-rail-account-item')?.title).toBe(
      fixture.accounts[0]!.displayName,
    );
    act(() =>
      popup()
        .querySelector('.weq-rail-account-popover-head')!
        .dispatchEvent(new MouseEvent('mousedown', { bubbles: true })),
    );
    expect(popup()).not.toBeNull();
    expect(fixture.mutate).not.toHaveBeenCalled();
  });
  it('右键菜单复用锚定浮层，Escape先关右键菜单，再关账号菜单', () => {
    open();
    act(() =>
      popup()
        .querySelector('.weq-rail-account-item')!
        .dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: 1000,
            clientY: 1000,
          }),
        ),
    );
    const context = document.querySelector('.weq-rail-account-ctx-menu')!;
    expect(context.closest('.is-anchored-popover')).not.toBeNull();
    act(() =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })),
    );
    expect(document.querySelector('.weq-rail-account-ctx-menu')).toBeNull();
    expect(popup()).not.toBeNull();
    expect(popup().contains(document.activeElement)).toBe(true);
    act(() =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })),
    );
    expect(document.querySelector('.weq-rail-account-popover')).toBeNull();
    expect(fixture.mutate).not.toHaveBeenCalled();
  });
  it('再次点击头像仅关闭一次，不误触切号或退出', () => {
    open();
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="切换账号"]')!;
    act(() => {
      trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      trigger.click();
    });
    expect(document.querySelector('.weq-rail-account-popover')).toBeNull();
    expect(fixture.mutate).not.toHaveBeenCalled();
  });

  it('明确选择删除后关闭两层菜单，仍只提交原配置 ID', async () => {
    open();
    act(() =>
      popup()
        .querySelector('.weq-rail-account-item')!
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })),
    );
    await act(async () =>
      document.querySelector<HTMLButtonElement>('.weq-rail-account-ctx-menu button')!.click(),
    );
    expect(fixture.mutate).toHaveBeenCalledOnce();
    expect(fixture.mutate).toHaveBeenCalledWith({ configId: fixture.accounts[0]!.configId });
    expect(document.querySelector('.weq-rail-account-ctx-menu')).toBeNull();
    expect(document.querySelector('.weq-rail-account-popover')).toBeNull();
  });
});
