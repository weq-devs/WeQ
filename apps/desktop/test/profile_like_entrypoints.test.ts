import { act, createElement as h, Fragment, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ContactProfileDialog } from '../src/renderer/src/im-template/template/profilePanes';
import { MemberProfileCard } from '../src/renderer/src/components/MemberProfileCard';
import { PersonalityHomeDialog } from '../src/renderer/src/components/PersonalityHomeDialog';
import { useViewState } from '../src/renderer/src/state/view';
import type { Contact } from '../src/renderer/src/im-template/template/types';

const write = vi.hoisted(() => vi.fn());
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: {
    account: {
      getProfile: { query: async () => null },
      getBotProfile: { query: async () => null },
      qqActions: { profileLike: { mutate: write } },
    },
  },
  trpc: {
    // `useQQWriteSession` 写完后会刷缓存；本用例只关心入口是否出现。
    useUtils: () => ({ invalidate: async () => undefined }),
    account: {
      // `withQQAccountScope` 用它校验「当前会话 = 当前数据源」，没有绑定就不渲染操作。
      getAccountConfig: { useQuery: () => ({ data: { uin: '10001', configId: 'source-a' } }) },
      getGroupAlbumAccessState: {
        useQuery: () => ({ data: { qqOnline: true }, isLoading: false }),
      },
      qqWrite: {
        // 共同关系行只关心「入口出现」，读取结果给空即可。
        commonRelationships: {
          useQuery: () => ({ data: undefined, isLoading: false, isFetching: false }),
        },
      },
      dressup: {
        peerHome: { useQuery: () => ({ data: {}, isLoading: false }) },
        peerStats: { useQuery: () => ({ data: { level: 5, likeCount: 100 } }) },
        peerQqShow: { useQuery: () => ({ data: { hasShow: false } }) },
      },
      intentSense: {
        getStatus: { useQuery: () => ({ data: undefined }) },
        getProfile: { useQuery: () => ({ data: undefined }) },
      },
    },
  },
}));
vi.mock('../src/renderer/src/components/OverlayLayer', () => ({
  OverlayLayer: ({ children }: { children: ReactNode }) => children,
}));

afterEach(() => {
  useViewState.setState({ openedUin: null });
  vi.unstubAllGlobals();
});

it.each([false, true])('实际好友、成员、个性主页入口按机器人身份过滤：%s', async (bot) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useViewState.setState({ openedUin: '10001' });
  const contact: Contact = {
    id: 'u_peer',
    identityLabel: 'QQ',
    identityValue: '10002',
    username: 'peer',
    displayName: '合成好友',
    createdAt: new Date(0).toISOString(),
    ...(bot ? { kind: 'bot' as const } : {}),
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        h(
          Fragment,
          null,
          h(ContactProfileDialog, { contact, onClose: () => {} }),
          h(MemberProfileCard, { member: contact, anchor: { x: 10, y: 10 }, onClose: () => {} }),
          h(PersonalityHomeDialog, {
            uid: contact.id,
            uin: contact.identityValue,
            isBot: bot,
            onClose: () => {},
            profile: {
              name: '合成好友',
              avatarUrl: null,
              interests: [],
              privileges: [],
              album: [],
            },
          }),
        ),
      ),
    );
    expect(host.querySelectorAll('[aria-label="赞资料卡"]')).toHaveLength(bot ? 0 : 3);
    expect(host.querySelectorAll('.weq-profile-likes-row')).toHaveLength(bot ? 0 : 3);
    for (const button of host.querySelectorAll('[aria-label="赞资料卡"]')) {
      const row = button.closest('.weq-profile-row');
      expect(row?.textContent).toContain('获赞');
      expect(row?.querySelector('strong')?.textContent).toBe('100');
      expect(row?.querySelector('.weq-profile-row-value strong')?.nextElementSibling).toBe(button);
    }
    expect(host.querySelector('.weq-perhome-stat-like')).toBeNull();
    expect(write).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
