import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SettingsDialog } from '../src/renderer/src/components/SettingsDialog';
import { normalizeNotificationEvents } from '@weq/service/notification-settings';
import {
  acceptPreferences,
  preferenceValue,
  retryPreferences,
  useClientPreferences,
} from '../src/renderer/src/lib/clientPreferences';

const fixture = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  settingKey: 'showMessageUnreadBadge',
  save: vi.fn(),
  invalidate: vi.fn(),
  loading: false,
  failed: false,
  // 共享偏好（clientPreferences）走 client.clientState.patch。
  shared: {} as Record<string, unknown>,
  sharedRevision: 0,
  patchCalls: [] as Array<Record<string, unknown>>,
  patchFail: false,
  patchDefer: false,
  releasePatch: null as null | (() => void),
}));
vi.mock('../src/renderer/src/trpc/client', () => {
  const proxy = (path: string[] = []): unknown =>
    new Proxy(() => proxy(path), {
      get: (_target, key) => {
        if (path.join('.') === 'clientState.patch' && key === 'mutate')
          return async (patch: Record<string, unknown>) => {
            fixture.patchCalls.push(patch);
            if (fixture.patchDefer)
              await new Promise<void>((resolve) => {
                fixture.releasePatch = resolve;
              });
            if (fixture.patchFail) throw new Error('保存失败');
            fixture.shared = { ...fixture.shared, ...patch };
            fixture.sharedRevision += 1;
            return {
              revision: fixture.sharedRevision,
              values: { ...fixture.shared },
              records: {},
            };
          };
        if (path.join('.') === 'clientState.snapshot' && key === 'query')
          return async () => ({
            revision: fixture.sharedRevision,
            values: { ...fixture.shared },
            records: {},
          });
        return key === 'useQuery'
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
              : proxy([...path, String(key)]);
      },
    });
  return { trpc: proxy(), client: proxy() };
});
vi.mock('../src/renderer/src/components/settings/HelpSection', () => ({ HelpSection: () => null }));
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  fixture.settings = { notificationEvents: normalizeNotificationEvents(undefined) };
  fixture.loading = false;
  fixture.failed = false;
  fixture.shared = {};
  fixture.sharedRevision = 0;
  fixture.patchCalls = [];
  fixture.patchFail = false;
  fixture.patchDefer = false;
  fixture.releasePatch = null;
  // 共享偏好是模块级状态：先把上一个用例残留的 pending 落盘，再用空快照清空共享值，
  // 否则 pending 会触发「尚未保存」提示并挡住设置页导航。
  await act(async () => {
    retryPreferences();
    await new Promise((resolve) => setTimeout(resolve, 0));
    acceptPreferences({ epoch: `test-${Date.now()}`, revision: 0, values: {}, records: {} }, false);
  });
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
          initialSection: 'chat-messages',
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
    toggle: (label: string) => {
      const page = ['群聊引用时自动 @ 对方', '按退格键移除引用'].includes(label)
        ? '消息发送'
        : [
              '消息气泡',
              '消息字体',
              '聊天头像挂件',
              '聊天 QQ 秀替换头像',
              '显示群消息发送者名称',
              '显示群成员等级',
              '显示群成员头衔与身份',
            ].includes(label)
          ? '消息显示'
          : ['在消息图标上显示红点', '软件更新'].includes(label)
            ? '主导航'
            : label === '在联系人界面显示未读消息数'
              ? '联系人'
              : [
                    '显示会话预览',
                    '鼠标停留时保持会话位置',
                    '会话互动红点',
                    '群助手显示总消息数',
                  ].includes(label)
                ? '消息'
                : '会话浏览';
      act(() =>
        [...host.querySelectorAll<HTMLButtonElement>('.weq-settings-nav-item')]
          .find((button) => button.textContent === page)!
          .click(),
      );
      const visibleLabel =
        (
          {
            聊天头像挂件: '头像挂件',
            '聊天 QQ 秀替换头像': '优先使用 QQ 秀替换头像',
            显示群消息发送者名称: '昵称或备注',
            显示群成员等级: '等级',
            显示群成员头衔与身份: '头衔或身份',
            在消息图标上显示红点: '消息导航未读角标',
            在联系人界面显示未读消息数: '好友与群聊未读消息数',
            群助手显示总消息数: '群助手',
          } as Record<string, string>
        )[label] ?? label;
      return (
        host.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${visibleLabel}"]`) ??
        [...host.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')].find(
          (button) => button.textContent === visibleLabel,
        )!
      );
    },
    close: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

