import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { RelationGraphView } from '../src/renderer/src/components/relationGraph/RelationGraphView';
import type { RelationGraphData } from '../src/renderer/src/components/relationGraph/types';

const query = vi.hoisted(() => ({
  data: undefined as RelationGraphData | undefined,
  isLoading: true,
}));

const memberRefresh = vi.hoisted(() => ({ refresh: vi.fn(), refreshing: false, ready: true }));
vi.mock('../src/renderer/src/hooks/useGroupMemberRefresh', () => ({
  useGroupMemberRefresh: () => memberRefresh,
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
  GraphCanvas: ({ graph, onSelect }) =>
    h(
      'div',
      { 'data-testid': 'graph-canvas' },
      graph.nodes.map((node) =>
        h(
          'button',
          {
            key: node.id,
            'data-kind': node.kind,
            onClick: () => onSelect(node, { x: 320, y: 240 }),
          },
          node.label,
        ),
      ),
    ),
}));

vi.mock('../src/renderer/src/im-template/template/profilePanes', () => ({
  GroupProfileDialog: ({ conversation, anchor, onClose }) =>
    h(
      'div',
      {
        'data-testid': 'group-profile',
        'data-anchor-left': anchor?.style.left,
        'data-anchor-top': anchor?.style.top,
      },
      conversation.group.name,
      h('button', { onClick: onClose }, '关闭群名片'),
    ),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  memberRefresh.refreshing = false;
  memberRefresh.refresh.mockClear();
});

it.each([false, true])('首页和图谱共用群成员刷新，更新时保留原结果，图谱=%s', (entered) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  query.isLoading = false;
  query.data = { selfUin: '', nodes: [], groups: [], scannedGroups: 0, builtAt: 0 };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() => root.render(h(RelationGraphView)));
    if (entered) act(() => host.querySelector<HTMLButtonElement>('.weq-relhome-cta')!.click());
    const button = host.querySelector<HTMLButtonElement>('[title="更新全部群成员并重新计算"]')!;
    act(() => button.click());
    expect(memberRefresh.refresh).toHaveBeenCalledTimes(1);
    memberRefresh.refreshing = true;
    act(() => root.render(h(RelationGraphView)));
    expect(button.disabled).toBe(true);
    expect(host.querySelector(entered ? '.weq-graph-stage' : '.weq-relhome-stats')).not.toBeNull();
    expect(host.textContent).not.toContain('正在扫描群成员、计算关系网');
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

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
    expect(host.querySelector('.weq-graph-col-rank')).toBeNull();
    expect(host.textContent).not.toContain('排行榜');
    act(() => host.querySelector<HTMLButtonElement>('[title="回到群交集首页"]')!.click());
    expect(host.querySelector('.weq-relhome')).not.toBeNull();
    act(() => host.querySelector<HTMLButtonElement>('.weq-relhome-cta')!.click());
    expect(host.querySelector('[data-testid="graph-canvas"]')).not.toBeNull();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});

it('单击群友或群头像直接打开旁边的标准名片，不再显示右上角信息卡', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  query.isLoading = false;
  query.data = {
    selfUin: '10001',
    nodes: [
      {
        uid: 'u_fixture',
        uin: '10002',
        nick: '合成群友',
        card: '群内名称',
        groupCount: 2,
        groupCodes: ['20001', '20002'],
        intimacy: 0,
        isFriend: true,
      },
    ],
    groups: [{ code: '20001', name: '合成群聊', memberCount: 12, sharedCount: 1, myLevel: 3 }],
    scannedGroups: 2,
    builtAt: 0,
  };
  const onOpenMember = vi.fn();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const click = (selector: string) =>
    act(() => host.querySelector<HTMLButtonElement>(selector)!.click());
  try {
    act(() => root.render(h(RelationGraphView, { onOpenMember })));
    click('.weq-relhome-cta');
    click('[data-kind="person"]');
    expect(onOpenMember).toHaveBeenCalledWith(query.data.nodes[0], { x: 320, y: 240 });
    expect(host.querySelector('.weq-graph-detail')).toBeNull();
    click('[title="群聊网络"]');
    click('[data-kind="group"]');
    const card = host.querySelector('[data-testid="group-profile"]');
    expect(card?.textContent).toContain('合成群聊');
    expect(card?.getAttribute('data-anchor-left')).toBe('320px');
    expect(card?.getAttribute('data-anchor-top')).toBe('240px');
    expect(host.querySelector('.weq-graph-detail')).toBeNull();
    click('[data-testid="group-profile"] button');
    expect(host.querySelector('[data-testid="group-profile"]')).toBeNull();
    click('[data-kind="group"]');
    click('[title="群友圈子"]');
    expect(host.querySelector('[data-testid="group-profile"]')).toBeNull();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
