/**
 * 群成员资料卡（`components/MemberProfileCard`）走统一浮层外壳的回归测试。
 *
 * 背景：这张卡片原先把自己的遮罩写成 inline `z-index: 90`，而模板自己的浮层是
 * 95 / 96、走 overlayStack 的那批（表情面板、媒体预览灯箱…）是 ≥1200 —— 于是卡片
 * 的遮罩压不住它们，看起来就是「遮罩遮不住」。现在外壳交给 OverlayLayer：portal 到
 * body + 层级向 overlayStack 领。
 *
 * 这里真挂一次卡片，断言它生成的浮层根节点确实在 `document.body` 下、层级确实高于
 * 所有写死的静态值、且点遮罩能关 —— 「ref / portal / 层级有没有真的接上」这类问题
 * 纯读代码看不出来。
 */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const preferences = vi.hoisted(() => ({ friendClue: false }));

// 卡片会拉 tRPC 补全陌生人资料 —— 单测不建 ipc 链接，给个死数据桩。
vi.mock('@renderer/trpc/client', () => ({
  client: {
    account: {
      getProfile: { query: async () => null },
      getProfileByUin: { query: vi.fn(async () => null) },
      getCardDisplayNames: {
        query: vi.fn(async () => {
          throw new Error('合成离线');
        }),
      },
      getBotProfile: { query: async () => null },
      conversationBoundary: { query: async () => null },
      // 资料卡 hero 头像点开 QQ 秀展柜前，会先查一次「当前形象」用来标 #N。
      // 单测里给「没有 QQ 秀」；展柜本身不挂载，与本文件的断言无关。
      dressup: {
        peerQqShow: { query: async () => ({ hasShow: false, url: '' }) },
        peerHome: { query: async () => ({}) },
      },
    },
  },
  // 卡片底部的「互动画像」入口会读意图感知状态；这里给一个「未开启」的桩，
  // 入口不渲染，也就不会把画像 Dialog 的依赖链拖进来。
  trpc: {
    bootstrap: {
      getSettings: {
        useQuery: () => ({
          data: { contactCard: { visible: { friendClue: preferences.friendClue } } },
        }),
      },
    },
    useUtils: () => ({}),
    account: {
      getOnlineStatus: { useQuery: () => ({ data: undefined }) },
      getAccountConfig: { useQuery: () => ({ data: { uin: '10001', configId: 'source' } }) },
      getGroupAlbumAccessState: { useQuery: () => ({ data: undefined }) },
      profileExtras: {
        energy: { useQuery: () => ({ data: undefined }) },
        details: { useQuery: () => ({ data: undefined }) },
        personalityLabels: { useQuery: () => ({ data: undefined }) },
      },
      dressup: { peerStats: { useQuery: () => ({ data: undefined, isLoading: false }) } },
      intentSense: {
        getProfile: {
          useQuery: () => ({ data: undefined, isLoading: false }),
        },
        getStatus: {
          useQuery: () => ({ data: undefined }),
        },
      },
    },
  },
}));
vi.mock('@renderer/hooks/useQQWriteSession', () => ({
  useQQWriteSession: () => ({
    available: true,
    binding: { expectedAccountUin: '10001', expectedAccountConfigId: 'source' },
  }),
}));
vi.mock('@renderer/im-template/template/clipboard', () => ({
  copyTextToClipboard: vi.fn(async () => true),
}));

// 卡片底部的三个「从卡片里再打开」的灯箱与本次断言无关，换成空壳避免把
// 个性主页 / 聊天分析那一整条依赖链拖进单测。
vi.mock('@renderer/components/PersonalityHomeDialog', () => ({
  PersonalityHomeDialog: vi.fn(() => null),
}));
vi.mock('@renderer/components/MutualMarkDialog', () => ({ MutualMarkDialog: () => null }));
vi.mock('@renderer/components/MemberAnalyticsDialog', () => ({
  MemberAnalyticsDialog: vi.fn(() => null),
}));
vi.mock('@renderer/components/qq-actions/CommonRelationships', () => ({
  CommonRelationships: ({ onNavigate }: { onNavigate?: () => void }) =>
    createElement('button', { 'aria-label': '合成共同群跳转', onClick: onNavigate }),
}));
vi.mock('@renderer/components/qq-actions/FriendClue', () => ({
  FriendClue: ({ uid }: { uid: string }) => createElement('div', { 'data-friend-clue': uid }),
}));
vi.mock('@renderer/components/QQGroupMemberControls', () => ({
  QQGroupMemberControls: () => createElement('div', { 'data-member-editor': true }),
}));

