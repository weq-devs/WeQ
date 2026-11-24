import { act, createElement as h, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationSettingsDialog } from '../src/renderer/src/components/ConversationSettingsDialog';
import {
  normalizeNotificationEvents,
  notificationOverrideKey,
} from '@weq/service/notification-settings';
import { useNotificationPolicy } from '../src/renderer/src/lib/notificationPolicy';
import { acceptAccountState, bindAccountState } from '../src/renderer/src/lib/clientPreferences';
import { OPEN_NOTIFICATION_SETTINGS } from '../src/renderer/src/lib/notificationSettingsNavigation';

const intent = vi.hoisted(() => ({
  data: {
    enabled: false,
    engine: 'api',
    apiConfigured: true,
    conversationOverrides: {} as Record<string, boolean>,
  },
  mutate: vi.fn(async () => intent.data),
}));
const anti = vi.hoisted(() => ({
  data: {
    enabled: false,
    mode: 'selected',
    targets: [] as Array<{ kind: string; id: string }>,
    installed: [] as Array<{ name: string; table: string }>,
    notifyTargets: [] as string[],
    notifyEnabled: false,
    qqRunning: false,
  },
  refetch: vi.fn(),
  write: vi.fn(),
  writeNotify: vi.fn(),
  invalidateAccount: vi.fn(),
  invalidateSettings: vi.fn(),
}));
const accountPatch = vi.hoisted(() => vi.fn());

vi.mock('../src/renderer/src/components/WindowSurface', () => ({
  WindowSurface: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../src/renderer/src/components/Dialog', () => ({
  useDialog: () => vi.fn(),
}));
vi.mock('../src/renderer/src/components/Dialog.shared', () => ({
  useDialog: () => vi.fn(),
}));
vi.mock('../src/renderer/src/components/GroupKeywordEditor', () => ({
  GroupKeywordEditor: () => h('div', null, '关键词编辑器'),
}));
vi.mock('../src/renderer/src/components/QQConversationControls', () => ({
  QQConversationControls: ({ section }: { section?: string }) =>
    h('div', { 'data-testid': 'qq-controls', 'data-section': section ?? 'conversation' }),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: { clientState: { accountPatch: { mutate: accountPatch } } },
  trpc: {
    bootstrap: {
      getSettings: {
        useQuery: () => ({ data: { notificationEvents: normalizeNotificationEvents(undefined) } }),
      },
      setNotificationEvents: { useMutation: () => ({ mutateAsync: vi.fn() }) },
    },
    useUtils: () => ({
      settings: { antiRecall: { getStatus: { invalidate: anti.invalidateSettings } } },
      account: {
        intentSense: { getStatus: { setData: vi.fn() } },
        antiRecall: {
          getStatus: {
            invalidate: anti.invalidateAccount,
            setData: (_input: undefined, data: typeof anti.data) => {
              anti.data = data;
            },
          },
        },
      },
    }),
    account: {
      qqWrite: { peerState: { useQuery: () => ({}) } },
      antiRecall: {
        getStatus: { useQuery: () => ({ data: anti.data, refetch: anti.refetch }) },
        setScope: { useMutation: () => ({ mutateAsync: anti.write }) },
        setTargets: { useMutation: () => ({ mutateAsync: anti.write }) },
        setConversationNotify: {
          useMutation: ({ onSuccess }: { onSuccess: () => Promise<void> }) => ({
            mutateAsync: async (input: unknown) => {
              await anti.writeNotify(input);
              await onSuccess();
            },
          }),
        },
      },
      intentSense: {
        getStatus: { useQuery: () => ({ data: intent.data }) },
        setConversationOverride: { useMutation: () => ({ mutateAsync: intent.mutate }) },
      },
    },
  },
}));
const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  intent.data = { enabled: false, engine: 'api', apiConfigured: true, conversationOverrides: {} };
  intent.mutate.mockClear();
  anti.data = {
    enabled: false,
    mode: 'selected',
    targets: [],
    installed: [],
    notifyTargets: [],
    notifyEnabled: false,
    qqRunning: false,
  };
  anti.refetch.mockReset();
  anti.write.mockReset();
  anti.writeNotify.mockReset();
  anti.invalidateAccount.mockClear();
  anti.invalidateSettings.mockClear();
  accountPatch.mockReset();
  useNotificationPolicy.setState(useNotificationPolicy.getInitialState());
});