/**
 * 「消息气泡 / 消息字体 / 聊天头像挂件 / 聊天 QQ 秀替换头像」自 bc972cf1 起改用
 * SharedDisplayToggle → clientPreferences 的共享偏好（乐观更新 + 失败可重试），
 * 不再走 AppSettings 的 per-setting mutation。下面两组分别断言各自的通道。
 */
const sharedToggles = [
  ['在消息图标上显示红点', 'showMessageUnreadBadge', true],
  ['在联系人界面显示未读消息数', 'showContactUnreadCount', false],
  ['软件更新', 'showSoftwareUpdateBadge', true],
  ['群助手显示总消息数', 'showGroupAssistantMessageCount', false],
  ['会话互动红点', 'showInteractionBadge', false],
  ['显示会话预览', 'showConversationPreview', true],
  ['鼠标停留时保持会话位置', 'keepConversationPositionOnHover', false],
  ['消息气泡', 'showMessageBubble', true],
  ['消息字体', 'showMessageFont', true],
  ['聊天头像挂件', 'showAvatarPendant', true],
  ['聊天 QQ 秀替换头像', 'showChatQqShow', true],
  ['群聊引用时自动 @ 对方', 'autoMentionOnQuote', false],
  ['按退格键移除引用', 'backspaceRemovesQuote', true],
  ['显示群消息发送者名称', 'showGroupMemberName', true],
  ['显示群成员等级', 'showGroupMemberLevel', true],
  ['显示群成员头衔与身份', 'showGroupMemberTitle', true],
] as const;

const toggles = [
  ['打开会话时继续上次阅读', 'readFromFirstUnread', false],
  ['在底部时跟随新消息', 'autoFollowLatestMessages', true],
  ['发送后回到最新消息', 'jumpToLatestAfterSend', true],
  ['向下浏览时显示「回到最新」按钮', 'showScrollToBottomButton', true],
] as const;

it('主导航直接配置消息角标，常规视图角标由消息页配置', () => {
  const f = mount();
  try {
    f.toggle('在消息图标上显示红点');
    const navigation = f.host.querySelector(
      '[data-settings-page="main-navigation"]:not([hidden])',
    )!;
    expect(navigation.querySelector('[aria-label="邮箱导航未读角标"]')).not.toBeNull();
    expect(navigation.querySelector('[aria-label="会话互动红点"]')).toBeNull();
    expect(navigation.textContent).not.toContain('前往设置');
    const interaction = f.toggle('会话互动红点');
    expect(interaction.closest('[data-settings-page]')?.getAttribute('data-settings-page')).toBe(
      'chat-messages',
    );
  } finally {
    f.close();
  }
});

it('消息开关分别按默认值展示、保存、刷新共享设置，重开后可恢复与再次开启', () => {
  let f = mount();
  const toggle = (label: string) => f.toggle(label);
  try {
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
      const toggle = f.toggle(label);
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
      const toggle = f.toggle(label);
      expect(toggle.disabled, label).toBe(true);
      act(() => toggle.click());
    }
    expect(fixture.save).not.toHaveBeenCalled();
  } finally {
    f.close();
  }
});