import { MemberProfileCard } from '@renderer/components/MemberProfileCard';
import { MemberAnalyticsDialog } from '@renderer/components/MemberAnalyticsDialog';
import type { User } from '@renderer/im-template/template/types';
import { cachedAvatarUrl } from '@renderer/lib/avatarCache';
import { avatarFromUin } from '@renderer/lib/avatarResolver';
import {
  ContactWorkspaceNavigationContext,
  profileTargetUser,
} from '@renderer/lib/profileNavigation';
import { client } from '@renderer/trpc/client';
import { contactCardFieldGroup } from '@renderer/components/contactProfile/ContactContent';
import {
  RelationshipDirectoryContext,
  type RelationshipDirectory,
} from '@renderer/lib/contactRelationship';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

/** overlayStack 的 BASE 之下、写死 z-index 的都在这一档以内。 */
const STATIC_CSS_CEILING = 1200;

const roots: Root[] = [];
const hosts: HTMLDivElement[] = [];
const expandContact = vi.fn();

const MEMBER = {
  id: 'u_fixture',
  identityLabel: 'QQ',
  identityValue: '10001',
  username: 'tester',
  displayName: '测试用户',
  avatarUrl: null,
};

async function mountCard(
  onClose: () => void,
  anchor = { x: 120, y: 120 },
  member: User = MEMBER,
  groupCode?: string,
  directory: RelationshipDirectory | null = null,
): Promise<void> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
        createElement(
          RelationshipDirectoryContext.Provider,
          { value: directory },
          createElement(
            ContactWorkspaceNavigationContext.Provider,
            { value: expandContact },
            createElement(MemberProfileCard, {
              member,
              anchor,
              onClose,
              groupCode,
            }),
          ),
        ),
      ),
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  roots.push(root);
  hosts.push(host);
}

/** 卡片生成的浮层根节点。 */
function layer(): HTMLElement {
  const el = document.querySelector('body > .weq-overlay-layer');
  if (!el) throw new Error('没找到 body 下的浮层根节点 —— 卡片没走 OverlayLayer？');
  return el as HTMLElement;
}

