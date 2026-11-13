import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MailSettingsSection } from '../src/renderer/src/components/settings/MailSettingsSection';
import { useViewState } from '../src/renderer/src/state/view';

const mocks = vi.hoisted(() => ({
  preferences: { showUnread: false, notifications: true, pollIntervalMinutes: 1 },
  showUnread: vi.fn(),
  notifications: vi.fn(),
  pollInterval: vi.fn(),
  invalidate: vi.fn(),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    useUtils: () => ({ settings: { mail: { get: { invalidate: mocks.invalidate } } } }),
    settings: {
      mail: {
        get: { useQuery: () => ({ data: mocks.preferences }) },
        patch: {
          useMutation: () => ({
            isLoading: false,
            mutateAsync: (input: Record<string, unknown>) =>
              'showUnread' in input
                ? mocks.showUnread(input)
                : 'notifications' in input
                  ? mocks.notifications(input)
                  : mocks.pollInterval(input),
          }),
        },
      },
    },
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useViewState.setState({ openedUin: '12345678' });
  mocks.showUnread.mockResolvedValue(true);
  mocks.notifications.mockResolvedValue({ notifications: false });
  mocks.pollInterval.mockResolvedValue(5);
});
afterEach(() => {
  useViewState.setState({ openedUin: null });
  vi.unstubAllGlobals();
});

function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(createElement(MailSettingsSection)));
  return {
    host,
    toggle: (label: string) => host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!,
    close: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

describe('QQ 邮箱设置', () => {
  it('查询间隔回显并自动保存到全局，无效输入不提交', async () => {
    vi.useFakeTimers();
    const view = mount();
    const input = view.host.querySelector<HTMLInputElement>('[type="number"]')!;
    const change = async (value: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
          input,
          value,
        );
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => vi.advanceTimersByTimeAsync(2000));
    };
    try {
      expect(input.value).toBe('1');
      await change('5');
      expect(mocks.pollInterval).toHaveBeenCalledWith({ pollIntervalMinutes: 5 });
      mocks.pollInterval.mockClear();
      await change('0');
      expect(mocks.pollInterval).not.toHaveBeenCalled();
      expect(view.host.textContent).toContain('输入无效');
    } finally {
      view.close();
      vi.useRealTimers();
    }
  });
  it('回显原有偏好，两个开关独立写入全局并刷新共享配置', async () => {
    const view = mount();
    try {
      expect(view.toggle('在邮箱图标上显示红点').getAttribute('aria-checked')).toBe('false');
      expect(view.toggle('收到新邮件时横幅提醒').getAttribute('aria-checked')).toBe('true');
      await act(async () => view.toggle('在邮箱图标上显示红点').click());
      expect(mocks.showUnread).toHaveBeenCalledWith({ showUnread: true });
      expect(mocks.notifications).not.toHaveBeenCalled();
      expect(mocks.invalidate).toHaveBeenCalledWith();
      await act(async () => view.toggle('收到新邮件时横幅提醒').click());
      expect(mocks.notifications).toHaveBeenCalledWith({
        notifications: false,
      });
    } finally {
      view.close();
    }
  });
  it('保存失败显示错误，保留服务端偏好并重新读取', async () => {
    mocks.showUnread.mockRejectedValueOnce(new Error('合成保存失败'));
    const view = mount();
    try {
      await act(async () => view.toggle('在邮箱图标上显示红点').click());
      expect(view.host.querySelector('[role="alert"]')?.textContent).toBe('合成保存失败');
      expect(view.toggle('在邮箱图标上显示红点').getAttribute('aria-checked')).toBe('false');
      expect(mocks.invalidate).toHaveBeenCalledOnce();
    } finally {
      view.close();
    }
  });
  it('没有打开账号时仍可配置全局偏好', () => {
    useViewState.setState({ openedUin: null });
    const view = mount();
    try {
      expect(view.toggle('在邮箱图标上显示红点').disabled).toBe(false);
      expect(view.toggle('收到新邮件时横幅提醒').disabled).toBe(false);
    } finally {
      view.close();
    }
  });
});
