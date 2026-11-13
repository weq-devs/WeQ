// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  createGraphSimulation,
  fitGraphView,
} from '../src/renderer/src/components/relationGraph/graphLayout';
import type { BuiltGraph, GNode } from '../src/renderer/src/components/relationGraph/types';

function fixture(count = 100, connected = true): BuiltGraph {
  const nodes: GNode[] = Array.from({ length: count }, (_, i) => ({
    id: `node-${i}`,
    kind: 'person',
    label: `成员 ${i}`,
    avatarUrl: null,
    community: connected ? Math.floor(i / 25) : i,
    weight: 100,
    radius: 14,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    fx: null,
    fy: null,
  }));
  const edges: BuiltGraph['edges'] = [];
  for (let i = 0; i < count; i++) {
    for (let j = i + 1; connected && j < count; j++) {
      if (nodes[i].community === nodes[j].community)
        edges.push({ source: nodes[i].id, target: nodes[j].id, weight: 2, dist: 140 });
    }
  }
  nodes.push({ ...nodes[0], id: '__self__', kind: 'self', radius: 26 });
  for (const node of nodes.slice(0, -1))
    edges.push({ source: '__self__', target: node.id, weight: 2, dist: 250, strength: 0.006 });
  return { nodes, edges, communityCount: connected ? Math.ceil(count / 25) : count };
}

describe('群交集紧凑布局', () => {
  it('重合初始坐标被分散，结果可重复，且不改变关系数量', () => {
    const graph = fixture();
    const other = fixture();
    const sim = createGraphSimulation(graph).stop();
    const second = createGraphSimulation(other).stop();
    expect(new Set(graph.nodes.map((n) => `${n.x},${n.y}`)).size).toBe(graph.nodes.length);
    expect(graph.nodes.map((n) => [n.x, n.y])).toEqual(other.nodes.map((n) => [n.x, n.y]));
    expect(graph.edges).toHaveLength(1300);
    sim.tick(240);
    second.tick(240);
    expect(graph.nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(
      true,
    );
    expect(graph.nodes.map((n) => [n.x, n.y])).toEqual(other.nodes.map((n) => [n.x, n.y]));
  });

  it('高阈值下只连接自己的零散节点仍保持有限坐标', () => {
    const graph = fixture(200, false);
    const sim = createGraphSimulation(graph).stop();
    sim.tick(300);
    expect(graph.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true);
  });

  it('相同节点保留原位置与速度，新加入节点不堆在原点', () => {
    const graph = fixture(3);
    const old = { ...graph.nodes[0], x: 350, y: -120, vx: 2, vy: -1 };
    const sim = createGraphSimulation(graph, [old]).stop();
    expect(graph.nodes[0]).toMatchObject({ x: 350, y: -120, vx: 2, vy: -1 });
    expect(graph.nodes[1].x !== 0 || graph.nodes[1].y !== 0).toBe(true);
    sim.stop();
  });
});

describe('群交集自动取景', () => {
  it.each([
    [1180, 620, 90],
    [390, 280, 130],
    [320, 280, 150],
  ])('%i × %i 中头像与标签完整显示，避开 %i px 工具栏', (width, height, top) => {
    const graph = fixture(200, false);
    createGraphSimulation(graph).stop().tick(240);
    const view = fitGraphView(graph.nodes, width, height, top);
    for (const node of graph.nodes) {
      expect((node.x - node.radius - 24) * view.scale + view.x).toBeGreaterThanOrEqual(15);
      expect((node.x + node.radius + 24) * view.scale + view.x).toBeLessThanOrEqual(width - 15);
      expect((node.y - node.radius) * view.scale + view.y).toBeGreaterThanOrEqual(top - 0.001);
      expect((node.y + node.radius + 24) * view.scale + view.y).toBeLessThanOrEqual(height - 39);
    }
  });

  it('空图和暂时为零的容器尺寸不产生无穷或 NaN', () => {
    for (const nodes of [[], fixture(1).nodes]) {
      const view = fitGraphView(nodes, 0, 0, 100);
      expect(Object.values(view).every(Number.isFinite)).toBe(true);
    }
  });
});
