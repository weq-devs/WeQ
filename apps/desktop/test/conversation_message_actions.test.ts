import { act, createElement as h, type ReactNode, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationMessageActions } from '../src/renderer/src/components/ConversationMessageActions';
import { createTemplateDemoData } from './support/templateDemoData';
import type { Conversation } from '../src/renderer/src/im-template/template/types';
import { ConversationDirectoryContext } from '../src/renderer/src/lib/conversationDirectory';
import { ContentSelectionProvider } from '../src/renderer/src/state/contentSelection';
import { useContentExportRequest } from '../src/renderer/src/state/contentSelection.shared';

vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: { account: { roamingBackfill: { list: { useQuery: () => ({ data: { jobs: [] } }) } } } },
}));
vi.mock('../src/renderer/src/components/OverlayLayer', () => ({
  OverlayLayer: ({ children }: { children: ReactNode }) => children,
}));
beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(() => vi.unstubAllGlobals());

function mount(
  conversation: Conversation,
  options: Partial<ComponentProps<typeof ConversationMessageActions>> = {},
) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const onAnalyze = vi.fn();
  const onRoaming = vi.fn();
  function Probe() {
    return h('output', null, JSON.stringify(useContentExportRequest()?.selection ?? null));
  }
  const render = (row: Conversation, props = options) =>
    act(() =>
      root.render(
        h(
          ContentSelectionProvider,
          null,
          h(
            ConversationDirectoryContext.Provider,
            { value: { virtual: [], onVirtual: vi.fn(), onCreate: vi.fn(), onAnalyze } },
            h(ConversationMessageActions, { conversation: row, onRoaming, ...props }),
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
    open: (label = '工具') =>
      act(() => host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click()),
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

describe('会话消息与工具菜单', () => {
  const base = createTemplateDemoData().conversations.find((row) => row.type === 'group')!;
  const group = { ...base, id: '10001', group: { ...base.group, id: '10001' } };

  it('工具操作绑定当前群聊，保留消息与成员名单的不同导出目标', () => {
    const f = mount(group);
    try {
      expect(f.host.querySelector('[aria-label="工具"] .lucide-wrench')).not.toBeNull();
      f.open();
      expect(
        [...f.host.querySelectorAll('[role="menuitem"]')].map((node) => node.textContent),
      ).toEqual(['拉取漫游消息', '会话分析', '导出聊天记录', '导出群成员名单']);
      f.click('会话分析');
      expect(f.onAnalyze).toHaveBeenCalledWith(group);
      expect(f.host.querySelector('[role="menu"]')).toBeNull();
      f.open();
      f.click('导出聊天记录');
      expect(f.selection()).toEqual({
        owner: { kind: 'messages', container: 'group:10001' },
        scope: { type: 'all' },
      });
      f.open();
      f.click('导出群成员名单');
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
      ).toEqual(['拉取漫游消息', '会话分析', '导出聊天记录']);
      f.click('导出聊天记录');
      expect(f.selection().owner).toEqual({ kind: 'messages', container: 'direct:u_friend' });
    } finally {
      f.close();
    }
  });

  it('虚拟会话不暴露不支持的分析和导出入口', () => {
    const f = mount({ ...group, id: 'virtual:group' });
    try {
      expect(f.host.querySelector('[aria-label="工具"]')).toBeNull();
    } finally {
      f.close();
    }
  });
  it('手机按一级功能展开，切换分组、执行和切换布局时不残留旧菜单', () => {
    const settings = vi.fn();
    const recalled = vi.fn();
    const important = vi.fn();
    const f = mount(group, {
      compact: true,
      onSearch: vi.fn(),
      onSettings: settings,
      onImportant: important,
      onRecalled: recalled,
      onDeleted: vi.fn(),
      onAdd: vi.fn(),
      onBug: vi.fn(),
      bugOnline: true,
    });
    try {
      expect(f.host.querySelector('[aria-label="更多会话操作"] .lucide-ellipsis')).not.toBeNull();
      f.open('更多会话操作');
      expect(f.host.querySelector('[role="menu"]')?.classList.contains('is-header-dropdown')).toBe(
        true,
      );
      expect(
        [...f.host.querySelectorAll('[role="menuitem"]')].map((node) => node.textContent),
      ).toEqual(['反馈 Bug', '搜索', '消息', '工具', '会话设置']);
      f.click('消息');
      expect(f.host.querySelector('[role="group"][aria-label="消息"]')).not.toBeNull();
      f.click('已撤回消息');
      expect(recalled).toHaveBeenCalledWith(group);
      expect(f.host.querySelector('[role="menu"]')).toBeNull();
      f.open('更多会话操作');
      f.click('消息');
      f.click('工具');
      expect(f.host.querySelector('[role="group"][aria-label="消息"]')).toBeNull();
      f.click('导出聊天记录');
      expect(f.selection().owner).toEqual({ kind: 'messages', container: 'group:10001' });
      f.open('更多会话操作');
      f.click('会话设置');
      expect(settings).toHaveBeenCalledOnce();
      expect(f.host.querySelector('[role="menu"]')).toBeNull();
      f.open('更多会话操作');
      f.render(group, { compact: false });
      expect(f.host.querySelector('[role="menu"]')).toBeNull();
      expect(f.host.querySelector('[aria-label="工具"]')).not.toBeNull();
    } finally {
      f.close();
    }
  });
});
