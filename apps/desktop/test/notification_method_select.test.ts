import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  normalizeNotificationEvents,
  type NotificationEvents,
  type NotificationEvent,
} from '@weq/service/notification-settings';
import { NotificationMethodSelect } from '../src/renderer/src/components/settings/NotificationMethodSelect';
import { NotificationEventSettings } from '../src/renderer/src/components/settings/NotificationEventSettings';
import { NOTIFICATION_METHODS, notificationEventPatch } from '../src/shared/notification_method';

const state = vi.hoisted(() => ({
  settings: undefined as { notificationEvents: NotificationEvents } | undefined,
  save: vi.fn(),
  error: null as Error | null,
  refetch: vi.fn(),
  policy: vi.fn(),
  preference: vi.fn(),
  web: false,
}));
vi.mock('../src/renderer/src/lib/target', () => ({
  get IS_WEB() {
    return state.web;
  },
}));
vi.mock('../src/renderer/src/lib/target.shared', () => ({
  get IS_WEB() {
    return state.web;
  },
}));
vi.mock('../src/renderer/src/lib/clientPreferences', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/renderer/src/lib/clientPreferences')>()),
  changePreference: state.preference,
}));
vi.mock('../src/renderer/src/lib/notificationPolicy', () => ({
  useNotificationPolicy: { getState: () => ({ setEvents: state.policy }) },
}));
vi.mock('../src/renderer/src/trpc/client', () => {
  const proxy = (path = ''): unknown =>
    new Proxy(() => {}, {
      apply: () => proxy(path),
      get: (_target, key) => {
        if (key === 'useQuery')
          return () => ({
            data: path === 'bootstrap.getSettings' ? state.settings : undefined,
            error: state.error,
            isFetching: false,
            refetch: state.refetch,
          });
        if (key === 'useMutation') return () => ({ mutateAsync: state.save });
        if (key === 'setData')
          return (
            _input: unknown,
            update: (before: typeof state.settings) => typeof state.settings,
          ) => {
            state.settings = update(state.settings);
          };
        if (key === 'invalidate') return async () => {};
        return proxy(path ? `${path}.${String(key)}` : String(key));
      },
    });
  return { trpc: proxy(), client: proxy() };
});
const disposals: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.settings = { notificationEvents: normalizeNotificationEvents(undefined) };
  state.error = null;
  state.web = false;
  vi.clearAllMocks();
  state.preference.mockResolvedValue(true);
  state.save.mockImplementation(async (input: Parameters<typeof notificationEventPatch>[1]) => ({
    ...state.settings!.notificationEvents,
    ...notificationEventPatch(state.settings!.notificationEvents, input),
  }));
});
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
  vi.unstubAllGlobals();
});
function mount(event: NotificationEvent = 'mail', table = false) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = () =>
    act(() =>
      root.render(
        h(
          'div',
          null,
          h(NotificationMethodSelect, { event }),
          table
            ? h(NotificationEventSettings, {
                target: { section: 'global', settingId: 'mail-banner', revision: 1 },
              })
            : null,
        ),
      ),
    );
  render();
  disposals.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  const select = host.querySelector('select')!;
  const choose = (value: string) => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  };
  return { host, select, choose, render };
}
it.each(NOTIFICATION_METHODS)('回显 $label，且只有四种选择', (method) => {
  state.settings!.notificationEvents.mail = { ...method.channels };
  const { select } = mount();
  expect(select.value).toBe(method.value);
  expect(select.options.length).toBe(4);
  expect(select.getAttribute('aria-label')).toBe('新邮件通知方式');
});
it('一次请求保存两个渠道，保留其他事件及共享状态，不跳转', async () => {
  const { host, select, choose } = mount();
  const original = structuredClone(state.settings!.notificationEvents);
  const navigation = vi.fn();
  window.addEventListener('weq:open-notification-settings', navigation);
  try {
    await act(async () => choose('banner'));
    expect(state.save).toHaveBeenCalledOnce();
    expect(state.save).toHaveBeenCalledWith({
      events: ['mail'],
      channels: { banner: true, system: false },
    });
    expect(select.value).toBe('banner');
    expect(state.settings!.notificationEvents).toEqual({
      ...original,
      mail: { banner: true, system: false },
    });
    expect(state.policy).toHaveBeenCalledWith(state.settings!.notificationEvents);
    expect(navigation).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')).toBeNull();
  } finally {
    window.removeEventListener('weq:open-notification-settings', navigation);
  }
});
it('保存期间禁用，失败恢复原方式，能够重新选择并重试', async () => {
  let reject!: (error: Error) => void;
  state.save.mockImplementationOnce(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  const { host, select, choose } = mount();
  act(() => choose('off'));
  expect(select.disabled).toBe(true);
  expect(select.value).toBe('off');
  await act(async () => reject(new Error('合成写入失败')));
  expect(select.disabled).toBe(false);
  expect(select.value).toBe('both');
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('合成写入失败');
  await act(async () => choose('system'));
  expect(select.value).toBe('system');
  expect(host.querySelector('[role="alert"]')).toBeNull();
});
it('未读到配置不冒充默认值，读取失败提供就地重试', () => {
  state.settings = undefined;
  const { host, select, render } = mount();
  expect(select.disabled).toBe(true);
  expect(select.value).toBe('');
  expect(select.selectedOptions[0].textContent).toBe('正在读取…');
  state.error = new Error('合成读取失败');
  render();
  expect(select.selectedOptions[0].textContent).toBe('读取失败');
  act(() => host.querySelector('button')!.click());
  expect(state.refetch).toHaveBeenCalledOnce();
  state.settings = { notificationEvents: normalizeNotificationEvents(undefined) };
  state.error = null;
  render();
  expect(select.disabled).toBe(false);
  expect(select.value).toBe('both');
});
it('与统一设置表双向回显同一配置', async () => {
  const { host, select, choose, render } = mount('mail', true);
  await act(async () => choose('banner'));
  render();
  const system = host.querySelector<HTMLButtonElement>('[aria-label="新邮件：系统通知"]')!;
  expect(system.getAttribute('aria-checked')).toBe('false');
  await act(async () => system.click());
  render();
  expect(select.value).toBe('both');
});
it.each(['denied', 'unsupported', 'rejected', 'throws', 'granted'])(
  '浏览器权限 %s 不丢失已保存方式',
  async (permission) => {
    state.web = true;
    state.settings!.notificationEvents.mail = { banner: true, system: false };
    const request = vi.fn(() => {
      if (permission === 'throws') throw new Error('合成权限异常');
      if (permission === 'rejected') return Promise.reject(new Error('合成权限异常'));
      return Promise.resolve(permission);
    });
    vi.stubGlobal(
      'Notification',
      permission === 'unsupported' ? undefined : { requestPermission: request },
    );
    const { host, select, choose } = mount();
    await act(async () => choose('both'));
    expect(select.value).toBe('both');
    expect(state.settings!.notificationEvents.mail).toEqual({ banner: true, system: true });
    if (permission === 'granted') {
      expect(state.preference).toHaveBeenCalledWith('webNotifications', true);
      expect(host.querySelector('[role="alert"]')).toBeNull();
    } else {
      expect(state.preference).not.toHaveBeenCalled();
      expect(host.querySelector('[role="alert"]')?.textContent).toContain('通知方式已保存');
    }
  },
);
it.each(['denied', 'granted'])(
  '等待浏览器授权不阻塞保存，迟到的 %s 不干扰后续选择',
  async (permission) => {
    state.web = true;
    state.settings!.notificationEvents.mail = { banner: true, system: false };
    let resolve!: (permission: string) => void;
    vi.stubGlobal('Notification', {
      requestPermission: () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    });
    const { host, select, choose } = mount();
    await act(async () => choose('system'));
    expect(state.settings!.notificationEvents.mail).toEqual({ banner: false, system: true });
    expect(select.disabled).toBe(false);
    expect(select.getAttribute('aria-busy')).toBe('false');
    await act(async () => choose('off'));
    await act(async () => resolve(permission));
    expect(select.value).toBe('off');
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(state.preference).not.toHaveBeenCalled();
  },
);
it('浏览器授权成功但启用偏好返回失败时，不将其当作完全成功', async () => {
  state.web = true;
  state.settings!.notificationEvents.mail = { banner: true, system: false };
  vi.stubGlobal('Notification', { requestPermission: async () => 'granted' });
  state.preference.mockResolvedValueOnce(false);
  const { host, select, choose } = mount();
  await act(async () => choose('both'));
  expect(select.value).toBe('both');
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('通知方式已保存');
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('未保存');
});
