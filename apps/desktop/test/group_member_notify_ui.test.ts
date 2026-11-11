import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  GroupMemberNotifyControl,
  GroupMemberNotifyMenuItem,
} from '../src/renderer/src/components/GroupMemberNotifyControl';
import { qa } from './browser/group-member-notify.stub';
import { useViewState } from '../src/renderer/src/state/view';

vi.mock('../src/renderer/src/trpc/client', () => import('./browser/group-member-notify.stub'));
vi.mock(
  '../src/renderer/src/hooks/useQQWriteSession',
  () => import('./browser/group-member-notify.stub'),
);
vi.mock('../src/renderer/src/components/ConversationActionsMenu', () => ({
  ConversationActionsMenu: () => null,
}));
const disposals: Array<() => void> = [];
function fixture(two = false) {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const render = () =>
    act(() =>
      root.render(
        h(
          'div',
          null,
          h(GroupMemberNotifyMenuItem, { groupId: 123, uid: 'u_peer' }),
          two ? h(GroupMemberNotifyMenuItem, { groupId: 123, uid: 'u_peer' }) : null,
        ),
      ),
    );
  render();
  disposals.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  return { host, render };
}
const wait = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  qa.reset();
});
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
  vi.unstubAllGlobals();
});
it('未展开不查询，展开后只读一次，两个入口共享选中状态', async () => {
  const f = fixture(true);
  expect(qa.counters.reads).toBe(0);
  for (const button of f.host.querySelectorAll<HTMLButtonElement>('[aria-haspopup]'))
    act(() => button.click());
  await wait();
  expect(qa.counters.reads).toBe(1);
  expect(f.host.querySelectorAll('[aria-checked="true"]')).toHaveLength(2);
  const choice = f.host.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')[1]!;
  await act(async () => choice.click());
  await wait();
  expect(qa.counters.writes).toBe(1);
  expect(qa.counters.checks).toBe(1);
  expect(
    [...f.host.querySelectorAll('[aria-checked="true"]')].every(
      (node) => node.textContent === '特别关注',
    ),
  ).toBe(true);
});
it.each(['unknown', 'failure', 'online'] as const)(
  '未知、失败或离线不预选默认且不允许覆盖：%s',
  async (mode) => {
    qa.configure(mode === 'online' ? { online: false } : { [mode]: true });
    const f = fixture();
    act(() => f.host.querySelector<HTMLButtonElement>('[aria-haspopup]')!.click());
    await wait();
    expect(f.host.querySelectorAll('[role="menuitemradio"]:not(:disabled)')).toHaveLength(0);
    if (mode !== 'failure')
      expect(f.host.querySelectorAll('[aria-checked="true"]')).toHaveLength(0);
    expect(qa.counters.writes).toBe(0);
    if (mode === 'failure') {
      act(() => qa.configure({ failure: false }));
      act(() =>
        [...f.host.querySelectorAll<HTMLButtonElement>('button')]
          .find((button) => button.textContent === '重新读取')!
          .click(),
      );
      await wait();
      expect(f.host.querySelector('[aria-checked="true"]')?.textContent).toBe('默认');
    }
  },
);
it.each(['failWrite', 'mismatch'] as const)(
  '保存失败或读回不符不显示目标选中、不重发：%s',
  async (mode) => {
    qa.configure({ [mode]: true });
    const f = fixture();
    act(() => f.host.querySelector<HTMLButtonElement>('[aria-haspopup]')!.click());
    await wait();
    act(() => f.host.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')[2]!.click());
    await wait();
    expect(qa.counters.writes).toBe(1);
    expect(f.host.querySelector('[aria-checked="true"]')?.textContent).toBe('默认');
  },
);
it('切换来源不能沿用旧查询，换成员使用独立缓存键', async () => {
  const f = fixture();
  act(() => f.host.querySelector<HTMLButtonElement>('[aria-haspopup]')!.click());
  await wait();
  act(() => qa.configure({ config: 'other' }));
  expect(f.host.querySelector('[aria-checked="true"]')).toBeNull();
  await wait();
  expect(qa.counters.reads).toBe(2);
});
it('两个入口同时选择时只发送一次，确认期间共享在途状态', async () => {
  const f = fixture(true);
  for (const button of f.host.querySelectorAll<HTMLButtonElement>('[aria-haspopup]'))
    act(() => button.click());
  await wait();
  const buttons = f.host.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]');
  act(() => {
    buttons[1]!.click();
    buttons[5]!.click();
  });
  expect(f.host.querySelectorAll('[role="menuitemradio"]:not(:disabled)')).toHaveLength(0);
  await wait();
  expect(qa.counters.writes).toBe(1);
});
it('成员名片排除自己的 QQ 号', () => {
  useViewState.setState({ openedUin: '10001' });
  const host = document.createElement('main');
  const root = createRoot(host);
  act(() =>
    root.render(h(GroupMemberNotifyControl, { groupId: 123, uid: 'u_self', memberUin: '10001' })),
  );
  expect(host.childElementCount).toBe(0);
  expect(qa.counters.reads).toBe(0);
  act(() => root.unmount());
});
