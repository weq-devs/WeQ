import { act, createElement as h, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComposerSendButton } from '../src/renderer/src/im-template/template/composerSendButton';
import { muteCountdownText } from '../src/renderer/src/im-template/template/composerSendButton.shared';
import { ChatPane } from '../src/renderer/src/im-template/template/chatPane';
import { createTemplateDemoData } from './support/templateDemoData';

const rpc = vi.hoisted(() => ({
  permissions: { role: 'member' as 'owner' | 'admin' | 'member', muteAll: false, muteUntil: 0 },
  uin: '',
  reads: 0,
}));
vi.mock('../src/renderer/src/trpc/client', () => {
  const proxy = (path = ''): unknown =>
    new Proxy(() => proxy(path), {
      get: (_target, key) =>
        key === 'useQuery'
          ? () => {
              if (path.endsWith('.groupPermissions')) rpc.reads++;
              return {
                data: path.endsWith('.groupPermissions')
                  ? rpc.permissions
                  : path.endsWith('.getAccountConfig')
                    ? { uin: rpc.uin, configId: 'fixture' }
                    : undefined,
                isLoading: false,
                isFetching: false,
              };
            }
          : key === 'useMutation'
            ? () => ({ mutate: vi.fn(), mutateAsync: vi.fn() })
            : proxy(`${path}.${String(key)}`),
    });
  return { trpc: proxy(), client: proxy() };
});

const cleanups: (() => void)[] = [];
const now = Date.parse('2030-01-01T00:00:00+08:00');
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  rpc.permissions = { role: 'member', muteAll: false, muteUntil: 0 };
  rpc.reads = 0;
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function host() {
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  cleanups.push(() => {
    act(() => root.unmount());
    element.remove();
  });
  return { element, root };
}

