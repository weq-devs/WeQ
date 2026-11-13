import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { GroupLabelSources } from '../src/renderer/src/components/GroupLabelSources';
import { ProfileNavigationContext } from '../src/renderer/src/lib/profileNavigation';
import type { GroupConversation } from '../src/renderer/src/im-template/template/types';

vi.mock('../src/renderer/src/hooks/useGroupLabelSetter', () => ({
  useGroupLabelSetter: () => ({ data: undefined, isError: false }),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('标签只显示一次，悬停展示多个来源，头像昵称打开成员名片', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const open = vi.fn();
  const group = {
    id: '12345',
    name: '合成群',
    labels: '普通标签',
    customLabels: ['同名标签', '同名标签', '无来源'],
    customLabelRecords: [
      {
        content: '同名标签',
        setterUid: 'u_one',
        setTimestamp: String(Date.parse('2026-11-10T16:01:02Z') / 1000),
        labelId: '1',
      },
      { content: '同名标签', setterUid: 'u_missing', labelId: '2' },
      { content: '只有时间', setTimestamp: '1794326462', labelId: '3' },
    ],
  } as GroupConversation['group'];
  const members = [
    {
      id: 'u_one',
      uid: 'u_one',
      uin: '123456',
      remark: '本地备注',
      card: '群名片',
      nick: '昵称',
      role: 'member',
      joinedAt: '',
      avatarUrl: '/avatar.png',
    },
  ] as GroupConversation['members'];
  try {
    act(() =>
      root.render(
        h(
          ProfileNavigationContext.Provider,
          { value: open },
          h(GroupLabelSources, { group, members }),
        ),
      ),
    );
    expect(host.querySelectorAll('.weq-profile-data-row')).toHaveLength(0);
    expect(host.querySelectorAll('.weq-profile-tag')).toHaveLength(4);
    expect(document.querySelector('[aria-label="同名标签的来源"]')).toBeNull();
    const trigger = host.querySelector<HTMLButtonElement>('button.weq-profile-tag')!;
    act(() => trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    const popover = document.querySelector<HTMLElement>('[aria-label="同名标签的来源"]')!;
    expect(popover.textContent).toContain('本地备注');
    expect(popover.textContent).toContain('设置者');
    expect(popover.textContent).toContain('设置时间：');
    expect(popover.textContent).toContain('2026-11-11 00:01:02');
    const person = popover.querySelector<HTMLButtonElement>('[aria-label="查看 本地备注 的名片"]')!;
    expect(person.querySelector('img')?.getAttribute('src')).toBe('/avatar.png');
    act(() => trigger.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })));
    act(() => popover.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    act(() => vi.advanceTimersByTime(200));
    expect(popover.isConnected).toBe(true);
    act(() => person.click());
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u_one', displayName: '本地备注' }),
      expect.any(Object),
      { code: '12345', name: '合成群' },
    );
    act(() =>
      popover.querySelector<HTMLButtonElement>('[aria-label="查看 u_missing 的名片"]')!.click(),
    );
    expect(open.mock.calls.at(-1)?.[0].id).toBe('u_missing');
    act(() =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    expect(document.querySelector('[aria-label="同名标签的来源"]')).toBeNull();
    act(() => trigger.focus());
    expect(document.querySelector('[aria-label="同名标签的来源"]')).not.toBeNull();
    act(() => document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
    expect(document.querySelector('[aria-label="同名标签的来源"]')).toBeNull();
    act(() => trigger.click());
    expect(document.querySelector('[aria-label="同名标签的来源"]')).not.toBeNull();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
