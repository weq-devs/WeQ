import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { NotificationSettingsLink } from '../src/renderer/src/components/settings/NotificationSettingsLink';
import { SettingsNavigateContext } from '../src/renderer/src/components/settings/controls';
import { OPEN_NOTIFICATION_SETTINGS } from '../src/renderer/src/lib/notificationSettingsNavigation';
import { bindAccountState } from '../src/renderer/src/lib/clientPreferences';

vi.mock('../src/renderer/src/trpc/client', () => ({ trpc: {}, client: {} }));
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  bindAccountState(null);
  vi.unstubAllGlobals();
});
function mount(conversation = false) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const navigate = vi.fn();
  const onNavigate = vi.fn();
  act(() =>
    root.render(
      h(
        SettingsNavigateContext.Provider,
        { value: navigate },
        h(
          NotificationSettingsLink,
          {
            settingId: 'recall-notifications',
            conversation: conversation
              ? { kind: 'group', conv: '20001', title: '合成群' }
              : undefined,
            onNavigate,
          },
          '撤回提醒设置',
        ),
      ),
    ),
  );
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return { host, navigate, onNavigate };
}
it('设置内链接传稳定 ID，直接定位统一页而不执行写操作', () => {
  const f = mount();
  const button = f.host.querySelector('button')!;
  expect(button.classList.contains('weq-set-btn')).toBe(true);
  expect(button.classList.contains('weq-set-iconbtn')).toBe(false);
  expect(button.textContent).toBe('撤回提醒设置');
  expect(button.querySelector('.lucide-settings2')).toBeNull();
  act(() => f.host.querySelector('button')!.click());
  expect(f.navigate).toHaveBeenCalledWith('global', 'recall-notifications');
});
it('单会话链接携带原会话和数据源身份，关闭原浮层后请求统一页', () => {
  const source = { expectedAccountUin: '10001', expectedAccountConfigId: 'fixture' };
  bindAccountState(source);
  const f = mount(true);
  const received = vi.fn();
  window.addEventListener(OPEN_NOTIFICATION_SETTINGS, received);
  try {
    act(() => f.host.querySelector('button')!.click());
    expect(f.navigate).not.toHaveBeenCalled();
    expect(f.onNavigate).toHaveBeenCalledOnce();
    expect(received).toHaveBeenCalledOnce();
    const request = received.mock.calls[0]![0] as CustomEvent;
    expect(request.detail).toEqual({
      settingId: 'recall-notifications',
      source: JSON.stringify(source),
      conversation: { kind: 'group', conv: '20001', title: '合成群' },
    });
    expect(f.onNavigate.mock.invocationCallOrder[0]).toBeLessThan(
      received.mock.invocationCallOrder[0]!,
    );
  } finally {
    window.removeEventListener(OPEN_NOTIFICATION_SETTINGS, received);
  }
});
