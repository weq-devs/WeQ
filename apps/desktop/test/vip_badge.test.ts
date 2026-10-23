import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VipBadge } from '../src/renderer/src/components/VipBadge';
import { useViewState } from '../src/renderer/src/state/view';

type VipWire = {
  tier: 'vip' | 'svip' | 'bvip';
  year: boolean;
  level: number;
  expireAt?: number;
  fetchedAt: number;
  uin: string;
  source: 'club-api' | 'local';
};

const state = vi.hoisted(() => ({ vip: null as VipWire | null, invalidate: vi.fn() }));

vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    useUtils: () => ({ account: { getSelfVip: { invalidate: state.invalidate } } }),
    account: {
      getSelfVip: { useQuery: () => ({ data: state.vip }) },
      onVipChanged: { useSubscription: () => {} },
    },
  },
}));

let cleanup = () => {};

function fixture() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = () => act(() => root.render(h(VipBadge, {})));
  cleanup = () => {
    act(() => root.unmount());
    host.remove();
  };
  render();
  return { host, render };
}

const base: VipWire = {
  tier: 'svip',
  year: false,
  level: 4,
  fetchedAt: 1,
  uin: '10001',
  source: 'club-api',
};

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.vip = { ...base };
  state.invalidate.mockClear();
  useViewState.setState({ openedUin: '10001' });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('顶栏会员徽标', () => {
  it('三档各有自己的文案与修饰类', () => {
    const f = fixture();
    const cases: Array<[VipWire['tier'], string]> = [
      ['vip', 'VIP'],
      ['svip', 'SVIP'],
      ['bvip', '大会员'],
    ];
    for (const [tier, text] of cases) {
      state.vip = { ...base, tier };
      f.render();
      const badge = f.host.querySelector('.app-title-bar-vip-badge')!;
      expect(badge.textContent).toBe(text);
      expect(badge.classList.contains(`is-${tier}`)).toBe(true);
    }
  });

  it('年费加「年」前缀，等级与到期写进悬浮提示', () => {
    const f = fixture();
    state.vip = {
      ...base,
      tier: 'bvip',
      year: true,
      level: 8,
      expireAt: Date.UTC(2026, 10, 18, 7, 52, 4) / 1000,
    };
    f.render();
    const badge = f.host.querySelector('.app-title-bar-vip-badge')!;
    expect(badge.textContent).toBe('年 大会员');
    const title = badge.getAttribute('title') ?? '';
    expect(title).toContain('大会员（年费）');
    expect(title).toContain('8 级');
    expect(title).toContain('到期');
  });

  it('本地兜底数据标明来源，且不编造等级外的信息', () => {
    const f = fixture();
    state.vip = { ...base, tier: 'svip', level: 0, source: 'local' };
    f.render();
    const badge = f.host.querySelector('.app-title-bar-vip-badge')!;
    expect(badge.getAttribute('title')).toContain('来自本地资料库');
    // 「超级会员」三字里也有「级」，这里要断言的是没有「<数字> 级」这种等级段。
    expect(badge.getAttribute('title')).not.toMatch(/\d+ 级/);
  });

  it('不是会员时什么都不渲染', () => {
    const f = fixture();
    state.vip = null;
    f.render();
    expect(f.host.querySelector('.app-title-bar-vip-badge')).toBeNull();
  });

  it('返回的 uin 与当前打开的账号不一致时先不渲染（防切号闪旧值）', () => {
    const f = fixture();
    act(() => useViewState.setState({ openedUin: '20002' }));
    f.render();
    expect(f.host.querySelector('.app-title-bar-vip-badge')).toBeNull();
  });
});
