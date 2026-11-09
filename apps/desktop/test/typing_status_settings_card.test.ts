import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TypingStatusSettingsCard } from '../src/renderer/src/components/settings/TypingStatusSettingsCard';
import type { TypingStatusSettings } from '@weq/service';
import type { PickItem } from '../src/renderer/src/views/export/types';

const mocks = vi.hoisted(() => ({
  preferences: { mode: 'off', hidden: [] } as TypingStatusSettings,
  setMode: vi.fn(),
  setHidden: vi.fn(),
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
        useQuery: () => ({ data: { uin: '10001', configId: 'source-a' } }),
      },
      listConversationsWithCount: { useQuery: () => ({ data: mocks.conversations }) },
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
  vi.unstubAllGlobals();
});

function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(h(TypingStatusSettingsCard)));
  return {
    host,
    dispose: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
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
      const picker = f.host.querySelector('[data-testid="picker"]')!;
      expect(picker.textContent).not.toContain('群聊不该出现');
      await act(async () =>
        f.host.querySelector<HTMLButtonElement>('[data-testid="picker"] button')!.click(),
      );
      const save = [...f.host.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
        button.textContent?.includes('保存选择'),
      )!;
      await act(async () => save.click());
      expect(mocks.setHidden).toHaveBeenCalledWith([
        { accountUin: '10001', accountConfigId: 'source-a', uid: 'u_peer', name: '好友甲' },
      ]);
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
      const buttons = [
        ...f.host.querySelectorAll<HTMLButtonElement>('[data-testid="picker"] button'),
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
});
