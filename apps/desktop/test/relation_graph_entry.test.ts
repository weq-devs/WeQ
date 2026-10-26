import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { RelationGraphView } from '../src/renderer/src/components/relationGraph/RelationGraphView';
import type { RelationGraphData } from '../src/renderer/src/components/relationGraph/types';

const query = vi.hoisted(() => ({
  data: undefined as RelationGraphData | undefined,
  isLoading: true,
}));

vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    account: {
      getRelationGraph: { useQuery: () => query },
      getHomeDress: { useQuery: () => ({ data: undefined }) },
    },
  },
  client: {},
}));

// 布局引擎不参与入口判断，避免在 DOM 单测中启动动画或读取画布。
vi.mock('../src/renderer/src/components/relationGraph/GraphCanvas', () => ({
  GraphCanvas: () => h('div', { 'data-testid': 'graph-canvas' }),
}));

afterEach(() => vi.unstubAllGlobals());

it('群交集保留统计首页，加载完成后可进入图谱并主动返回', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  query.data = undefined;
  query.isLoading = true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = () => act(() => root.render(h(RelationGraphView)));
  try {
    render();
    expect(host.querySelector('.weq-relhome')).not.toBeNull();
    expect(host.querySelector('.weq-graph-stage')).toBeNull();
    expect(host.querySelector<HTMLButtonElement>('.weq-relhome-cta')?.disabled).toBe(true);
    query.data = {
      selfUin: '10001',
      nodes: [
        {
          uid: 'u_fixture',
          uin: '10002',
          nick: '合成群友',
          card: '',
          groupCount: 2,
          groupCodes: ['20001', '20002'],
          intimacy: 0,
          isFriend: true,
        },
      ],
      groups: [],
      scannedGroups: 2,
      builtAt: 0,
    };
    query.isLoading = false;
    render();
    expect(host.querySelector('.weq-relhome')).not.toBeNull();
    act(() => host.querySelector<HTMLButtonElement>('.weq-relhome-cta')!.click());
    expect(host.querySelector('[data-testid="graph-canvas"]')).not.toBeNull();
    expect(host.querySelector('.weq-relhome')).toBeNull();
    act(() => host.querySelector<HTMLButtonElement>('[title="回到群交集首页"]')!.click());
    expect(host.querySelector('.weq-relhome')).not.toBeNull();
    act(() => host.querySelector<HTMLButtonElement>('.weq-relhome-cta')!.click());
    expect(host.querySelector('[data-testid="graph-canvas"]')).not.toBeNull();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
