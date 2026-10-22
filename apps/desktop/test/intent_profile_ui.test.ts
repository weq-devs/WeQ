import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IntentProfile } from '@weq/service';
import { IntentProfileDialog } from '../src/renderer/src/components/intentSense/IntentProfileDialog';
import { AffinityPill } from '../src/renderer/src/components/intentSense/AffinityPill';

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
    data: { profileEnabled: true, profileAvailable: true, profileCacheSeconds: 60 },
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
});
