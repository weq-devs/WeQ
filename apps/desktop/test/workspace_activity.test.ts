import { act, createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
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

it('设置覆盖基础页时嵌套保留标签停止活动，返回时保留组件与草稿', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  let setOpen: (open: boolean) => void = () => {};
  function Probe() {
    const active = useTabActive();
    return h(
      'div',
      { 'data-scroll': true },
      h('input', { 'data-active': String(active), defaultValue: '草稿' }),
    );
  }
  function View() {
    const [open, update] = useState(false);
    setOpen = update;
    return h(
      WorkspacePages,
      { navigationKey: 'messages' },
      h(WorkspaceContent, null, h(RetainedTabs, { activeKey: 'messages' }, h(Probe))),
      open && h(WorkspacePage, { title: '设置' }, '设置'),
    );
  }
  try {
    act(() => root.render(h(View)));
    const input = host.querySelector('input')!;
    const scroll = host.querySelector<HTMLElement>('[data-scroll]')!;
    input.value = '未发送草稿';
    act(() => {
      scroll.scrollTop = 75;
      scroll.dispatchEvent(new Event('scroll'));
    });
    expect(input.dataset.active).toBe('true');
    act(() => setOpen(true));
    expect(input.closest('[hidden]')).not.toBeNull();
    expect(input.dataset.active).toBe('false');
    act(() => {
      scroll.scrollTop = 0;
      scroll.dispatchEvent(new Event('scroll'));
    });
    act(() => setOpen(false));
    expect(host.querySelector('input')).toBe(input);
    expect(input.value).toBe('未发送草稿');
    expect(input.dataset.active).toBe('true');
    expect(scroll.scrollTop).toBe(75);
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
    expect(host.textContent).toBe('false');
  } finally {
    act(() => root.unmount());
  }
});