it('阅读位置开关切换时显示相应子项，并保留未读计数偏好', () => {
  const f = mount();
  const parent = () => f.toggle('打开会话时继续上次阅读');
  const manual = () => f.host.querySelector('[role="radiogroup"][aria-label="继续上次阅读按钮"]');
  const manualMode = () => manual()?.querySelector('[role="radio"][aria-checked="true"]');
  const child = () => f.toggle('按阅读进度更新未读数');
  try {
    expect(child()).toBeUndefined();
    expect(manualMode()?.textContent).toBe('切回后仍提示');
    act(() => parent().click());
    f.render();
    expect(manual()).toBeNull();
    expect(child().getAttribute('aria-checked')).toBe('true');
    act(() => child().click());
    f.render();
    expect(fixture.settings.preserveUnreadUntilRead).toBe(false);

    act(() => parent().click());
    f.render();
    expect(child()).toBeUndefined();
    expect(manualMode()?.textContent).toBe('切回后仍提示');
    act(() => parent().click());
    f.render();
    expect(manual()).toBeNull();
    expect(child().getAttribute('aria-checked')).toBe('false');
  } finally {
    f.close();
  }
});

it('共享显示开关走 clientPreferences：改为共享值、失败保留本机值并可重试', async () => {
  let f = mount();
  try {
    for (const [label, key, defaultValue] of sharedToggles) {
      const toggle = () => f.toggle(label);
      vi.clearAllMocks();
      fixture.patchCalls = [];
      expect(preferenceValue(key), label).toBe(defaultValue);
      expect(
        toggle().getAttribute('aria-checked') ?? toggle().getAttribute('aria-pressed'),
        label,
      ).toBe(String(defaultValue));
      await act(async () => {
        toggle().click();
        await vi.waitFor(() => expect(fixture.shared[key], label).toBe(!defaultValue));
      });
      expect(fixture.patchCalls.length, label).toBe(1);
      expect(fixture.patchCalls[0], label).toEqual({ [key]: !defaultValue });
      expect(fixture.shared[key], label).toBe(!defaultValue);
      expect(fixture.invalidate, label).not.toHaveBeenCalled();
      f.render();
      expect(
        toggle().getAttribute('aria-checked') ?? toggle().getAttribute('aria-pressed'),
        label,
      ).toBe(String(!defaultValue));
    }
    f.close();
    // 重新挂载：共享值仍是上一次修改后的值。
    f = mount();
    for (const [label, key, defaultValue] of sharedToggles) {
      expect(preferenceValue(key), label).toBe(!defaultValue);
      expect(
        f.toggle(label).getAttribute('aria-checked') ??
          f.toggle(label).getAttribute('aria-pressed'),
        label,
      ).toBe(String(!defaultValue));
    }
  } finally {
    f.close();
  }
});

it('共享显示开关保存失败时保留本机值（可重试），保存期间重复点击不会丢最新值', async () => {
  const f = mount();
  try {
    fixture.patchFail = true;

    for (const [label, key, defaultValue] of sharedToggles) {
      const element = f.toggle(label);
      const toggle = () => element;
      vi.clearAllMocks();
      fixture.patchCalls = [];
      await act(async () => {
        toggle().click();
        await vi.waitFor(() =>
          expect(useClientPreferences.getState().error, label).toContain('设置未保存'),
        );
      });
      expect(fixture.patchCalls.length, label).toBe(1);
      // 乐观更新：本机值已经是新值，服务端还没接受。
      expect(preferenceValue(key), label).toBe(!defaultValue);
      expect(fixture.shared[key], label).toBeUndefined();
      // 失败提示由共享偏好的状态提示（ClientStateSync 横幅）承载，这里断言提示内容本身。
      await vi.waitFor(() =>
        expect(useClientPreferences.getState().error, label).toContain('设置未保存'),
      );
      // 修好服务端后重试，同一个值会被再次提交。
      fixture.patchFail = false;
      vi.clearAllMocks();
      await act(async () => {
        retryPreferences();
        await vi.waitFor(() => expect(fixture.shared[key], label).toBe(!defaultValue));
      });
      expect(fixture.patchCalls[0], label).toEqual({ [key]: !defaultValue });
      await vi.waitFor(() => expect(useClientPreferences.getState().error, label).toBe(''));
      fixture.patchFail = true;
    }
  } finally {
    f.close();
  }
});