describe('群成员资料卡浮层', () => {
  it('QID 与 QQ 号并列、状态位于昵称旁，生日无装饰图标，等级归基本信息', async () => {
    await mountCard(() => {}, undefined, {
      ...MEMBER,
      qid: 'synthetic-qid',
      customStatus: '正在听音乐',
      birthMonth: 5,
      birthDay: 12,
    });
    const numbers = layer().querySelector('.weq-contact-meta:has(.weq-contact-number)');
    expect(numbers?.textContent).toContain('synthetic-qid');
    expect(numbers?.textContent).toContain('10001');
    expect(layer().querySelector('.weq-contact-title-line')?.textContent).toContain('正在听音乐');
    expect(layer().querySelector('[data-profile-field="status"]')).toBeNull();
    expect(layer().querySelector('[data-profile-field="qid"]')).toBeNull();
    expect(
      layer().querySelector('[data-profile-field="birthday"] .weq-profile-data-label svg'),
    ).toBeNull();
    expect(contactCardFieldGroup('level')).toBe('basic');
  });
  it('复制提示自动消失，重复复制重新计时', async () => {
    await mountCard(() => {});
    vi.useFakeTimers();
    try {
      const copy = layer().querySelector<HTMLButtonElement>('.weq-contact-number')!;
      await act(async () => copy.click());
      expect(layer().textContent).toContain('已复制');
      await act(async () => vi.advanceTimersByTime(1200));
      await act(async () => copy.click());
      await act(async () => vi.advanceTimersByTime(700));
      expect(layer().textContent).toContain('已复制');
      await act(async () => vi.advanceTimersByTime(1100));
      expect(layer().textContent).not.toContain('已复制');
    } finally {
      vi.useRealTimers();
    }
  });
  it('数字设备身份不作为 QQ 号请求名片名称、QQ 秀和资料', async () => {
    const show = vi.spyOn(client.account.dressup.peerQqShow, 'query');
    const dress = vi.spyOn(client.account.dressup.peerHome, 'query');
    const profile = vi.spyOn(client.account.getProfile, 'query');
    const names = vi.spyOn(client.account.getCardDisplayNames, 'query');
    await mountCard(() => {}, undefined, {
      ...MEMBER,
      id: 'phone:10002',
      identityLabel: '设备',
      identityValue: '10002',
    });
    expect(show).not.toHaveBeenCalled();
    expect(dress).not.toHaveBeenCalled();
    expect(profile).not.toHaveBeenCalled();
    expect(names).not.toHaveBeenCalled();
    expect(layer().querySelector('[aria-label="合成共同群跳转"]')).toBeNull();
  });
  it('群内未返回或无效时间不展示 epoch 与 Invalid Date 占位', async () => {
    await mountCard(
      () => {},
      undefined,
      { ...MEMBER, joinedAt: new Date(0).toISOString(), lastSpeakAt: 'invalid' } as User,
      '20001',
    );
    expect(layer().textContent).not.toContain('1970');
    expect(layer().textContent).not.toContain('Invalid Date');
    expect(layer().textContent).not.toContain('入群时间');
    expect(layer().textContent).not.toContain('最后群发言');
  });
  it('各入口补全资料后以真实昵称为主标题，不使用备注或群昵称', async () => {
    vi.spyOn(client.account.getProfile, 'query').mockResolvedValueOnce({
      uid: MEMBER.id,
      nick: '真实昵称',
      remark: '好友备注',
    } as NonNullable<Awaited<ReturnType<typeof client.account.getProfile.query>>>);
    await mountCard(
      () => {},
      undefined,
      { ...MEMBER, nick: '旧昵称', remark: '旧备注', card: '群昵称' } as User,
      '20001',
    );
    expect(layer().querySelector('.weq-profile-name')?.textContent).toBe('真实昵称');
    expect(layer().textContent).toContain('好友备注');
    act(() => layer().querySelector<HTMLButtonElement>('.weq-profile-name')!.click());
    expect(expandContact).toHaveBeenLastCalledWith(
      expect.objectContaining({ contact: expect.objectContaining({ nick: '真实昵称' }) }),
    );
  });

  it.each(['成员昵称', ''])('资料缺失时使用成员真实昵称或身份，不使用群昵称：%s', async (nick) => {
    await mountCard(() => {}, undefined, {
      ...MEMBER,
      nick,
      remark: '好友备注',
      card: '群昵称',
    } as User);
    expect(layer().querySelector('.weq-profile-name')?.textContent).toBe(
      nick || MEMBER.identityValue,
    );
  });

  it('仍在群内时保留原成员资料编辑器', async () => {
    await mountCard(() => {}, undefined, MEMBER, '20001', {
      friends: new Map(),
      friendsComplete: true,
      groups: new Map([['20001', { listed: true, role: 'member' }]]),
    });
    expect(layer().querySelector('[data-member-editor]')).not.toBeNull();
  });
  it('群外保留历史群昵称和头衔，但不挂载成员编辑器；好友关系在资料失败时仍保留', async () => {
    preferences.friendClue = true;
    vi.spyOn(client.account.getProfile, 'query').mockRejectedValueOnce(new Error('合成错误'));
    await mountCard(
      () => {},
      undefined,
      { ...MEMBER, card: '历史群昵称', customTitle: '历史头衔' } as User,
      '20001',
      {
        friends: new Map([[MEMBER.id, {}]]),
        friendsComplete: true,
        groups: new Map([['20001', { listed: false }]]),
      },
    );
    expect(layer().querySelector('.weq-relationship-status')?.textContent).toBe('我的好友');
    expect(layer().textContent).toContain('历史群昵称');
    expect(layer().textContent).toContain('历史头衔');
    expect(layer().querySelector('[data-member-editor]')).toBeNull();
    expect(layer().querySelector('[data-friend-clue]')?.getAttribute('data-friend-clue')).toBe(
      MEMBER.id,
    );
  });
  it.each([true, false])('资料补全后显示明确好友关系 %s', async (isFriend) => {
    preferences.friendClue = true;
    vi.spyOn(client.account.getProfile, 'query').mockResolvedValueOnce({
      uid: MEMBER.id,
      isFriend,
      friendshipKnown: true,
    } as NonNullable<Awaited<ReturnType<typeof client.account.getProfile.query>>>);
    await mountCard(() => {});
    expect(layer().querySelector('.weq-relationship-status')?.textContent).toBe(
      isFriend ? '我的好友' : '非好友',
    );
    expect(Boolean(layer().querySelector('[data-friend-clue]'))).toBe(isFriend);
  });

  it('资料读取失败显示待确认，不显示非好友', async () => {
    vi.spyOn(client.account.getProfile, 'query').mockRejectedValueOnce(new Error('合成错误'));
    await mountCard(() => {});
    expect(layer().querySelector('.weq-relationship-status')?.textContent).toBe('关系待确认');
  });
  it('共同群跳转通知关闭成员名片', async () => {
    const close = vi.fn();
    await mountCard(close);
    act(() => document.querySelector<HTMLButtonElement>('[aria-label="合成共同群跳转"]')!.click());
    expect(close).toHaveBeenCalledOnce();
  });
  it('仅有 UID 的 @ 等入口在资料补全后显示 QQ 头像', async () => {
    let finish!: (
      profile: NonNullable<Awaited<ReturnType<typeof client.account.getProfile.query>>>,
    ) => void;
    const byUid = vi.spyOn(client.account.getProfile, 'query').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const member = profileTargetUser({ identity: 'u_mentioned', name: '被提及的人' })!;
    await mountCard(() => {}, undefined, member);
    expect(layer().querySelector('.weq-profile-avatar img')).toBeNull();
    await act(async () =>
      finish({ uid: member.id, uin: '10009', avatarUrl: '' } as NonNullable<
        Awaited<ReturnType<typeof client.account.getProfile.query>>
      >),
    );
    expect(byUid).toHaveBeenCalledWith({
      uid: member.id,
      expectedAccountUin: '10001',
      expectedAccountConfigId: 'source',
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(layer().querySelector('.weq-profile-avatar img')?.getAttribute('src')).toBe(
      cachedAvatarUrl(avatarFromUin('10009')),
    );
  });

  it('资料只有头像地址、没有有效 QQ 号时也显示头像并修复空尺寸参数', async () => {
    const avatarUrl = 'http://qh.qlogo.cn/g?b=qq&ek=synthetic&s=';
    vi.spyOn(client.account.getProfile, 'query').mockResolvedValueOnce({
      uid: 'u_peer',
      uin: '0',
      avatarUrl,
    } as NonNullable<Awaited<ReturnType<typeof client.account.getProfile.query>>>);
    await mountCard(() => {}, undefined, profileTargetUser({ identity: 'u_peer', name: '成员' })!);
    expect(layer().querySelector('.weq-profile-avatar img')?.getAttribute('src')).toBe(
      cachedAvatarUrl(avatarUrl.replace('s=', 's=0')),
    );
  });

  it('消息头像、成员列表等入口已有头像时保留原头像', async () => {
    vi.spyOn(client.account.getProfile, 'query').mockResolvedValueOnce({
      uin: '10009',
      avatarUrl: 'https://qh.qlogo.cn/g?b=qq&ek=other&s=0',
    } as NonNullable<Awaited<ReturnType<typeof client.account.getProfile.query>>>);
    const avatarUrl = avatarFromUin('10001')!;
    await mountCard(() => {}, undefined, { ...MEMBER, avatarUrl });
    expect(layer().querySelector('.weq-profile-avatar img')?.getAttribute('src')).toBe(
      cachedAvatarUrl(avatarUrl),
    );
  });

  it('QQ 号入口未传头像且资料未缓存时仍可生成头像', async () => {
    await mountCard(() => {}, undefined, { ...MEMBER, id: '' });
    expect(layer().querySelector('.weq-profile-avatar img')?.getAttribute('src')).toBe(
      cachedAvatarUrl(avatarFromUin(MEMBER.identityValue)),
    );
  });

  it.each(['联系人详情', '聊天分析'])('从名片进入%s沿用补全后的头像', async (entry) => {
    vi.spyOn(client.account.getProfile, 'query').mockResolvedValueOnce({
      uid: 'u_peer',
      uin: '10009',
    } as NonNullable<Awaited<ReturnType<typeof client.account.getProfile.query>>>);
    await mountCard(
      () => {},
      undefined,
      profileTargetUser({ identity: 'u_peer', name: '成员' })!,
      '12345',
    );
    const button = [...layer().querySelectorAll('button')].find(
      (el) => (el.getAttribute('aria-label') || el.textContent) === entry,
    );
    expect(button).toBeDefined();
    act(() => button!.click());
    const avatarUrl = avatarFromUin('10009');
    if (entry === '联系人详情') {
      expect(expandContact).toHaveBeenLastCalledWith(
        expect.objectContaining({
          kind: 'person',
          contact: expect.objectContaining({ avatarUrl }),
        }),
      );
    } else {
      expect(vi.mocked(MemberAnalyticsDialog).mock.lastCall?.[0].member.avatarUrl).toBe(avatarUrl);
    }
  });

  it.each(['missing', 'failed'])(
    '仅有 UID 且资料 %s 时保留默认头像，不把 UID 当 QQ 号',
    async (result) => {
      const byUid = vi.spyOn(client.account.getProfile, 'query');
      if (result === 'failed') byUid.mockRejectedValueOnce(new Error('合成读取失败'));
      else byUid.mockResolvedValueOnce(null);
      await mountCard(
        () => {},
        undefined,
        profileTargetUser({ identity: 'u_unknown', name: '成员' })!,
      );
      expect(layer().querySelector('.weq-profile-avatar img')).toBeNull();
      expect(layer().querySelector('.weq-profile-avatar .has-default')).not.toBeNull();
    },
  );

  it('自己的本地身份不是 QQ UID 时按 QQ 号补资料，不把 self 前缀发给 UID 查询', async () => {
    await mountCard(() => {}, { x: 120, y: 120 }, { ...MEMBER, id: 'self:10001' });
    expect(client.account.getProfileByUin.query).toHaveBeenCalledWith({
      uin: '10001',
      expectedAccountUin: '10001',
      expectedAccountConfigId: 'source',
    });
  });
  beforeEach(() => {
    preferences.friendClue = false;
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const root of roots) act(() => root.unmount());
    for (const host of hosts) host.remove();
    roots.length = 0;
    hosts.length = 0;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('自己的 QQ 号补全出 UID 后不再清空重查，退出加载并保留资料', async () => {
    const byUid = vi.spyOn(client.account.getProfile, 'query');
    const profile = {
      uid: 'u_self',
      uin: '10001',
      nick: '自己的昵称',
      signature: '自己的签名',
    } as NonNullable<Awaited<ReturnType<typeof client.account.getProfileByUin.query>>>;
    const byUin = vi.spyOn(client.account.getProfileByUin, 'query').mockResolvedValueOnce(profile);
    await mountCard(() => {}, { x: 120, y: 120 }, { ...MEMBER, id: 'self:10001' });
    expect(byUin).toHaveBeenCalledOnce();
    expect(byUid).not.toHaveBeenCalled();
    expect(layer().textContent).toContain('自己的签名');
    expect(layer().textContent).not.toContain('加载资料');
  });
  it('名片默认使用本地昵称，云端补全后更新名称并允许清空备注，不修改会话对象', async () => {
    let finish!: (value: { name: string; remark: string }) => void;
    vi.spyOn(client.account.getCardDisplayNames, 'query').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const member = {
      ...MEMBER,
      nick: '本地昵称',
      remark: '本地备注',
      displayName: '本地备注',
    } as User;
    await mountCard(() => {}, undefined, member);
    expect(layer().querySelector('.weq-profile-name')?.textContent).toBe(member.nick);
    expect(layer().textContent).toContain(member.remark);
    await act(async () => {
      finish({ name: '云端昵称', remark: '' });
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(layer().querySelector('.weq-profile-name')?.textContent).toBe('云端昵称');
    expect(layer().textContent).not.toContain('本地备注');
    expect(member.displayName).toBe('本地备注');
    expect(member.nick).toBe('本地昵称');
  });
  it('自己的资料读取失败后退出加载，不不断重试', async () => {
    const byUin = vi
      .spyOn(client.account.getProfileByUin, 'query')
      .mockRejectedValueOnce(new Error('合成读取失败'));
    await mountCard(() => {}, { x: 120, y: 120 }, { ...MEMBER, id: 'self:10001' });
    expect(byUin).toHaveBeenCalledOnce();
    expect(layer().textContent).not.toContain('加载资料');
  });
  it('点击对象已有真实 UID 时只查一次 UID，不退回自己的本地 ID', async () => {
    const byUid = vi.spyOn(client.account.getProfile, 'query').mockResolvedValueOnce(null);
    const byUin = vi.spyOn(client.account.getProfileByUin, 'query');
    const member = { ...MEMBER, id: 'self:10001', uid: 'u_self' };
    await mountCard(() => {}, { x: 120, y: 120 }, member);
    expect(byUid).toHaveBeenCalledOnce();
    expect(byUid).toHaveBeenCalledWith({
      uid: 'u_self',
      expectedAccountUin: '10001',
      expectedAccountConfigId: 'source',
    });
    expect(byUin).not.toHaveBeenCalled();
    expect(layer().textContent).not.toContain('加载资料');
  });

  it('portal 到 body，且层级高于所有写死的静态 z-index', async () => {
    await mountCard(() => {});
    const el = layer();
    expect(el.classList.contains('weq-member-pop-scrim')).toBe(true);
    expect(Number(el.style.zIndex)).toBeGreaterThan(STATIC_CSS_CEILING);
  });

  it('点遮罩空白处关闭，点卡片本体不关闭', async () => {
    let closed = 0;
    await mountCard(() => {
      closed += 1;
    });

    const card = layer().querySelector('.weq-member-pop');
    expect(card).toBeTruthy();
    act(() => {
      card!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    });
    expect(closed).toBe(0);

    act(() => {
      layer().dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
      layer().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    expect(closed).toBe(1);
  });
  it('异步编辑区改变高度后重新避让视口，卸载时释放尺寸观察', async () => {
    let height = 80;
    let resized: (() => void) | undefined;
    const disconnect = vi.fn();
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(288);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(() => height);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          resized = callback;
        }
        observe() {}
        disconnect = disconnect;
      },
    );
    await mountCard(() => {});
    const card = layer().querySelector<HTMLElement>('.weq-member-pop')!;
    expect(resized).toBeTypeOf('function');
    height = window.innerHeight - 40;
    act(() => resized?.());
    expect(Number.parseFloat(card.style.top) + height).toBeLessThanOrEqual(window.innerHeight - 10);
    expect(Number.parseFloat(card.style.top)).toBeGreaterThanOrEqual(10);
    const before = disconnect.mock.calls.length;
    act(() => roots.pop()!.unmount());
    expect(disconnect).toHaveBeenCalledTimes(before + 1);
  });
  it('窗口缩小后旧锚点超出视口时，也会横向夹回窗口内', async () => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(288);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(180);
    await mountCard(() => {}, { x: window.innerWidth + 500, y: 120 });
    const card = layer().querySelector<HTMLElement>('.weq-member-pop')!;
    expect(Number.parseFloat(card.style.left) + 288).toBeLessThanOrEqual(window.innerWidth);
    expect(Number.parseFloat(card.style.left)).toBeGreaterThanOrEqual(0);
  });
});
