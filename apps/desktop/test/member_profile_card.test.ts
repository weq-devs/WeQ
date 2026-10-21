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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 卡片会拉 tRPC 补全陌生人资料 —— 单测不建 ipc 链接，给个死数据桩。
vi.mock('@renderer/trpc/client', () => ({
  client: {
    account: {
      getProfile: { query: async () => null },
      getProfileByUin: { query: vi.fn(async () => null) },
      getBotProfile: { query: async () => null },
    },
  },
  // 卡片底部的「互动画像」入口会读意图感知状态；这里给一个「未开启」的桩，
  // 入口不渲染，也就不会把画像 Dialog 的依赖链拖进来。
  trpc: {
    account: {
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

// 卡片底部的三个「从卡片里再打开」的灯箱与本次断言无关，换成空壳避免把
// 个性主页 / 聊天分析那一整条依赖链拖进单测。
vi.mock('@renderer/components/PersonalityHomeDialog', () => ({
  PersonalityHomeDialog: () => null,
}));
vi.mock('@renderer/components/MutualMarkDialog', () => ({ MutualMarkDialog: () => null }));
vi.mock('@renderer/components/MemberAnalyticsDialog', () => ({
  MemberAnalyticsDialog: () => null,
}));

import { MemberProfileCard } from '@renderer/components/MemberProfileCard';
import { client } from '@renderer/trpc/client';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

/** overlayStack 的 BASE 之下、写死 z-index 的都在这一档以内。 */
const STATIC_CSS_CEILING = 1200;

const roots: Root[] = [];
const hosts: HTMLDivElement[] = [];

const MEMBER = {
  id: 'uid-1',
  identityLabel: 'QQ',
  identityValue: '10001',
  username: 'tester',
  displayName: '测试用户',
  avatarUrl: null,
};

async function mountCard(
  onClose: () => void,
  anchor = { x: 120, y: 120 },
  member = MEMBER,
): Promise<void> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      createElement(MemberProfileCard, {
        member,
        anchor,
        onClose,
      }),
    );
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
  it('自己的本地身份不是 QQ UID 时按 QQ 号补资料，不把 self 前缀发给 UID 查询', async () => {
    await mountCard(() => {}, { x: 120, y: 120 }, { ...MEMBER, id: 'self:10001' });
    expect(client.account.getProfileByUin.query).toHaveBeenCalledWith({ uin: '10001' });
  });
  beforeEach(() => {
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
    expect(byUid).toHaveBeenCalledWith({ uid: 'u_self' });
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
