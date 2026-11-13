import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ProfilePageHeader } from '../src/renderer/src/components/contactProfile/ProfilePageHeader';
import {
  ConversationSettingsNavigationContext,
  type ConversationSettingsRequest,
} from '../src/renderer/src/lib/conversationSettingsNavigation';

vi.mock('../src/renderer/src/components/ConversationSettingsDialog', () => ({
  ConversationSettingsDialog: () => null,
}));
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});
it.each(['c2c', 'group'] as const)(
  '%s 资料页右上角在关闭左侧使用同一设置按钮，点击不导航离开资料',
  (kind) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const navigate = vi.fn();
    const close = vi.fn();
    const request: ConversationSettingsRequest = {
      kind,
      conv: kind === 'group' ? '12345' : 'u_friend',
      title: '资料',
    };
    act(() =>
      root.render(
        h(
          ConversationSettingsNavigationContext.Provider,
          { value: navigate },
          h(ProfilePageHeader, {
            title: '资料',
            identity: '身份',
            onClose: close,
            conversationSettings: request,
          }),
        ),
      ),
    );
    const buttons = host.querySelectorAll<HTMLButtonElement>('.weq-profile-page-toolbar button');
    expect([...buttons].map((button) => button.title)).toEqual(['会话设置', '关闭资料']);
    act(() => buttons[0].click());
    expect(close).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ ...request, anchor: buttons[0] }),
    );
    act(() => root.unmount());
  },
);
