import { act, createElement as h, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationSettingsDialog } from '../src/renderer/src/components/ConversationSettingsDialog';
import { ContactWorkspaceNavigationContext } from '../src/renderer/src/lib/profileNavigation';

const intent = vi.hoisted(() => ({
  data: {
    enabled: false,
    engine: 'api',
    apiConfigured: true,
    conversationOverrides: {} as Record<string, boolean>,
  },
  mutate: vi.fn(async () => intent.data),
}));

vi.mock('../src/renderer/src/components/WindowSurface', () => ({
  WindowSurface: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../src/renderer/src/components/Dialog', () => ({
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
  trpc: {
    useUtils: () => ({ account: { intentSense: { getStatus: { setData: vi.fn() } } } }),
    account: {
      antiRecall: {
        getStatus: { useQuery: () => ({ data: {} }) },
        setScope: { useMutation: () => ({}) },
        setTargets: { useMutation: () => ({}) },
        setNotify: { useMutation: () => ({}) },
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
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});

it.each(['c2c', 'group', 'dataline'] as const)(
  '%s 仅联系人提供完整资料跳转，关闭设置后导航',
  (kind) => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const calls: string[] = [];
    const navigate = vi.fn(() => {
      calls.push('navigate');
    });
    cleanups.push(() => {
      act(() => root.unmount());
      host.remove();
    });
    act(() =>
      root.render(
        h(
          ContactWorkspaceNavigationContext.Provider,
          { value: navigate },
          h(ConversationSettingsDialog, {
            kind,
            conv: 'u_friend',
            title: '联系人',
            onClose: () => calls.push('close'),
          }),
        ),
      ),
    );
    const button = host.querySelector<HTMLButtonElement>('[aria-label="查看联系人资料"]');
    expect(Boolean(button)).toBe(kind === 'c2c');
    if (button) {
      act(() => button.click());
      expect(calls).toEqual(['close', 'navigate']);
      expect(navigate).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'person',
          tab: 'profile',
          contact: expect.objectContaining({ id: 'u_friend' }),
        }),
      );
    }
  },
);

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
