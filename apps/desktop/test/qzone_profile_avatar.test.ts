import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import {
  QzoneProfileAvatar,
  QzonePersonButton,
} from '../src/renderer/src/components/QzoneProfileAvatar';
import { QzoneProfileContext, QzonePersonContext } from '../src/renderer/src/lib/qzoneNavigation';

vi.mock('../src/renderer/src/components/QqAvatar', () => ({ QqAvatar: () => null }));

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
      });
      act(() => {
        button.dispatchEvent(click);
      });
      expect(click.defaultPrevented).toBe(true);
    }
    expect(parent).not.toHaveBeenCalled();
    if (profileExpected) {
      expect(profile).toHaveBeenCalledTimes(2);
      expect(profile).toHaveBeenLastCalledWith('10002', '合成好友', { x: 12, y: 34 });
      expect(space).not.toHaveBeenCalled();
    } else {
      expect(space).toHaveBeenCalledTimes(2);
      expect(space).toHaveBeenLastCalledWith('10002', '合成好友');
      expect(profile).not.toHaveBeenCalled();
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
