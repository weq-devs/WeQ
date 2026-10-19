import { act, createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { ChatShell } from '../src/renderer/src/im-template/template/chatShell';
import {
  WorkspaceContent,
  WorkspacePage,
  WorkspacePages,
} from '../src/renderer/src/components/WorkspacePages';

vi.mock('../src/renderer/src/components/TitleBarSearch', () => ({ TitleBarSearch: () => null }));
vi.mock('../src/renderer/src/im-template/template/TitleBar', () => ({ TitleBar: () => null }));
vi.mock('../src/renderer/src/im-template/template/rail', () => ({ AppRail: () => null }));
vi.mock('../src/renderer/src/im-template/template/sidebar', () => ({
  SidebarHeader: () => null,
  SidebarResizeHandle: () => h('div', { className: 'sidebar-resize', role: 'separator' }),
}));

describe('主内容页的会话列表可见性', () => {
  it.each(['设置', '个性装扮'])('%s 收起列表与拖拽条，关闭后恢复列表现场与宽度', (title) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    let open = () => {};
    let close = () => {};
    function View() {
      const [shown, setShown] = useState(false);
      open = () => setShown(true);
      close = () => setShown(false);
      return h(
        WorkspacePages,
        { navigationKey: 'chat' },
        h(ChatShell, {
          view: 'messages',
          sidebarWidth: 362,
          sidebarContent: h('input', { 'data-list-filter': true }),
          mainContent: h(WorkspaceContent, null, '原聊天'),
        }),
        shown && h(WorkspacePage, { title, standalone: true, onClose: close }, title),
      );
    }
    try {
      act(() => root.render(h(View)));
      const sidebar = host.querySelector<HTMLElement>('.sidebar')!;
      const filter = host.querySelector<HTMLInputElement>('[data-list-filter]')!;
      const shell = host.querySelector<HTMLElement>('.app-shell')!;
      filter.value = '原会话筛选';
      expect(sidebar.hidden).toBe(false);
      act(() => open());
      expect(sidebar.hidden).toBe(true);
      expect(shell.style.getPropertyValue('--sidebar-width')).toBe('0px');
      expect(host.querySelector('.sidebar-resize')).toBeNull();
      expect(host.querySelector('.chat-main-open')).not.toBeNull();
      act(() => close());
      expect(sidebar.hidden).toBe(false);
      expect(shell.style.getPropertyValue('--sidebar-width')).toBe('362px');
      expect(host.querySelector('.sidebar-resize')).not.toBeNull();
      expect(host.querySelector('[data-list-filter]')).toBe(filter);
      expect(filter.value).toBe('原会话筛选');
    } finally {
      act(() => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    }
  });

  it.each(['群公告', '群精华', '群相册', '群文件'])(
    '%s 侧栏隐藏常规列表，关闭后恢复宽度与筛选现场',
    (title) => {
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
      const host = document.createElement('div');
      document.body.append(host);
      const root = createRoot(host);
      let open = () => {};
      let close = () => {};
      function View() {
        const [shown, setShown] = useState(false);
        open = () => setShown(true);
        close = () => setShown(false);
        return h(
          WorkspacePages,
          { navigationKey: 'chat' },
          h(ChatShell, {
            view: 'messages',
            sidebarWidth: 362,
            sidebarContent: h('input', { 'data-list-filter': true }),
            mainContent: h(WorkspaceContent, null, h('input', { 'data-chat-draft': true })),
          }),
          shown && h(WorkspacePage, { title, placement: 'sidecar', onClose: close }, title),
        );
      }
      try {
        act(() => root.render(h(View)));
        const sidebar = host.querySelector<HTMLElement>('.sidebar')!;
        const shell = host.querySelector<HTMLElement>('.app-shell')!;
        const filter = host.querySelector<HTMLInputElement>('[data-list-filter]')!;
        const draft = host.querySelector<HTMLInputElement>('[data-chat-draft]')!;
        filter.value = '原会话筛选';
        draft.value = '未发送草稿';
        act(() => open());
        expect(sidebar.hidden).toBe(true);
        expect(host.querySelector('.sidebar-resize')).toBeNull();
        expect(shell.style.getPropertyValue('--sidebar-width')).toBe('0px');
        expect(draft.closest('[hidden]')).toBeNull();
        expect(host.querySelector('.weq-workspace-sidecar')?.hasAttribute('hidden')).toBe(false);
        act(() => close());
        expect(sidebar.hidden).toBe(false);
        expect(host.querySelector('.sidebar-resize')).not.toBeNull();
        expect(shell.style.getPropertyValue('--sidebar-width')).toBe('362px');
        expect(host.querySelector('[data-list-filter]')).toBe(filter);
        expect(host.querySelector('[data-chat-draft]')).toBe(draft);
        expect(filter.value).toBe('原会话筛选');
        expect(draft.value).toBe('未发送草稿');
      } finally {
        act(() => root.unmount());
        host.remove();
        vi.unstubAllGlobals();
      }
    },
  );
});