it('防撤回写入的期望触发器不冒充安装状态，独立回读后显示真实结果', async () => {
  const expected = {
    ...anti.data,
    enabled: true,
    targets: [{ kind: 'group', id: '12345' }],
    installed: [{ name: 'weq_anti_recall_group', table: 'group_msg_table' }],
  };
  anti.write.mockResolvedValue(expected);
  let resolve: (value: { data: typeof anti.data }) => void = () => {};
  anti.refetch.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  act(() =>
    root.render(
      h(ConversationSettingsDialog, {
        kind: 'group',
        conv: '12345',
        title: '群',
        onClose: vi.fn(),
      }),
    ),
  );
  act(() =>
    [...host.querySelectorAll<HTMLButtonElement>('.weq-cvs-nav-item')]
      .find((button) => button.textContent === '防撤回')!
      .click(),
  );
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="保护此会话"]')!.click(),
  );
  expect(host.textContent).toContain('正在核实安装状态');
  expect(host.textContent).not.toContain('触发器已安装');
  await act(async () => resolve({ data: { ...expected, installed: [] } }));
  expect(host.textContent).toContain('触发器尚未安装');
  expect(anti.refetch).toHaveBeenCalledTimes(1);
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  bindAccountState(null);
  vi.unstubAllGlobals();
});

it('全局不通知时仍可在当前会话开关提醒，并刷新两个设置入口', async () => {
  const policy = normalizeNotificationEvents(undefined);
  policy.recall = { banner: false, system: false };
  useNotificationPolicy.getState().setEvents(policy);
  anti.data.notifyTargets = ['c2c:123'];
  const onClose = vi.fn();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  const render = () =>
    act(() =>
      root.render(
        h(ConversationSettingsDialog, {
          kind: 'dataline',
          conv: '123',
          title: '手机',
          initialSection: 'notifications',
          onClose,
        }),
      ),
    );
  render();
  const toggle = host.querySelector<HTMLButtonElement>('[aria-label="本会话撤回提醒"]')!;
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  expect(toggle.disabled).toBe(false);
  await act(async () => toggle.click());
  expect(anti.writeNotify).toHaveBeenLastCalledWith({ kind: 'dataline', id: '123', enabled: true });
  anti.data.notifyTargets = ['c2c:123', 'dataline:123'];
  render();
  expect(toggle.getAttribute('aria-checked')).toBe('true');
  await act(async () => toggle.click());
  expect(anti.writeNotify).toHaveBeenLastCalledWith({
    kind: 'dataline',
    id: '123',
    enabled: false,
  });
  expect(anti.invalidateAccount).toHaveBeenCalledTimes(2);
  expect(anti.invalidateSettings).toHaveBeenCalledTimes(2);
  expect(onClose).not.toHaveBeenCalled();
});

it('在第二个分区单独保存当前群的提醒，即使全局渠道已关闭也不修改全局设置', async () => {
  const binding = { expectedAccountUin: '10001', expectedAccountConfigId: 'fixture' };
  const overrideKey = notificationOverrideKey('mentionMe', 'group:12345');
  bindAccountState(binding);
  acceptAccountState({ revision: 1, values: {}, records: {} }, binding);
  accountPatch.mockResolvedValue({
    revision: 2,
    values: {},
    records: { notifications: { [overrideKey]: false } },
  });
  const events = normalizeNotificationEvents({ mentionMe: { banner: false, system: false } });
  useNotificationPolicy.getState().setEvents(events);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const onClose = vi.fn();
  const navigation = vi.fn();
  window.addEventListener(OPEN_NOTIFICATION_SETTINGS, navigation);
  cleanups.push(() => {
    window.removeEventListener(OPEN_NOTIFICATION_SETTINGS, navigation);
    act(() => root.unmount());
    host.remove();
  });
  act(() =>
    root.render(
      h(ConversationSettingsDialog, {
        kind: 'group',
        conv: '12345',
        title: '群',
        notificationState: { muted: false, groupAssistant: false },
        onClose,
      }),
    ),
  );
  const section = host.querySelectorAll<HTMLButtonElement>('.weq-cvs-nav-item')[1]!;
  expect(section.textContent).toBe('消息提醒');
  act(() => section.click());
  expect(host.querySelector('[aria-label="本会话普通群聊消息提醒"]')).toBeNull();
  const toggle = host.querySelector<HTMLButtonElement>('[aria-label="本会话@自己提醒"]')!;
  expect(toggle.getAttribute('aria-checked')).toBe('true');
  await act(async () => toggle.click());
  expect(accountPatch).toHaveBeenCalledWith({
    ...binding,
    namespace: 'notifications',
    seed: false,
    values: { [overrideKey]: false },
  });
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  expect(useNotificationPolicy.getState().events.mentionMe).toEqual({
    banner: false,
    system: false,
  });
  act(() =>
    [...host.querySelectorAll('button')]
      .find((button) => button.textContent === '前往通知设置')!
      .click(),
  );
  expect(onClose).toHaveBeenCalledOnce();
  expect(navigation.mock.calls[0]?.[0].detail.settingId).toBe('notification-events');
});

