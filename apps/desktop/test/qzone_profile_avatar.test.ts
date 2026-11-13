import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import {
  QzoneProfileAvatar,
  QzonePersonButton,
  QzonePersonIdentity,
  QzonePersonHeader,
} from '../src/renderer/src/components/QzoneProfileAvatar';
import { QzoneProfileContext, QzonePersonContext } from '../src/renderer/src/lib/qzoneNavigation';

vi.mock('../src/renderer/src/components/QqAvatar', () => ({
  QqAvatar: () => h('span', { className: 'fixture-avatar' }),
}));

it('作者头像与昵称分开操作，时间只属于昵称旁的身份信息', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  const space = vi.fn();
  try {
    act(() =>
      root.render(
        h(QzonePersonHeader, {
          uin: '10002',
          nickname: '合成好友',
          size: 34,
          onSpace: space,
          time: h('time', null, '2026-11-04'),
        }),
      ),
    );
    expect(host.querySelectorAll('button')).toHaveLength(2);
    expect(host.querySelector('button time')).toBeNull();
    expect(host.querySelector('.weq-qzn-person-info > time')?.textContent).toBe('2026-11-04');
    for (const button of host.querySelectorAll('button')) act(() => button.click());
    expect(space).toHaveBeenCalledTimes(2);
    expect(space).toHaveBeenLastCalledWith('10002', '合成好友');
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});

it.each([
  { action: 'profile' as const, spaceUin: null, profileExpected: true },
  { action: 'space' as const, spaceUin: null, profileExpected: false },
  { action: 'space' as const, spaceUin: '10002', profileExpected: true },
  { action: 'profile' as const, spaceUin: '10002', profileExpected: true },
  { action: 'space' as const, spaceUin: '10003', profileExpected: false },
])('昵称与头像统一路由：$action / 当前空间 $spaceUin', ({ action, spaceUin, profileExpected }) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  const profile = vi.fn();
  const space = vi.fn();
  const parent = vi.fn();
  try {
    act(() =>
      root.render(
        h(
          QzoneProfileContext.Provider,
          { value: profile },
          h(
            QzonePersonContext.Provider,
            { value: { action, spaceUin, onSpace: space } },
            h(
              'div',
              { onClick: parent },
              h(QzoneProfileAvatar, { uin: '10002', nickname: '合成好友', size: 34 }),
              h(QzonePersonButton, { uin: '10002', nickname: '合成好友' }, '合成好友'),
              h(QzonePersonIdentity, { uin: '10002', nickname: '合成好友', size: 20 }),
              h(QzonePersonHeader, {
                uin: '10002',
                nickname: '合成好友',
                size: 34,
                time: '2026-11-04',
              }),
            ),
          ),
        ),
      ),
    );
    for (const button of host.querySelectorAll('button')) {
      const click = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        clientX: 12,
        clientY: 34,
        detail: 1,
      });
      act(() => {
        button.dispatchEvent(click);
      });
      expect(click.defaultPrevented).toBe(true);
    }
    expect(parent).not.toHaveBeenCalled();
    if (profileExpected) {
      expect(profile).toHaveBeenCalledTimes(5);
      expect(profile).toHaveBeenLastCalledWith('10002', '合成好友', { x: 12, y: 34 });
      expect(space).not.toHaveBeenCalled();
    } else {
      expect(space).toHaveBeenCalledTimes(5);
      expect(space).toHaveBeenLastCalledWith('10002', '合成好友');
      expect(profile).not.toHaveBeenCalled();
    }
    const identity = host.querySelector('.weq-qzn-identity-link')!;
    const calls = profileExpected ? profile : space;
    for (const child of identity.children) act(() => (child as HTMLElement).click());
    expect(calls).toHaveBeenCalledTimes(7);
    const button = identity as HTMLButtonElement;
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue(new DOMRect(10, 20, 100, 26));
    if (profileExpected) {
      act(() => button.click());
      expect(profile).toHaveBeenLastCalledWith('10002', '合成好友', { x: 110, y: 46 });
    }
    act(() =>
      root.render(
        h(
          QzonePersonContext.Provider,
          { value: { action: 'profile', spaceUin, onSpace: space } },
          h(QzoneProfileAvatar, { uin: '10002', size: 34 }),
        ),
      ),
    );
    expect(host.querySelector('button')!.disabled).toBe(true);
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
