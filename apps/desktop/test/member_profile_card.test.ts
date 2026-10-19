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
      getProfileByUin: { query: async () => null },
      getBotProfile: { query: async () => null },
    },
  },
  // 卡片底部的「互动画像」入口会读意图感知状态；这里给一个「未开启」的桩，
  // 入口不渲染，也就不会把画像 Dialog 的依赖链拖进来。
  trpc: {
    account: {
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

async function mountCard(onClose: () => void): Promise<void> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      createElement(MemberProfileCard, {
        member: MEMBER,
        anchor: { x: 120, y: 120 },
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
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    for (const root of roots) act(() => root.unmount());
    for (const host of hosts) host.remove();
    roots.length = 0;
    hosts.length = 0;
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
      card!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    });
    expect(closed).toBe(0);

    act(() => {
      layer().dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    });
    expect(closed).toBe(1);
  });
});
