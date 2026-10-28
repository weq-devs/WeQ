import { act, createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { PageSnapshots, usePageState } from '../src/renderer/src/components/PageSnapshots';
import { pageValue } from '../src/renderer/src/lib/pageSnapshots';
import {
  RetainedTabs,
  TabActivity,
  useTabActive,
} from '../src/renderer/src/components/RetainedTabs';
import {
  WorkspaceContent,
  WorkspacePage,
  WorkspacePages,
} from '../src/renderer/src/components/WorkspacePages';

afterEach(() => vi.unstubAllGlobals());

it('设置覆盖基础页时卸载旧组件，返回时从磁盘恢复草稿与滚动', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  vi.stubGlobal('localStorage', new Storage());
  let setOpen: (open: boolean) => void = () => {};
  function Probe() {
    const active = useTabActive();
    const [draft, setDraft] = usePageState('draft', '草稿', pageValue.string, true);
    return h(
      'div',
      { 'data-scroll': true },
      h('input', {
        'data-active': String(active),
        value: draft,
        onInput: (event) => setDraft(event.currentTarget.value),
      }),
    );
  }
  function View() {
    const [open, update] = useState(false);
    setOpen = update;
    return h(
      PageSnapshots,
      { scope: 'account-a' },
      h(
        WorkspacePages,
        { navigationKey: 'messages' },
        h(WorkspaceContent, null, h(RetainedTabs, { activeKey: 'messages' }, h(Probe))),
        open && h(WorkspacePage, { title: '设置' }, '设置'),
      ),
    );
  }
  try {
    act(() => root.render(h(View)));
    const input = host.querySelector('input')!;
    const scroll = host.querySelector<HTMLElement>('[data-scroll]')!;
    act(() => {
      input.value = '未发送草稿';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      scroll.scrollTop = 75;
      scroll.dispatchEvent(new Event('scroll'));
    });
    expect(input.dataset.active).toBe('true');
    act(() => setOpen(true));
    expect(host.querySelector('input')).toBeNull();
    expect(input.isConnected).toBe(false);
    act(() => setOpen(false));
    const restored = host.querySelector('input')!;
    expect(restored).not.toBe(input);
    expect(restored.value).toBe('未发送草稿');
    expect(restored.dataset.active).toBe('true');
    const restoredScroll = host.querySelector<HTMLElement>('[data-scroll]')!;
    Object.defineProperty(restoredScroll, 'scrollHeight', { value: 1000 });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(restoredScroll.scrollTop).toBe(75);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('内层保留标签不能覆盖祖先的非活动状态', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  function Probe() {
    return h('span', null, String(useTabActive()));
  }
  try {
    act(() =>
      root.render(
        h(TabActivity, { active: false }, h(RetainedTabs, { activeKey: 'chat' }, h(Probe))),
      ),
    );
    expect(host.querySelector('span')).toBeNull();
  } finally {
    act(() => root.unmount());
  }
});
