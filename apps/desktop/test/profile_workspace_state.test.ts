import { act, createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ProfileWorkspace } from '../src/renderer/src/components/ProfileWorkspace';
import {
  DraftCloseContext,
  useDraftClose,
  useDraftProtection,
} from '../src/renderer/src/lib/draftClose';
import { useDialog } from '../src/renderer/src/components/Dialog';
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('章节保留现场与滚动位置，页头关闭能读到嵌套编辑器的未保存状态', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const close = vi.fn();
  const confirm = vi.spyOn(useDialog.getState(), 'confirm').mockResolvedValue(false);
  function Editor() {
    const [value, setValue] = useState('');
    useDraftProtection(value);
    return h('input', {
      'aria-label': '合成资料',
      value,
      onChange: (event: { target: { value: string } }) => setValue(event.target.value),
    });
  }
  function Page() {
    const closing = useDraftClose(close, null);
    const [selected, setSelected] = useState('profile');
    return h(
      DraftCloseContext.Provider,
      { value: closing.drafts },
      h('button', { onClick: closing.requestClose }, '关闭资料'),
      h(ProfileWorkspace, {
        label: '资料目录',
        sections: [
          ['profile', '概览'],
          ['details', '详细资料'],
        ],
        selected,
        onSelect: setSelected,
        render: (key) => (key === 'profile' ? h(Editor) : h('p', null, '完整资料')),
      }),
    );
  }
  const host = document.createElement('div');
  const root = createRoot(host);
  document.body.append(host);
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  act(() => root.render(h(Page)));
  const input = host.querySelector('input')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      '未保存草稿',
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const closeButton = [...host.querySelectorAll('button')].find(
    (button) => button.textContent === '关闭资料',
  )!;
  await act(async () => closeButton.click());
  expect(confirm).toHaveBeenCalledOnce();
  expect(close).not.toHaveBeenCalled();
  confirm.mockResolvedValue(true);
  const scroller = host.querySelector<HTMLElement>('.weq-contact-workspace-body')!;
  scroller.scrollTop = 73;
  await act(async () =>
    [...host.querySelectorAll('nav button')]
      .find((button) => button.textContent === '详细资料')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true })),
  );
  await act(async () =>
    [...host.querySelectorAll('nav button')]
      .find((button) => button.textContent === '概览')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true })),
  );
  expect(host.querySelector('input')?.value).toBe('未保存草稿');
  expect(scroller.scrollTop).toBe(73);
  await act(async () => closeButton.click());
  expect(close).toHaveBeenCalledOnce();
});
