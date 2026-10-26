import { act, createElement as h, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationMessageActions } from '../src/renderer/src/components/ConversationMessageActions';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';
import type { Conversation } from '../src/renderer/src/im-template/template/types';
import { ConversationDirectoryContext } from '../src/renderer/src/lib/conversationDirectory';
import {
  ContentSelectionProvider,
  useContentExportRequest,
} from '../src/renderer/src/state/contentSelection';

vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: { account: { roamingBackfill: { list: { useQuery: () => ({ data: { jobs: [] } }) } } } },
}));
vi.mock('../src/renderer/src/components/OverlayLayer', () => ({
  OverlayLayer: ({ children }: { children: ReactNode }) => children,
}));
beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(() => vi.unstubAllGlobals());

function mount(conversation: Conversation) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const onAnalyze = vi.fn();
  const onRoaming = vi.fn();
  function Probe() {
    return h('output', null, JSON.stringify(useContentExportRequest()?.selection ?? null));
  }
  const render = (row: Conversation) =>
    act(() =>
      root.render(
        h(
          ContentSelectionProvider,
          null,
          h(
            ConversationDirectoryContext.Provider,
            { value: { virtual: [], onVirtual: vi.fn(), onCreate: vi.fn(), onAnalyze } },
            h(ConversationMessageActions, { conversation: row, onRoaming }),
          ),
          h(Probe),
        ),
      ),
    );
  render(conversation);
  return {
    host,
    onAnalyze,
    onRoaming,
    render,
    open: () =>
      act(() => host.querySelector<HTMLButtonElement>('[aria-label="消息管理"]')!.click()),
    click: (label: string) =>
      act(() =>
        [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
          .find((node) => node.textContent === label)!
          .click(),
      ),
    selection: () => JSON.parse(host.querySelector('output')!.textContent!),
    close: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

describe('会话消息管理菜单', () => {
  const base = createTemplateDemoData().conversations.find((row) => row.type === 'group')!;
  const group = { ...base, id: '10001', group: { ...base.group, id: '10001' } };

  it('按顺序提供分析、消息导出、名单导出和漫游，操作绑定当前群聊', () => {
    const f = mount(group);
    try {
      expect(
        f.host.querySelector('[aria-label="消息管理"] .lucide-message-square-text'),
      ).not.toBeNull();
      f.open();
      expect(
        [...f.host.querySelectorAll('[role="menuitem"]')].map((node) => node.textContent),
      ).toEqual(['分析', '导出', '导出名单', '拉取漫游消息']);
      f.click('分析');
      expect(f.onAnalyze).toHaveBeenCalledWith(group);
      expect(f.host.querySelector('[role="menu"]')).toBeNull();
      f.open();
      f.click('导出');
      expect(f.selection()).toEqual({
        owner: { kind: 'messages', container: 'group:10001' },
        scope: { type: 'all' },
      });
      f.open();
      f.click('导出名单');
      expect(f.selection()).toEqual({
        owner: { kind: 'contacts', container: 'group:10001' },
        scope: { type: 'all' },
      });
      f.open();
      f.click('拉取漫游消息');
      expect(f.onRoaming).toHaveBeenCalledWith(group);
    } finally {
      f.close();
    }
  });

  it('私聊不显示群名单，切换会话关闭菜单且导出使用新目标', () => {
    const base = createTemplateDemoData().conversations.find((row) => row.type === 'direct')!;
    const direct = { ...base, id: 'u_friend', otherUser: { ...base.otherUser, id: 'u_friend' } };
    const f = mount(group);
    try {
      f.open();
      f.render(direct);
      expect(f.host.querySelector('[role="menu"]')).toBeNull();
      f.open();
      expect(
        [...f.host.querySelectorAll('[role="menuitem"]')].map((node) => node.textContent),
      ).toEqual(['分析', '导出', '拉取漫游消息']);
      f.click('导出');
      expect(f.selection().owner).toEqual({ kind: 'messages', container: 'direct:u_friend' });
    } finally {
      f.close();
    }
  });

  it('虚拟会话不暴露不支持的分析和导出入口', () => {
    const f = mount({ ...group, id: 'virtual:group' });
    try {
      expect(f.host.querySelector('[aria-label="消息管理"]')).toBeNull();
    } finally {
      f.close();
    }
  });
});
