import { act, createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MergedSessionPanel } from '../src/renderer/src/components/sidebar/MergedSessionPanel';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import type { Conversation } from '../src/renderer/src/im-template/template/types';
import {
  loadGroupAssistantPins,
  saveGroupAssistantPins,
  sidebarConversationsWithoutAssistant,
} from '../src/renderer/src/lib/groupAssistant';

vi.mock('../src/renderer/src/trpc/client', () => {
  const query = { useQuery: () => ({ data: undefined }) };
  return {
    trpc: {
      account: {
        listOfficialAccounts: query,
        listServiceAccounts: query,
        listHiddenSessions: query,
        listDeletedSessions: query,
      },
    },
  };
});
afterEach(() => vi.unstubAllGlobals());

function groups(): Conversation[] {
  const group = createTemplateDemoData().conversations.find((row) => row.type === 'group')!;
  return [
    {
      ...group,
      id: '10001',
      updatedAt: '2026-10-18T02:00:00Z',
      preference: { pinned: false, muted: true, blocked: false },
    },
    {
      ...group,
      id: '10002',
      updatedAt: '2026-10-17T02:00:00Z',
      preference: { pinned: true, muted: true, blocked: false },
    },
  ];
}

describe('群助手', () => {
  it('定位后生成的临时群会话仍不能出现在主列表，普通群与聚合入口不受影响', () => {
    const [group, other] = groups();
    const assistant: Conversation = {
      ...group,
      type: 'merged' as const,
      id: 'merged:group-assistant',
      mergedKind: 'groupAssistant' as const,
      title: '群助手',
      avatarUrl: null,
      group: null,
      otherUser: null,
      members: [],
    };
    const temporary = { ...group, hidden: false, updatedAt: new Date().toISOString() };
    expect(
      sidebarConversationsWithoutAssistant([temporary, other, assistant], new Set([group.id])),
    ).toEqual([other, assistant]);
    expect(sidebarConversationsWithoutAssistant([temporary, other], new Set())).toEqual([
      temporary,
      other,
    ]);
  });

  it('内部置顶按账号持久化，明确取消可覆盖 QQ 原有置顶，损坏值不影响读取', () => {
    vi.stubGlobal('localStorage', new Storage());
    saveGroupAssistantPins('account-a', { '10001': true, '10002': false });
    expect(loadGroupAssistantPins('account-a')).toEqual({ '10001': true, '10002': false });
    expect(loadGroupAssistantPins('account-b')).toEqual({});
    localStorage.setItem('weq:group-assistant-pins:account-b', '{');
    expect(loadGroupAssistantPins('account-b')).toEqual({});
    localStorage.setItem(
      'weq:group-assistant-pins:account-b',
      '{"10001":true,"10002":"true","wrong":true}',
    );
    expect(loadGroupAssistantPins('account-b')).toEqual({ '10001': true });
  });

  it('点击图钉不打开会话或关闭面板，取消后恢复按时间排序，搜索保留置顶状态', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const conversations = groups();
    const back = vi.fn(),
      select = vi.fn();
    function View() {
      const [pins, setPins] = useState<Record<string, boolean>>({});
      return h(MergedSessionPanel, {
        kind: 'groupAssistant',
        conversations,
        groupAssistantIds: new Set(conversations.map((row) => row.id)),
        groupAssistantPins: pins,
        onGroupAssistantPin: (id, pinned) => setPins((value) => ({ ...value, [id]: pinned })),
        anchorX: 10,
        anchorY: 10,
        onBack: back,
        onSelectConversation: select,
      });
    }
    try {
      act(() => root.render(h(View)));
      act(() => host.querySelector<HTMLButtonElement>('[aria-label="取消群助手内置顶"]')!.click());
      expect(back).not.toHaveBeenCalled();
      expect(select).not.toHaveBeenCalled();
      expect(host.querySelector('.is-pinned')).toBeNull();
      act(() => host.querySelector<HTMLButtonElement>('.weq-merged-popover-item')!.click());
      expect(select.mock.calls[0][0].id).toBe('10001');
      act(() =>
        host.querySelectorAll<HTMLButtonElement>('[aria-label="在群助手内置顶"]')[1].click(),
      );
      const input = host.querySelector<HTMLInputElement>('input')!;
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
          input,
          '10002',
        );
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(host.querySelectorAll('.weq-merged-popover-item')).toHaveLength(1);
      expect(host.querySelector('[aria-pressed="true"]')).not.toBeNull();
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
  it('内部优先显示置顶群，不受较新的普通群消息影响', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const conversations = groups();
    const select = vi.fn();
    try {
      act(() =>
        root.render(
          h(MergedSessionPanel, {
            kind: 'groupAssistant',
            conversations,
            groupAssistantIds: new Set(conversations.map((row) => row.id)),
            anchorX: 10,
            anchorY: 10,
            onBack: vi.fn(),
            onSelectConversation: select,
          }),
        ),
      );
      act(() => host.querySelector<HTMLButtonElement>('.weq-merged-popover-item')!.click());
      expect(select.mock.calls[0][0].id).toBe('10002');
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
});
