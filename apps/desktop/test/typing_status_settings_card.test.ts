import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { TypingStatusSettingsCard } from '../src/renderer/src/components/settings/TypingStatusSettingsCard';
import { ProfileNavigationContext } from '../src/renderer/src/lib/profileNavigation';

const mocks = vi.hoisted(() => ({
  profile: vi.fn(),
  setOverride: vi.fn(),
  item: {
    accountUin: '10001',
    accountConfigId: 'source-a',
    uid: 'u_peer',
    name: '旧昵称',
    enabled: false,
  },
}));
vi.mock('../src/renderer/src/hooks/useTypingStatusSettings', () => ({
  useTypingStatusSettings: () => ({
    query: { data: { defaultEnabled: false, overrides: [mocks.item] } },
    disabled: false,
    setOverride: mocks.setOverride,
  }),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    account: {
      getAccountConfig: {
        useQuery: () => ({ data: { uin: '10001', configId: 'source-a' } }),
      },
      getProfile: { useQuery: mocks.profile },
    },
  },
}));
vi.mock('../src/renderer/src/hooks/useAvatarUrl', () => ({
  useAvatarUrl: (url: string | null) => url,
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  mocks.item.accountUin = '10001';
  mocks.item.accountConfigId = 'source-a';
});

it.each(['current', 'missing', 'other-account', 'other-source'])(
  '输入状态特例使用头像与昵称，名片不串账号或数据源：%s',
  async (mode) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    if (mode === 'other-account') mocks.item.accountUin = '10003';
    if (mode === 'other-source') mocks.item.accountConfigId = 'source-b';
    mocks.profile.mockReturnValue({
      data: mode === 'missing' ? null : { nick: '新昵称', uin: '10002', avatarUrl: '' },
    });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const open = vi.fn();
    try {
      await act(async () =>
        root.render(
          h(ProfileNavigationContext.Provider, { value: open }, h(TypingStatusSettingsCard)),
        ),
      );
      const current = mode === 'current' || mode === 'missing';
      expect(mocks.profile).toHaveBeenLastCalledWith(
        { uid: 'u_peer' },
        expect.objectContaining({ enabled: current }),
      );
      const name = mode === 'current' ? '新昵称' : '旧昵称';
      expect(host.querySelector('.weq-typing-settings-name')?.textContent).toBe(name);
      const contact = host.querySelector('.weq-typing-settings-contact')!;
      expect(contact.querySelector('img, .weq-avatar-fallback')).not.toBeNull();
      const button = contact.querySelector('button');
      expect(Boolean(button)).toBe(current);
      if (button) {
        await act(async () => button.click());
        expect(open).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'u_peer', displayName: name }),
          expect.any(Object),
          undefined,
        );
      }
      if (mode === 'current') expect(contact.querySelector('img')?.src).toContain('nk=10002');
      const toggle = host.querySelector<HTMLButtonElement>('.weq-set-btn-group [role="switch"]')!;
      await act(async () => toggle.click());
      expect(mocks.setOverride).toHaveBeenLastCalledWith(mocks.item, true);
      const remove = host.querySelector<HTMLButtonElement>('[title="删除特例，恢复全局默认"]')!;
      await act(async () => remove.click());
      expect(mocks.setOverride).toHaveBeenLastCalledWith(mocks.item, null);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  },
);
