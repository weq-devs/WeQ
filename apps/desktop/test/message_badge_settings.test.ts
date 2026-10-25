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
    close: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

const toggles = [
  ['在消息图标上显示红点', 'showMessageUnreadBadge', true],
  ['从第一条新消息开始阅读', 'readFromFirstUnread', false],
  ['发送消息后定位到最新消息', 'jumpToLatestAfterSend', true],
  ['使用 QQ 账号设置的个性字体发送消息', 'sendWithQqFont', true],
  ['群助手显示总消息数', 'showGroupAssistantMessageCount', false],
  ['消息气泡', 'showMessageBubble', true],
  ['消息字体', 'showMessageFont', true],
  ['聊天头像挂件', 'showAvatarPendant', true],
] as const;

it('消息开关分别按默认值展示、保存、刷新共享设置，重开后可恢复与再次开启', () => {
  let f = mount();
  const toggle = (label: string) =>
    f.host.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${label}"]`)!;
  try {
    const setting = f.host.querySelector('[data-setting-id="read-first-unread"]');
    expect(setting?.querySelector('strong')?.textContent).toBe('从第一条新消息开始阅读');
    expect(setting?.querySelector('span')?.textContent).toBe('可能提高阅读过的会话的加载速度');
    for (const [label, key, defaultValue] of toggles) {
      vi.clearAllMocks();
      expect(toggle(label).getAttribute('aria-checked'), label).toBe(String(defaultValue));
      act(() => toggle(label).click());
      expect(fixture.save, label).toHaveBeenCalledOnce();
      expect(fixture.save, label).toHaveBeenCalledWith(
        { enabled: !defaultValue },
        expect.any(Object),
      );
      expect(fixture.settings[key], label).toBe(!defaultValue);
      expect(fixture.invalidate, label).toHaveBeenCalledOnce();
      f.render();
      expect(toggle(label).getAttribute('aria-checked'), label).toBe(String(!defaultValue));
    }
    f.close();
    f = mount();
    for (const [label, key, defaultValue] of toggles) {
      expect(toggle(label).getAttribute('aria-checked'), label).toBe(String(!defaultValue));
      act(() => toggle(label).click());
      f.render();
      expect(fixture.settings[key], label).toBe(defaultValue);
      expect(toggle(label).getAttribute('aria-checked'), label).toBe(String(defaultValue));
    }
  } finally {
    f.close();
  }
});

it('每个消息开关保存失败均保留原值并提示，保存期间不能重复点击', () => {
  const f = mount();
  try {
    fixture.failed = true;
    for (const [label, key, defaultValue] of toggles) {
      const toggle = f.host.querySelector<HTMLButtonElement>(
        `[role="switch"][aria-label="${label}"]`,
      )!;
      vi.clearAllMocks();
      expect(f.host.querySelector('[role="alert"]'), label).toBeNull();
      act(() => toggle.click());
      expect(fixture.save, label).toHaveBeenCalledOnce();
      expect(fixture.save, label).toHaveBeenCalledWith(
        { enabled: !defaultValue },
        expect.any(Object),
      );
      expect(fixture.settingKey, label).toBe(key);
      expect(toggle.getAttribute('aria-checked'), label).toBe(String(defaultValue));
      expect(
        [...f.host.querySelectorAll('[role="alert"]')].some(
          (node) => node.textContent === '保存失败',
        ),
        label,
      ).toBe(true);
      expect(fixture.invalidate, label).not.toHaveBeenCalled();
      fixture.failed = false;
      act(() => toggle.click());
      f.render();
      expect(f.host.querySelector('[role="alert"]'), label).toBeNull();
      expect(fixture.settings[key], label).toBe(!defaultValue);
      fixture.failed = true;
    }
    fixture.loading = true;
    f.render();
    vi.clearAllMocks();
    for (const [label] of toggles) {
      const toggle = f.host.querySelector<HTMLButtonElement>(
        `[role="switch"][aria-label="${label}"]`,
      )!;
      expect(toggle.disabled, label).toBe(true);
      act(() => toggle.click());
    }
    expect(fixture.save).not.toHaveBeenCalled();
  } finally {
    f.close();
  }
});
