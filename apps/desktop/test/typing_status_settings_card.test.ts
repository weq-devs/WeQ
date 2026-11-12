import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TypingStatusSettingsCard } from '../src/renderer/src/components/settings/TypingStatusSettingsCard';
import type { TypingStatusSettings } from '@weq/service';
import type { PickItem } from '../src/renderer/src/views/export/types';
import { DialogHost, useDialog } from '../src/renderer/src/components/Dialog';
import { useAppLock } from '../src/renderer/src/state/lock';

const mocks = vi.hoisted(() => ({
  preferences: { mode: 'off', hidden: [] } as TypingStatusSettings,
  setMode: vi.fn(),
  setHidden: vi.fn(),
  conversationQuery: vi.fn(),
  account: { uin: '10001', configId: 'source-a' },
  conversationError: null as Error | null,
  conversations: [
    {
      chatType: 'C2C',
      targetUid: 'u_peer',
      targetUin: '20002',
      targetDisplayName: '好友甲',
      messageCount: 3,
    },
    {
      chatType: 'C2C',
      targetUid: 'u_other',
      targetUin: '20003',
      targetDisplayName: '好友乙',
      messageCount: 1,
    },
    {
      chatType: 'GROUP',
      targetUid: '123456',
      targetUin: '123456',
      targetDisplayName: '群聊不该出现',
      messageCount: 5,
    },
  ],
}));

vi.mock('../src/renderer/src/hooks/useTypingStatusSettings', () => ({
  useTypingStatusSettings: () => ({
    query: { data: mocks.preferences, isLoading: false, isFetching: false, error: null },
    disabled: false,
    setMode: mocks.setMode,
    setHidden: mocks.setHidden,
  }),
}));

vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    account: {
      getAccountConfig: {
        useQuery: () => ({ data: mocks.account }),
      },
      listConversationsWithCount: {
        useQuery: (...args: unknown[]) => {
          mocks.conversationQuery(...args);
          return { data: mocks.conversations, error: mocks.conversationError };
        },
      },
    },
  },
}));

vi.mock('../src/renderer/src/views/export/ConversationPicker', () => ({
  ConversationPicker: ({
    items,
    selected,
    onChange,
  }: {
    items: PickItem[];
    selected: Set<string>;
    onChange: (next: Set<string>) => void;
  }) =>
    h(
      'div',
      { 'data-testid': 'picker' },
      items.map((item) =>
        h(
          'button',
          {
            key: item.id,
            type: 'button',
            'aria-pressed': selected.has(item.id),
            onClick: () => {
              const next = new Set(selected);
              if (next.has(item.id)) next.delete(item.id);
              else next.add(item.id);
              onChange(next);
            },
          },
          item.name,
        ),
      ),
    ),
}));

afterEach(() => {
  mocks.preferences = { mode: 'off', hidden: [] };
  mocks.setMode.mockReset();
  mocks.setHidden.mockReset();
  mocks.conversationQuery.mockClear();
  mocks.account = { uin: '10001', configId: 'source-a' };
  mocks.conversationError = null;
  useAppLock.setState({ locked: false });
  useDialog.setState({ current: null });
  vi.unstubAllGlobals();
});

