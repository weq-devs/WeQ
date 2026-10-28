import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IntentProfile } from '@weq/service';
import { IntentProfileDialog } from '../src/renderer/src/components/intentSense/IntentProfileDialog';
import { AffinityPill } from '../src/renderer/src/components/intentSense/AffinityPill';
import { ContactWorkspaceNavigationContext } from '../src/renderer/src/lib/profileNavigation';

const fixture = vi.hoisted(() => ({
  query: {
    data: null as IntentProfile | null | undefined,
    isLoading: false,
    error: null as Error | null,
    refetch: vi.fn(async () => {}),
  },
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: { account: { intentSense: { getProfile: { useQuery: () => fixture.query } } } },
}));
vi.mock('../src/renderer/src/components/intentSense/context', () => ({
  useIntentSenseStatus: () => ({
    data: {
      enabled: false,
      conversationOverrides: { 'c2c:u_synthetic': false },
      profileEnabled: true,
      profileAvailable: true,
      profileCacheSeconds: 60,
    },
  }),
}));

let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixture.query.data = null;
  fixture.query.isLoading = false;
  fixture.query.error = null;
  fixture.query.refetch.mockClear();
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function dialog() {
  await act(async () => {
    root.render(
      createElement(IntentProfileDialog, {
        peerUid: 'u_synthetic',
        peerName: '合成用户',
        onClose: () => {},
      }),
    );
  });
}

describe('无证据的互动画像', () => {
  it('联系人画像采用内嵌区域，不生成关闭按钮或模态浮层', async () => {
    await act(async () =>
      root.render(
        createElement(IntentProfileDialog, {
          peerUid: 'u_synthetic',
          peerName: '合成用户',
          embedded: true,
          onClose: vi.fn(),
        }),
      ),
    );
    expect(
      document.querySelector('[role="region"][aria-label="互动画像：合成用户"]'),
    ).not.toBeNull();
    expect(document.querySelector('.weq-overlay-layer')).toBeNull();
    expect(document.querySelector('[aria-label="关闭"]')).toBeNull();
    expect(document.body.textContent).toContain('暂无可分析的对方消息');
  });
  it('画像返回空时显示空状态，而非加载、评分、人格或雷达', async () => {
    await dialog();
    expect(document.body.textContent).toContain('暂无可分析的对方消息');
    expect(document.body.textContent).not.toContain('MBTI');
    expect(document.body.textContent).not.toContain('好感度');
    expect(document.querySelector('.weq-int-radar')).toBeNull();
    expect(document.querySelector('.weq-int-profile')).toBeNull();
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="重新计算"]')!.click(),
    );
    expect(fixture.query.refetch).toHaveBeenCalledOnce();
  });

  it('读取失败显示错误且允许重试，不伪装成空结果或持续加载', async () => {
    fixture.query.data = undefined;
    fixture.query.error = new Error('合成画像读取失败');
    await dialog();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('合成画像读取失败');
    expect(document.body.textContent).not.toContain('暂无可分析的对方消息');
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="重新计算"]')!.click(),
    );
    expect(fixture.query.refetch).toHaveBeenCalledOnce();
  });

  it('没有画像时不显示虚构好感度胶囊', async () => {
    await act(async () => root.render(createElement(AffinityPill, { peerUid: 'u_synthetic' })));
    expect(document.querySelector('.weq-affinity-pill')).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('有效画像正常显示；刷新变为空结果后清除旧分数与人格', async () => {
    fixture.query.data = {
      affinity: 70,
      tier: 3,
      trend: [],
      mbti: { letters: 'ENFP', dims: [], heuristic: true },
      radar: [],
      topics: [],
      sampled: 8,
      analyzedSamples: 2,
      engine: 'heuristic',
      computedAt: 1000,
    };
    await dialog();
    expect(document.querySelector('.weq-int-affinity-num')?.textContent).toBe('70');
    expect(document.body.textContent).toContain('ENFP');
    fixture.query.data = null;
    await dialog();
    expect(document.body.textContent).toContain('暂无可分析的对方消息');
    expect(document.body.textContent).not.toContain('ENFP');
    expect(document.querySelector('.weq-int-affinity-num')).toBeNull();
  });

  it('纯统计画像不显示默认好感度，仍有独立入口', async () => {
    fixture.query.data = {
      affinity: null,
      tier: null,
      trend: [],
      mbti: { letters: 'ENFP', dims: [], heuristic: true },
      radar: [],
      topics: [],
      sampled: 8,
      analyzedSamples: 0,
      engine: 'heuristic',
      computedAt: 1000,
    };
    await dialog();
    expect(document.querySelector('.weq-int-affinity-num')?.textContent).toBe('未分析');
    const open = vi.fn();
    await act(async () =>
      root.render(
        createElement(
          ContactWorkspaceNavigationContext.Provider,
          { value: open },
          createElement(AffinityPill, { peerUid: 'u_synthetic' }),
        ),
      ),
    );
    expect(document.querySelector('.weq-affinity-pill')?.textContent).toBe('互动画像');
    expect(document.querySelector('.weq-affinity-pill')?.classList.contains('tier-unrated')).toBe(
      true,
    );
    expect(document.querySelector('.tier-null')).toBeNull();
    act(() => document.querySelector<HTMLButtonElement>('.weq-affinity-pill')!.click());
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'person',
        tab: 'portrait',
        contact: expect.objectContaining({ id: 'u_synthetic' }),
      }),
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
