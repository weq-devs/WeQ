import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SettingsDialog } from '../src/renderer/src/components/SettingsDialog';

const fixture = vi.hoisted(() => ({
  settings: {} as { showMessageUnreadBadge?: boolean },
  save: vi.fn(),
  invalidate: vi.fn(),
  loading: false,
  failed: false,
}));
vi.mock('../src/renderer/src/trpc/client', () => {
  const proxy = (path: string[] = []): unknown =>
    new Proxy(() => proxy(path), {
      get: (_target, key) =>
        key === 'useQuery'
          ? () => ({
              data: path.at(-1) === 'getSettings' ? fixture.settings : undefined,
              isLoading: false,
              refetch: vi.fn(),
            })
          : key === 'useMutation'
            ? () => ({
                isLoading: path.at(-1) === 'setShowMessageUnreadBadge' && fixture.loading,
                mutate: fixture.save,
              })
            : key === 'invalidate'
              ? fixture.invalidate
              : proxy([...path, String(key)]),
    });
  return { trpc: proxy(), client: proxy() };
});
vi.mock('../src/renderer/src/components/settings/HelpSection', () => ({ HelpSection: () => null }));
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  fixture.settings = {};
  fixture.loading = false;
  fixture.failed = false;
  fixture.save.mockImplementation(
    (
      input: { enabled: boolean },
      callbacks: { onSuccess(): void; onError(error: Error): void },
    ) => {
      if (fixture.failed) callbacks.onError(new Error('保存失败'));
      else {
        fixture.settings = { showMessageUnreadBadge: input.enabled };
        callbacks.onSuccess();
      }
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = () =>
    act(() =>
      root.render(
        createElement(SettingsDialog, {
          open: true,
          initialSection: 'message-display',
          onClose: vi.fn(),
          onOpenMaintenance: vi.fn(),
          onOpenRecalls: vi.fn(),
        }),
      ),
    );
  render();
  return {
    host,
    render,
    toggle: () =>
      host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="显示消息汇总红点"]')!,
    close: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

it('消息显示页开关默认开启，保存后刷新共享设置，重新打开保留关闭状态', () => {
  let f = mount();
  try {
    expect(f.toggle().getAttribute('aria-checked')).toBe('true');
    act(() => f.toggle().click());
    expect(fixture.save).toHaveBeenCalledWith({ enabled: false }, expect.any(Object));
    expect(fixture.invalidate).toHaveBeenCalledOnce();
    f.render();
    expect(f.toggle().getAttribute('aria-checked')).toBe('false');
    f.close();
    f = mount();
    expect(f.toggle().getAttribute('aria-checked')).toBe('false');
    act(() => f.toggle().click());
    f.render();
    expect(f.toggle().getAttribute('aria-checked')).toBe('true');
  } finally {
    f.close();
  }
});

it('保存失败保留原值并提示，保存期间不能重复点击', () => {
  const f = mount();
  try {
    fixture.failed = true;
    act(() => f.toggle().click());
    expect(f.toggle().getAttribute('aria-checked')).toBe('true');
    expect(f.host.querySelector('[role="alert"]')?.textContent).toBe('保存失败');
    expect(fixture.invalidate).not.toHaveBeenCalled();
    fixture.loading = true;
    f.render();
    expect(f.toggle().disabled).toBe(true);
    act(() => f.toggle().click());
    expect(fixture.save).toHaveBeenCalledOnce();
  } finally {
    f.close();
  }
});
