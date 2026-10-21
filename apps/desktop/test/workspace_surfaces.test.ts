import { act, createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Modal, DialogHost, useDialog } from '../src/renderer/src/components/Dialog';
import {
  WorkspaceContent,
  WorkspacePage,
  WorkspacePages,
} from '../src/renderer/src/components/WorkspacePages';
import { OverlayLayer } from '../src/renderer/src/components/OverlayLayer';
import { hasActiveModal } from '../src/renderer/src/lib/overlayStack';
import { useMultiSelection } from '../src/renderer/src/hooks/useMultiSelection';

afterEach(() => {
  useDialog.setState({ current: null });
  vi.unstubAllGlobals();
});

function fixture() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  return {
    host,
    root,
    close: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

describe('非模态内容工作区', () => {
  it('整页均不生成标签，叠加设置保留报告现场，关闭后恢复', () => {
    const app = fixture();
    let open = () => {};
    let close = () => {};
    function View() {
      const [shown, setShown] = useState(false);
      open = () => setShown(true);
      close = () => setShown(false);
      return h(
        WorkspacePages,
        { navigationKey: 'chat' },
        h(WorkspaceContent, null, h('input', { 'data-chat': true })),
        h(
          WorkspacePage,
          { title: '报告', retainOnNavigate: true },
          h('input', { 'data-report': true }),
        ),
        shown &&
          h(
            WorkspacePage,
            { title: '设置', standalone: true, onClose: close },
            h('div', null, '设置内容'),
          ),
      );
    }
    try {
      act(() => app.root.render(h(View)));
      const report = app.host.querySelector('[data-report]');
      act(() => open());
      expect(app.host.querySelector('[aria-label="内容页面"]')).toBeNull();
      expect(app.host.querySelector('[role="region"][aria-label="设置"]')).not.toBeNull();
      expect(app.host.querySelector('[aria-label="设置"]')?.hasAttribute('aria-labelledby')).toBe(
        false,
      );
      expect(app.host.querySelector('[data-report]')).toBe(report);
      act(() => close());
      expect(app.host.querySelector('[aria-label="内容页面"]')).toBeNull();
      expect(report?.closest('[hidden]')).toBeNull();
    } finally {
      app.close();
    }
  });
  it('无标签报告在普通导航时关闭并返回当前内容', () => {
    const app = fixture();
    let navigate = () => {};
    function View() {
      const [nav, setNav] = useState('chat-a');
      const [report, setReport] = useState(true);
      navigate = () => setNav('chat-b');
      return h(
        WorkspacePages,
        { navigationKey: nav },
        h(WorkspaceContent, null, h('div', { 'data-base': true }, nav)),
        report &&
          h(
            WorkspacePage,
            { title: '合成报告', onClose: () => setReport(false) },
            h('input', { 'data-report-draft': true }),
          ),
      );
    }
    try {
      act(() => app.root.render(h(View)));
      const input = app.host.querySelector<HTMLInputElement>('[data-report-draft]')!;
      input.value = '报告现场';
      act(() => navigate());
      expect(app.host.querySelector('[data-base]')!.closest('[hidden]')).toBeNull();
      expect(app.host.querySelector('[data-base]')?.textContent).toBe('chat-b');
      expect(app.host.querySelectorAll('[role="tab"]')).toHaveLength(0);
      expect(app.host.querySelector('[data-report-draft]')).toBeNull();
      expect(app.host.querySelector('[data-base]')!.closest('[hidden]')).toBeNull();
    } finally {
      app.close();
    }
  });
  it('全局页面临时隐藏会话右栏，返回后恢复右栏内容和原聊天', () => {
    const app = fixture();
    let openSettings = () => {};
    function View() {
      const [settings, setSettings] = useState(false);
      openSettings = () => setSettings(true);
      return h(
        WorkspacePages,
        { navigationKey: 'chat' },
        h(WorkspaceContent, null, h('input', { 'data-original-chat': true })),
        h(
          Modal,
          { presentation: 'sidecar', title: '群相册' },
          h('input', { 'data-album-position': true }),
        ),
        settings &&
          h(
            Modal,
            { presentation: 'page', title: '设置', onClose: () => setSettings(false) },
            h('button', { 'aria-label': '关闭设置', onClick: () => setSettings(false) }, '关闭'),
          ),
      );
    }
    try {
      act(() => app.root.render(h(View)));
      const album = app.host.querySelector<HTMLInputElement>('[data-album-position]')!;
      const chat = app.host.querySelector('[data-original-chat]');
      album.value = '保留的相册现场';
      act(() => openSettings());
      expect(app.host.querySelector('.weq-workspace-sidecar')?.hasAttribute('hidden')).toBe(true);
      expect(album.closest('[hidden]')).not.toBeNull();
      act(() => app.host.querySelector<HTMLButtonElement>('[aria-label="关闭设置"]')!.click());
      expect(app.host.querySelector('.weq-workspace-sidecar')?.hasAttribute('hidden')).toBe(false);
      expect(app.host.querySelector('[data-album-position]')).toBe(album);
      expect(album.value).toBe('保留的相册现场');
      expect(app.host.querySelector('[data-original-chat]')).toBe(chat);
      expect(chat?.closest('[hidden]')).toBeNull();
    } finally {
      app.close();
    }
  });
  it('会话资源进入右侧区域，不隐藏或替换左侧聊天，关闭后保留草稿', () => {
    const app = fixture();
    function View() {
      const [open, setOpen] = useState(true);
      return h(
        WorkspacePages,
        { navigationKey: 'chat-a' },
        h(
          WorkspaceContent,
          null,
          h('input', { 'data-conversation-draft': true, defaultValue: '聊天草稿' }),
        ),
        open &&
          h(
            Modal,
            { presentation: 'sidecar', title: '群文件', onClose: () => setOpen(false) },
            h(
              'div',
              { 'data-conversation-files': true },
              '资源列表',
              h('button', { 'aria-label': '关闭群文件', onClick: () => setOpen(false) }, '关闭'),
            ),
          ),
      );
    }
    try {
      act(() => app.root.render(h(View)));
      const draft = app.host.querySelector<HTMLInputElement>('[data-conversation-draft]')!;
      draft.value = '尚未发送的草稿';
      const resource = document.querySelector('[data-conversation-files]')!;
      expect(resource.closest('.weq-workspace-sidecar')).not.toBeNull();
      expect(draft.closest('[hidden]')).toBeNull();
      expect(app.host.querySelector('.weq-workspace-page-host')?.hasAttribute('hidden')).toBe(true);
      expect(document.querySelector('.weq-dialog-layer')).toBeNull();
      expect(hasActiveModal()).toBe(false);
      act(() => app.host.querySelector<HTMLButtonElement>('[aria-label="关闭群文件"]')!.click());
      expect(document.querySelector('[data-conversation-files]')).toBeNull();
      expect(app.host.querySelector('[data-conversation-draft]')).toBe(draft);
      expect(draft.value).toBe('尚未发送的草稿');
    } finally {
      app.close();
    }
  });
  it('两种共用 panel 外壳统一进入居中布局，保留其非模态行为', () => {
    const app = fixture();
    try {
      act(() =>
        app.root.render(
          h(
            'div',
            null,
            h(Modal, { presentation: 'panel' }, h('div', { 'data-panel-modal': true }, '管理工具')),
            h(
              OverlayLayer,
              { presentation: 'panel' },
              h('div', { 'data-panel-overlay': true }, '资源工具'),
            ),
          ),
        ),
      );
      expect(
        document.querySelector('[data-panel-modal]')?.closest('.weq-centered-panel'),
      ).not.toBeNull();
      expect(
        document.querySelector('[data-panel-overlay]')?.closest('.weq-centered-panel'),
      ).not.toBeNull();
      expect(hasActiveModal()).toBe(false);
    } finally {
      app.close();
    }
  });
  it('真正的确认层保持焦点循环，非模态面板不锁住 Tab', () => {
    const app = fixture();
    const render = (presentation: 'modal' | 'panel') =>
      act(() =>
        app.root.render(
          h(
            Modal,
            { presentation },
            h('button', { 'data-first-focus': true }, '取消'),
            h('button', { 'data-last-focus': true }, '确认'),
          ),
        ),
      );
    try {
      render('modal');
      const first = document.querySelector<HTMLButtonElement>('[data-first-focus]')!;
      const last = document.querySelector<HTMLButtonElement>('[data-last-focus]')!;
      const next = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
      act(() => {
        last.focus();
        last.dispatchEvent(next);
      });
      expect(next.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(first);
      const previous = new KeyboardEvent('keydown', {
        key: 'Tab',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
      act(() => first.dispatchEvent(previous));
      expect(document.activeElement).toBe(last);
      render('panel');
      const freeTab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
      act(() => last.dispatchEvent(freeTab));
      expect(freeTab.defaultPrevented).toBe(false);
    } finally {
      app.close();
    }
  });
  it('无标签页面叠加保留输入现场，关闭上层恢复下层，切号销毁旧页', () => {
    const app = fixture();
    let openSecond = () => {};
    function Content() {
      const [second, setSecond] = useState(false);
      openSecond = () => setSecond(true);
      return h(
        'div',
        null,
        h(WorkspaceContent, null, '原聊天'),
        h(
          Modal,
          { presentation: 'page', title: '第一页' },
          h('input', { defaultValue: '原值', 'data-first-input': true }),
        ),
        second &&
          h(
            Modal,
            { presentation: 'page', title: '第二页', onClose: () => setSecond(false) },
            h(
              'div',
              null,
              h('button', { 'aria-label': '关闭第二页', onClick: () => setSecond(false) }, '关闭'),
              h(
                Modal,
                { presentation: 'panel' },
                h('button', { 'data-second-panel': true }, '任务'),
              ),
            ),
          ),
      );
    }
    const render = (account: string) =>
      act(() =>
        app.root.render(h(WorkspacePages, { key: account, navigationKey: 'chat' }, h(Content))),
      );
    try {
      render('account-a');
      const input = app.host.querySelector<HTMLInputElement>('[data-first-input]')!;
      input.value = '编辑后的草稿';
      act(() => openSecond());
      const tabs = [...app.host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
      expect(tabs).toHaveLength(0);
      expect(input.value).toBe('编辑后的草稿');
      expect(input.closest('[hidden]')).not.toBeNull();
      expect(document.querySelector('[data-second-panel]')?.closest('[hidden]')).toBeNull();
      act(() => app.host.querySelector<HTMLButtonElement>('[aria-label="关闭第二页"]')!.click());
      expect(app.host.querySelectorAll('[role="tab"]')).toHaveLength(0);
      expect(app.host.querySelector('[data-first-input]')).toBe(input);
      expect(input.closest('[hidden]')).toBeNull();
      render('account-b');
      expect(app.host.querySelector('[data-first-input]')).not.toBe(input);
      expect(app.host.querySelector<HTMLInputElement>('[data-first-input]')?.value).toBe('原值');
    } finally {
      app.close();
    }
  });
  it('较早挂载的确认层重新打开后，Escape 按实际层级关闭最上层', () => {
    const app = fixture();
    const first = vi.fn(),
      second = vi.fn();
    const render = (open: boolean) =>
      act(() =>
        app.root.render(
          h(
            'div',
            null,
            h(Modal, { open, onClose: first }, h('button', null, '第一层')),
            h(Modal, { onClose: second }, h('button', null, '第二层')),
          ),
        ),
      );
    try {
      render(false);
      render(true);
      act(() =>
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        ),
      );
      expect(first).toHaveBeenCalledOnce();
      expect(second).not.toHaveBeenCalled();
    } finally {
      app.close();
    }
  });
  it('下层窗口内部的高 z-index 不能越过外层浮层的堆叠上下文', () => {
    const app = fixture();
    const lower = vi.fn(),
      upper = vi.fn();
    try {
      act(() =>
        app.root.render(
          h(
            'div',
            null,
            h(
              Modal,
              { onClose: lower },
              h(
                'section',
                {
                  role: 'dialog',
                  'aria-modal': true,
                  style: { position: 'relative', zIndex: 99999 },
                },
                h('button', null, '下层内部'),
              ),
            ),
            h(Modal, { onClose: upper }, h('button', null, '上层确认')),
          ),
        ),
      );
      act(() =>
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        ),
      );
      expect(upper).toHaveBeenCalledOnce();
      expect(lower).not.toHaveBeenCalled();
    } finally {
      app.close();
    }
  });
  it('焦点进入非模态工具后，聊天多选不会接管工具的快捷键', () => {
    const app = fixture();
    function View() {
      const [selected, setSelected] = useState(new Set<string>());
      const selection = useMultiSelection({ ids: ['a', 'b'], selected, onChange: setSelected });
      return h(
        'div',
        null,
        h(
          'div',
          selection.rootProps,
          ...['a', 'b'].map((id) =>
            h(
              'button',
              { key: id, ...selection.itemProps(id), 'aria-pressed': selected.has(id) },
              id,
            ),
          ),
        ),
        h(Modal, { presentation: 'panel' }, h('button', { 'data-tool-action': true }, '任务操作')),
      );
    }
    try {
      act(() => app.root.render(h(View)));
      const item = app.host.querySelector<HTMLButtonElement>('[data-weq-select-id="a"]')!;
      act(() => item.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })));
      expect(app.host.querySelectorAll('[aria-pressed="true"]')).toHaveLength(1);
      const button = document.querySelector<HTMLButtonElement>('[data-tool-action]')!;
      const event = new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'a',
        ctrlKey: true,
      });
      act(() => {
        button.focus();
        button.dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(false);
      expect(app.host.querySelectorAll('[aria-pressed="true"]')).toHaveLength(1);
    } finally {
      app.close();
    }
  });
  it('页面进入内容区、切换保留状态、关闭返回原内容，导航离开关闭临时页', () => {
    const app = fixture();
    const close = vi.fn();
    function Counter() {
      const [count, setCount] = useState(0);
      return h('button', { onClick: () => setCount(count + 1), 'data-counter': true }, count);
    }
    function View({ navigationKey }: { navigationKey: string }) {
      const [open, setOpen] = useState(true);
      return h(
        WorkspacePages,
        { navigationKey },
        h(WorkspaceContent, null, h('input', { defaultValue: '原聊天草稿', 'data-chat': true })),
        open &&
          h(
            OverlayLayer,
            {
              presentation: 'page',
              title: '分析',
              onClose: () => {
                close();
                setOpen(false);
              },
            },
            h(Counter),
          ),
      );
    }
    try {
      act(() => app.root.render(h(View, { navigationKey: 'chat-a' })));
      const counter = app.host.querySelector<HTMLButtonElement>('[data-counter]')!;
      expect(counter.closest('.weq-workspace-page-host')).not.toBeNull();
      expect(app.host.querySelector('.weq-workspace-base')?.hasAttribute('hidden')).toBe(true);
      expect(hasActiveModal()).toBe(false);
      act(() => counter.click());
      expect(counter.textContent).toBe('1');
      act(() => app.root.render(h(View, { navigationKey: 'chat-b' })));
      expect(close).toHaveBeenCalledOnce();
      expect(app.host.querySelector('.weq-workspace-base')?.hasAttribute('hidden')).toBe(false);
      expect(app.host.querySelector<HTMLInputElement>('[data-chat]')?.value).toBe('原聊天草稿');
    } finally {
      app.close();
    }
  });

  it('非模态面板不宣告模态，背景可操作，关闭隐藏仍保留子树', () => {
    const app = fixture();
    const background = vi.fn();
    const close = vi.fn();
    const render = (open: boolean) =>
      act(() =>
        app.root.render(
          h(
            'div',
            null,
            h('button', { onClick: background, 'data-background': true }, '聊天'),
            h(
              Modal,
              { presentation: 'panel', open, onClose: close },
              h('input', { 'data-draft': true, defaultValue: '任务草稿' }),
            ),
          ),
        ),
      );
    try {
      render(true);
      expect(hasActiveModal()).toBe(false);
      const input = document.querySelector<HTMLInputElement>('[data-draft]')!;
      const button = app.host.querySelector<HTMLButtonElement>('[data-background]')!;
      act(() => {
        button.focus();
        button.click();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      expect(background).toHaveBeenCalledOnce();
      expect(close).not.toHaveBeenCalled();
      act(() => {
        input.focus();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      expect(close).toHaveBeenCalledOnce();
      render(false);
      render(true);
      expect(document.querySelector('[data-draft]')).toBe(input);
    } finally {
      app.close();
    }
  });

  it('确认保留模态，Escape 不连带关闭背后的面板，普通错误不阻断', async () => {
    const app = fixture();
    const close = vi.fn();
    try {
      act(() =>
        app.root.render(
          h(
            'div',
            null,
            h(Modal, { presentation: 'panel', onClose: close }, h('input', { 'data-panel': true })),
            h(DialogHost),
          ),
        ),
      );
      let confirmation: Promise<boolean> | undefined;
      act(() => {
        confirmation = useDialog.getState().confirm('删除', '永久删除？');
      });
      expect(hasActiveModal()).toBe(true);
      act(() =>
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
      );
      expect(await confirmation).toBe(false);
      expect(close).not.toHaveBeenCalled();
      act(() => useDialog.getState().showError('读取失败', '请重试'));
      expect(hasActiveModal()).toBe(false);
      expect(document.body.textContent).toContain('读取失败');
      act(() => useDialog.getState().showError('无法启动', '缺少必要组件', { dismissible: false }));
      expect(hasActiveModal()).toBe(true);
    } finally {
      app.close();
    }
  });
});