describe('禁言发送按钮', () => {
  it.each([
    [-1, '00:00'],
    [0.1, '00:01'],
    [59, '00:59'],
    [60, '01:00'],
    [3599, '59:59'],
    [3600, '1 时 00 分'],
    [7200 + 300, '2 时 05 分'],
    [86_400, '1 天 0 时'],
    [28 * 86_400 + 23 * 3600, '28 天 23 时'],
  ])('剩余 %s 秒显示 %s', (remaining, expected) => {
    expect(muteCountdownText(now / 1000 + remaining, now)).toBe(expected);
  });

  it.each(['desktop', 'expanded'] as const)('%s 全员禁言替换图标和可见文案', (variant) => {
    const f = host();
    const send = vi.fn();
    act(() =>
      f.root.render(
        h(ComposerSendButton, {
          variant,
          disabled: false,
          title: '发送',
          restriction: { kind: 'all' },
          active: true,
          onSend: send,
        }),
      ),
    );
    const button = f.element.querySelector('button')!;
    expect(button.textContent).toBe('全员禁言');
    expect(button.disabled).toBe(true);
    expect(button.querySelector('.lucide-message-square-off')).not.toBeNull();
    expect(button.querySelector('.lucide-send-horizontal')).toBeNull();
    expect(button.getAttribute('aria-label')).toContain('全员禁言');
    act(() => button.click());
    expect(send).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('隐藏时停止倒计时，恢复时读取当前剩余时间，卸载时清理时钟', () => {
    const f = host();
    const props = {
      variant: 'desktop' as const,
      disabled: true,
      title: '发送',
      restriction: { kind: 'personal' as const, until: now / 1000 + 90 },
      onSend: vi.fn(),
    };
    act(() => f.root.render(h(ComposerSendButton, { ...props, active: true })));
    expect(f.element.textContent).toBe('禁言 01:30');
    act(() => vi.advanceTimersByTime(1000));
    expect(f.element.textContent).toBe('禁言 01:29');
    act(() => f.root.render(h(ComposerSendButton, { ...props, active: false })));
    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.advanceTimersByTime(29_000));
    act(() => f.root.render(h(ComposerSendButton, { ...props, active: true })));
    expect(f.element.textContent).toBe('禁言 01:00');
    act(() => f.root.unmount());
    expect(vi.getTimerCount()).toBe(0);
  });

  it('正常发送保留点击和编辑焦点行为，其他禁用原因不冒充禁言', () => {
    const f = host();
    const send = vi.fn();
    const props = {
      variant: 'desktop' as const,
      restriction: null,
      active: true,
      onSend: send,
    };
    act(() => f.root.render(h(ComposerSendButton, { ...props, title: '发送', disabled: false })));
    const button = f.element.querySelector('button')!;
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    act(() => button.dispatchEvent(down));
    expect(down.defaultPrevented).toBe(true);
    act(() => button.click());
    expect(send).toHaveBeenCalledOnce();
    act(() =>
      f.root.render(h(ComposerSendButton, { ...props, title: 'QQ 未在线', disabled: true })),
    );
    expect(button.textContent).toBe('发送');
    expect(button.getAttribute('aria-label')).toBe('QQ 未在线');
    expect(button.hasAttribute('data-muted')).toBe(false);
    act(() => button.click());
    expect(send).toHaveBeenCalledOnce();
  });
});

async function mountChat(overrides: Partial<ComponentProps<typeof ChatPane>> = {}) {
  const f = host();
  const demo = createTemplateDemoData();
  rpc.uin = demo.user.identityValue;
  const props = {
    user: demo.user,
    conversation: demo.conversations.find((row) => row.type === 'group')!,
    messages: [],
    draft: '保留草稿',
    loading: false,
    onDraftChange: vi.fn(),
    onDraftClear: vi.fn(),
    onBack: vi.fn(),
    onSend: vi.fn(),
    ...overrides,
  };
  const render = async () => {
    await act(async () => f.root.render(h(ChatPane, props)));
  };
  await render();
  return { ...f, props, render };
}

it.each([false, true])('个人禁言倒计时不重绘聊天区，到期处理全员禁言=%s', async (muteAll) => {
  rpc.permissions = { role: 'member', muteAll, muteUntil: now / 1000 + 3 };
  const f = await mountChat();
  const button = f.element.querySelector<HTMLButtonElement>('.composer-send')!;
  expect(button.textContent).toBe('禁言 00:03');
  const reads = rpc.reads;
  act(() => vi.advanceTimersByTime(1000));
  expect(button.textContent).toBe('禁言 00:02');
  expect(rpc.reads).toBe(reads);
  await act(async () => vi.advanceTimersByTime(2000));
  expect(button.textContent).toBe('禁言 00:00');
  await act(async () => vi.advanceTimersByTime(10));
  expect(button.textContent).toBe(muteAll ? '全员禁言' : '发送');
  expect(button.disabled).toBe(muteAll);
  expect(f.element.querySelector('.composer-editor')!.textContent).toBe('保留草稿');
  expect(f.props.onSend).not.toHaveBeenCalled();
});

it('提前解除后恢复发送，手机展开页使用相同禁言状态', async () => {
  rpc.permissions.muteAll = true;
  const f = await mountChat();
  act(() => f.element.querySelector<HTMLButtonElement>('.mobile-composer-expand-button')!.click());
  expect(f.element.querySelector('.composer-send-expanded')!.textContent).toBe('全员禁言');
  rpc.permissions = { ...rpc.permissions, muteAll: false };
  await f.render();
  const button = f.element.querySelector<HTMLButtonElement>('.composer-send-expanded')!;
  expect(button.textContent).toBe('');
  expect(button.disabled).toBe(false);
  expect(button.querySelector('.lucide-send-horizontal')).not.toBeNull();
});

it.each(['owner', 'admin'] as const)('全员禁言不替换 %s 的正常发送按钮', async (role) => {
  rpc.permissions = { role, muteAll: true, muteUntil: 0 };
  const f = await mountChat();
  const button = f.element.querySelector<HTMLButtonElement>('.composer-send')!;
  expect(button.textContent).toBe('发送');
  expect(button.disabled).toBe(false);
});

it.each(['个人禁言', '全员禁言'])('%s 禁止在原群发送，但不阻断多选转发', async (mode) => {
  rpc.permissions.muteAll = mode === '全员禁言';
  rpc.permissions.muteUntil = mode === '个人禁言' ? now / 1000 + 60 : 0;
  const demo = createTemplateDemoData();
  const conversation = demo.conversations.find((row) => row.type === 'group')!;
  const message = { ...demo.messages[0]!, id: '101', conversationId: conversation.id };
  const onForwardMessages = vi.fn();
  const onMergeForward = vi.fn();
  const f = await mountChat({
    conversation,
    messages: [message],
    onForwardMessages,
    onMergeForward,
  });
  expect(f.element.querySelector<HTMLButtonElement>('.composer-send')?.disabled).toBe(true);
  await act(async () =>
    f.element
      .querySelector('[data-message-id="101"] .message-bubble')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })),
  );
  const click = (selector: string) =>
    act(async () => document.querySelector<HTMLButtonElement>(selector)!.click());
  await click('.message-context-menu [aria-label="多选"]');
  for (const [label, forward] of [
    ['逐条转发', onForwardMessages],
    ['合并转发', onMergeForward],
  ] as const) {
    await click('.selection-bar [aria-label="转发"]');
    await click(`[role="menuitem"][title="${label}"]`);
    expect(forward).toHaveBeenCalledWith([message], conversation);
  }
});
