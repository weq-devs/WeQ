import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SettingsDialog } from '../src/renderer/src/components/SettingsDialog';

const fixture = vi.hoisted(() => ({
  settings: {} as Record<string, boolean>,
  settingKey: 'showMessageUnreadBadge',
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
                isLoading: fixture.loading,
                mutate: (...args: Parameters<typeof fixture.save>) => {
                  const name = path.at(-1)!.slice(3);
                  fixture.settingKey = name[0]!.toLowerCase() + name.slice(1);
                  fixture.save(...args);
                },
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
        fixture.settings = { ...fixture.settings, [fixture.settingKey]: input.enabled };
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

it.each([
  ['从第一条新消息开始阅读', 'readFromFirstUnread', false],
  ['发送消息后定位到最新消息', 'jumpToLatestAfterSend', true],
  ['群助手显示总消息数', 'showGroupAssistantMessageCount', false],
] as const)('%s 默认值正确，点击保存、重开恢复、失败不改变原值', (label, key, defaultValue) => {
  let f = mount();
  const toggle = () =>
    f.host.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${label}"]`)!;
  try {
    expect(toggle().getAttribute('aria-checked')).toBe(String(defaultValue));
    act(() => toggle().click());
    expect(fixture.save).toHaveBeenCalledWith({ enabled: !defaultValue }, expect.any(Object));
    expect(fixture.settings[key]).toBe(!defaultValue);
    expect(fixture.invalidate).toHaveBeenCalledOnce();
    f.close();
    f = mount();
    expect(toggle().getAttribute('aria-checked')).toBe(String(!defaultValue));
    fixture.failed = true;
    act(() => toggle().click());
    expect(toggle().getAttribute('aria-checked')).toBe(String(!defaultValue));
    expect(f.host.querySelector('[role="alert"]')?.textContent).toBe('保存失败');
    fixture.loading = true;
    f.render();
    expect(toggle().disabled).toBe(true);
  } finally {
    f.close();
  }
});