function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = () =>
    act(() => root.render(h('div', null, h(TypingStatusSettingsCard), h(DialogHost))));
  render();
  return {
    host,
    render,
    dispose: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

function openEditor(host: HTMLElement) {
  act(() =>
    host.querySelector<HTMLButtonElement>('[aria-label="编辑隐藏正在输入状态的会话"]')!.click(),
  );
}

function radio(host: HTMLElement, label: string): HTMLButtonElement {
  return [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
    (button) => button.textContent === label,
  )!;
}

describe('隐藏正在输入状态设置卡', () => {
  it('默认关闭范围，不展示隐藏会话设置', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const f = mount();
    try {
      expect(f.host.querySelector('.weq-set-card-title')?.textContent).toContain(
        '隐藏正在输入状态',
      );
      expect(radio(f.host, '关闭').getAttribute('aria-checked')).toBe('true');
      expect(radio(f.host, '按会话勾选')).not.toBeNull();
      expect(radio(f.host, '永久全选')).not.toBeNull();
      expect(f.host.textContent).toContain('默认向对方展示正在输入状态');
      expect(f.host.querySelector('[data-setting-id="typing-status-hidden"]')).toBeNull();
      expect(f.host.querySelector('[data-testid="picker"]')).toBeNull();
    } finally {
      f.dispose();
    }
  });

  it('切换启用范围调用保存；按会话勾选时只列私聊并可保存隐藏清单', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.preferences = { mode: 'selected', hidden: [] };
    const f = mount();
    try {
      expect(f.host.textContent).toContain('已选择 0 个会话');
      expect(f.host.querySelector('[data-testid="picker"]')).toBeNull();
      expect(mocks.conversationQuery).toHaveBeenLastCalledWith(
        undefined,
        expect.objectContaining({ enabled: false }),
      );
      openEditor(f.host);
      expect(mocks.conversationQuery).toHaveBeenLastCalledWith(
        undefined,
        expect.objectContaining({ enabled: true }),
      );
      const picker = document.querySelector('[data-testid="picker"]')!;
      expect(picker.textContent).not.toContain('群聊不该出现');
      await act(async () => picker.querySelector<HTMLButtonElement>('button')!.click());
      const save = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
        button.textContent?.includes('保存选择'),
      )!;
      await act(async () => save.click());
      expect(mocks.setHidden).toHaveBeenCalledWith(
        [{ accountUin: '10001', accountConfigId: 'source-a', uid: 'u_peer', name: '好友甲' }],
        { expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' },
      );
      await act(async () => radio(f.host, '永久全选').click());
      expect(mocks.setMode).toHaveBeenCalledWith('all');
    } finally {
      f.dispose();
    }
  });

  it('已保存的隐藏会话按账号与数据源回显，其他来源不串入', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.preferences = {
      mode: 'selected',
      hidden: [
        {
          accountUin: '10001',
          accountConfigId: 'source-a',
          uid: 'u_other',
          name: '好友乙',
        },
        {
          accountUin: '10001',
          accountConfigId: 'source-b',
          uid: 'u_peer',
          name: '好友甲',
        },
      ],
    };
    const f = mount();
    try {
      expect(f.host.textContent).toContain('已选择 1 个会话');
      openEditor(f.host);
      const buttons = [
        ...document.querySelectorAll<HTMLButtonElement>('[data-testid="picker"] button'),
      ];
      expect(buttons.find((b) => b.textContent === '好友乙')?.getAttribute('aria-pressed')).toBe(
        'true',
      );
      expect(buttons.find((b) => b.textContent === '好友甲')?.getAttribute('aria-pressed')).toBe(
        'false',
      );
    } finally {
      f.dispose();
    }
  });

  it('关闭未保存的选择需确认，放弃后重新打开恢复已保存清单且保留其他数据源', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const other = {
      accountUin: '10001',
      accountConfigId: 'source-b',
      uid: 'u_other',
      name: '好友乙',
    };
    mocks.preferences = { mode: 'selected', hidden: [other] };
    const f = mount();
    try {
      openEditor(f.host);
      act(() =>
        document.querySelector<HTMLButtonElement>('[data-testid="picker"] button')!.click(),
      );
      act(() =>
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
      );
      expect(useDialog.getState().current?.title).toBe('放弃未保存的修改？');
      await act(async () =>
        [...document.querySelectorAll<HTMLButtonElement>('button')]
          .find((b) => b.textContent === '放弃修改')!
          .click(),
      );
      expect(document.querySelector('.weq-tool-modal')).toBeNull();
      openEditor(f.host);
      expect(
        document.querySelector('[data-testid="picker"] button')?.getAttribute('aria-pressed'),
      ).toBe('false');
      act(() =>
        document.querySelector<HTMLButtonElement>('[data-testid="picker"] button')!.click(),
      );
      await act(async () =>
        [...document.querySelectorAll<HTMLButtonElement>('button')]
          .find((b) => b.textContent?.includes('保存选择'))!
          .click(),
      );
      expect(mocks.setHidden).toHaveBeenCalledWith(
        [{ accountUin: '10001', accountConfigId: 'source-a', uid: 'u_peer', name: '好友甲' }],
        { expectedAccountUin: '10001', expectedAccountConfigId: 'source-a' },
      );
    } finally {
      f.dispose();
    }
  });

  it('保存成功更新数量摘要，关闭不再要求放弃修改', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.preferences = { mode: 'selected', hidden: [] };
    const f = mount();
    mocks.setHidden.mockImplementation(async (hidden) => {
      mocks.preferences = { mode: 'selected', hidden };
      f.render();
    });
    try {
      openEditor(f.host);
      act(() =>
        document.querySelector<HTMLButtonElement>('[data-testid="picker"] button')!.click(),
      );
      await act(async () =>
        [...document.querySelectorAll<HTMLButtonElement>('button')]
          .find((b) => b.textContent?.includes('保存选择'))!
          .click(),
      );
      expect(f.host.textContent).toContain('已选择 1 个会话');
      act(() =>
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
      );
      expect(document.querySelector('.weq-tool-modal')).toBeNull();
      expect(useDialog.getState().current).toBeNull();
    } finally {
      f.dispose();
    }
  });

  it('切换数据源或锁屏后关闭选择工具，读取失败不能保存空清单', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.preferences = { mode: 'selected', hidden: [] };
    const f = mount();
    try {
      openEditor(f.host);
      mocks.account = { uin: '10001', configId: 'source-b' };
      f.render();
      expect(document.querySelector('.weq-tool-modal')).toBeNull();
      openEditor(f.host);
      act(() => useAppLock.setState({ locked: true }));
      expect(document.querySelector('.weq-tool-modal')).toBeNull();
      act(() => useAppLock.setState({ locked: false }));
      mocks.conversationError = new Error('读取失败');
      openEditor(f.host);
      const save = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
        b.textContent?.includes('保存选择'),
      )!;
      expect(save.disabled).toBe(true);
      await act(async () => save.click());
      expect(mocks.setHidden).not.toHaveBeenCalled();
    } finally {
      f.dispose();
    }
  });
});