it.each([
  { enabled: false, ready: true, override: undefined, checked: 'true', text: '应用意图感知已关闭' },
  { enabled: true, ready: false, override: undefined, checked: 'true', text: '引擎未就绪' },
  { enabled: true, ready: true, override: false, checked: 'false', text: '已在此会话关闭' },
  { enabled: true, ready: true, override: undefined, checked: 'true', text: '已在此会话生效' },
])('意图感知区分会话选择与生效状态 $text', async ({ enabled, ready, override, checked, text }) => {
  intent.data.enabled = enabled;
  intent.data.apiConfigured = ready;
  if (override === false) intent.data.conversationOverrides['c2c:u_friend'] = false;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  act(() =>
    root.render(
      h(ConversationSettingsDialog, {
        kind: 'c2c',
        conv: 'u_friend',
        title: '联系人',
        onClose: vi.fn(),
      }),
    ),
  );
  act(() =>
    [...host.querySelectorAll<HTMLButtonElement>('.weq-cvs-nav-item')]
      .find((button) => button.textContent === '意图感知')!
      .click(),
  );
  const toggle = host.querySelector<HTMLButtonElement>(
    '[aria-label="本会话意图感知跟随应用设置"]',
  )!;
  expect(toggle.getAttribute('aria-checked')).toBe(checked);
  expect(host.textContent).toContain(text);
  await act(async () => toggle.click());
  expect(intent.mutate).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: 'c2c',
      id: 'u_friend',
      enabled: checked === 'true' ? false : null,
    }),
  );
});

describe('会话设置默认页面', () => {
  it.each(['c2c', 'group', 'dataline'] as const)('%s 打开可用的默认设置', (kind) => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    cleanups.push(() => {
      act(() => root.unmount());
      host.remove();
    });
    act(() =>
      root.render(
        h(ConversationSettingsDialog, { kind, conv: '123', title: '测试', onClose: vi.fn() }),
      ),
    );
    expect(host.querySelector('.weq-cvs-nav-item.is-on')?.textContent).toBe(
      kind === 'dataline' ? '防撤回' : '会话偏好',
    );
    expect(host.querySelector('[data-testid="qq-controls"]') !== null).toBe(kind !== 'dataline');
    const management = [...host.querySelectorAll<HTMLButtonElement>('.weq-cvs-nav-item')].find(
      (button) => button.textContent === '群管理',
    );
    expect(Boolean(management)).toBe(kind === 'group');
    if (management) {
      act(() => management.click());
      expect(host.querySelector('.weq-cvs-nav-item.is-on')?.textContent).toBe('群管理');
      expect(host.querySelector('[data-testid="qq-controls"]')?.getAttribute('data-section')).toBe(
        'group-management',
      );
      const preferences = [...host.querySelectorAll<HTMLButtonElement>('.weq-cvs-nav-item')].find(
        (button) => button.textContent === '会话偏好',
      )!;
      act(() => preferences.click());
      expect(host.querySelector('[data-testid="qq-controls"]')?.getAttribute('data-section')).toBe(
        'conversation',
      );
    }
    const protect = [...host.querySelectorAll<HTMLButtonElement>('.weq-cvs-nav-item')].find(
      (button) => button.textContent === '防撤回',
    )!;
    act(() => protect.click());
    expect(host.querySelector('.weq-cvs-nav-item.is-on')?.textContent).toBe('防撤回');
  });
});
