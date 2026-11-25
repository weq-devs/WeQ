import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TitleBar } from '../src/renderer/src/im-template/template/TitleBar';
import type { User } from '../src/renderer/src/im-template/template/types';
import {
  ProfileNavigationContext,
  type ProfileGroup,
} from '../src/renderer/src/lib/profileNavigation';

vi.mock('../src/renderer/src/components/OnlineStatus', () => ({ OnlineStatus: () => null }));
vi.mock('../src/renderer/src/components/VipBadge', () => ({ VipBadge: () => null }));
vi.mock('../src/renderer/src/components/RestrictedMode', () => ({
  RestrictedModeIndicator: () => null,
}));

const user: User = {
  id: 'self:10001',
  uid: 'u_self',
  identityLabel: 'QQ',
  identityValue: '10001',
  username: '自己',
  displayName: '自己',
  avatarUrl: null,
};
let cleanup = () => {};
beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('顶栏自己的名片群上下文', () => {
  it('点击与键盘打开均传入当前群，切群更新，退出群聊后不保留旧群', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const open = vi.fn();
    const render = (group?: ProfileGroup) =>
      act(() =>
        root.render(
          h(ProfileNavigationContext.Provider, { value: open }, h(TitleBar, { user, group })),
        ),
      );
    cleanup = () => {
      act(() => root.unmount());
      host.remove();
    };
    const click = (keyboard = false) =>
      act(() => {
        host.querySelector('button[aria-label="查看我的名片"]')!.dispatchEvent(
          new MouseEvent('click', {
            bubbles: true,
            detail: keyboard ? 0 : 1,
            clientX: 48,
            clientY: 24,
          }),
        );
      });
    const first = { code: '20001', name: '第一个群' };
    render(first);
    click();
    expect(open).toHaveBeenLastCalledWith(user, { x: 48, y: 24 }, first);
    click(true);
    expect(open).toHaveBeenLastCalledWith(user, expect.any(Object), first);
    const second = { code: '20002', name: '第二个群' };
    render(second);
    click();
    expect(open).toHaveBeenLastCalledWith(user, expect.any(Object), second);
    render();
    click();
    expect(open.mock.lastCall?.slice(0, 2)).toEqual([user, expect.any(Object)]);
    expect(open.mock.lastCall?.[2]).toBeUndefined();
  });
});
