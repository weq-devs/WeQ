// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { ForceCollide, ForceLink } from 'd3';
import {
  createGraphSimulation,
  GRAPH_DRAG_ALPHA,
} from '../src/renderer/src/components/relationGraph/graphLayout';
import type { BuiltGraph, GEdge, GNode } from '../src/renderer/src/components/relationGraph/types';

function denseFixture(count: number, dense: boolean, strong: boolean): BuiltGraph {
  const nodes: GNode[] = Array.from({ length: count }, (_, i) => ({
    id: `node-${i}`,
    kind: 'person',
    label: `成员 ${i}`,
    avatarUrl: null,
    community: 0,
    weight: 1,
    radius: 14,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    fx: null,
    fy: null,
  }));
  const edges: GEdge[] = [];
  for (let i = 0; i < count; i++) {
    for (let j = i + 1; dense && j < count; j++) {
      edges.push({ source: nodes[i].id, target: nodes[j].id, weight: 500, dist: 10 });
    }
  }
  for (const node of nodes) {
    edges.push({
      source: '__self__',
      target: node.id,
      weight: 1,
      dist: 80,
      strength: strong ? 0.18 : 0.006,
    });
  }
  nodes.push({ ...nodes[0], id: '__self__', kind: 'self', radius: 26 });
  return { nodes, edges, communityCount: 1 };
}

const endpointId = (endpoint: string | GNode) =>
  typeof endpoint === 'string' ? endpoint : endpoint.id;

describe('群交集连线图受力稳定性', () => {
  it('密集连线与高权重连线都不能绕过按度数归一化的受力上限', () => {
    const graph = denseFixture(100, true, true);
    const sim = createGraphSimulation(graph).stop();
    const link = sim.force<ForceLink<GNode, GEdge>>('link')!;
    const degrees = new Map(graph.nodes.map((node) => [node.id, 0]));
    for (const edge of graph.edges) {
      for (const endpoint of [edge.source, edge.target]) {
        const id = endpointId(endpoint);
        degrees.set(id, degrees.get(id)! + 1);
      }
    }
    const load = new Map(graph.nodes.map((node) => [node.id, 0]));
    graph.edges.forEach((edge, index) => {
      const source = endpointId(edge.source);
      const target = endpointId(edge.target);
      const sourceDegree = degrees.get(source)!;
      const targetDegree = degrees.get(target)!;
      const strength = link.strength()(edge, index, graph.edges);
      // D3 按两端度数分摊连线的作用，独立累加每个节点实际承受的拉力系数。
      load.set(
        source,
        load.get(source)! + (strength * targetDegree) / (sourceDegree + targetDegree),
      );
      load.set(
        target,
        load.get(target)! + (strength * sourceDegree) / (sourceDegree + targetDegree),
      );
    });
    expect(Math.max(...load.values())).toBeLessThanOrEqual(1);
  });

  it('短连线的目标距离不小于两端碰撞半径之和', () => {
    const graph = denseFixture(10, true, false);
    const sim = createGraphSimulation(graph).stop();
    const link = sim.force<ForceLink<GNode, GEdge>>('link')!;
    const collide = sim.force<ForceCollide<GNode>>('collide')!;
    const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
    graph.edges.forEach((edge, index) => {
      const source = nodes.get(endpointId(edge.source))!;
      const target = nodes.get(endpointId(edge.target))!;
      expect(link.distance()(edge, index, graph.edges)).toBeGreaterThanOrEqual(
        collide.radius()(source, 0, graph.nodes) + collide.radius()(target, 0, graph.nodes),
      );
    });
  });

  it.each([
    [100, true, false],
    [500, true, true],
    [500, false, true],
  ] as const)(
    '%i 节点、密集=%s、强拉力=%s：持续模拟中 1px 扰动不会激起振荡',
    (count, dense, strong) => {
      const graph = denseFixture(count, dense, strong);
      const sim = createGraphSimulation(graph).stop().alphaDecay(0).alpha(GRAPH_DRAG_ALPHA);
      const control = denseFixture(count, dense, strong);
      const unperturbed = createGraphSimulation(control)
        .stop()
        .alphaDecay(0)
        .alpha(GRAPH_DRAG_ALPHA);
      sim.tick(240);
      unperturbed.tick(240);
      graph.nodes[0].fx = graph.nodes[0].x + 1;
      graph.nodes[0].fy = graph.nodes[0].y;
      let peakStep = 0;
      let lateStep = 0;
      let excursion = 0;
      for (let tick = 0; tick < 120; tick++) {
        const previous = graph.nodes.map((node) => [node.x, node.y]);
        const previousControl = control.nodes.map((node) => [node.x, node.y]);
        sim.tick();
        unperturbed.tick();
        for (let i = 1; i < graph.nodes.length; i++) {
          const node = graph.nodes[i];
          const reference = control.nodes[i];
          const step = Math.hypot(node.x - previous[i][0], node.y - previous[i][1]);
          peakStep = Math.max(peakStep, step);
          // 与未扰动的持续布局对照，区分整体舒展与微扰本身的放大。
          if (tick >= 100)
            lateStep = Math.max(
              lateStep,
              Math.hypot(
                node.x - previous[i][0] - reference.x + previousControl[i][0],
                node.y - previous[i][1] - reference.y + previousControl[i][1],
              ),
            );
          excursion = Math.max(excursion, Math.hypot(node.x - reference.x, node.y - reference.y));
        }
      }
      expect(peakStep, JSON.stringify({ peakStep, lateStep, excursion })).toBeLessThan(4);
      expect(lateStep).toBeLessThan(0.5);
      expect(excursion).toBeLessThan(20);
      // 冷却被禁用，测试不能靠模拟停止来掩盖持续振荡。
      expect(sim.alpha()).toBe(GRAPH_DRAG_ALPHA);
    },
  );
});

describe('群交集连线图冷却', () => {
  it.each([10, 100, 500])('%i 个节点在有限帧数内停止', (count) => {
    const nodes: GNode[] = Array.from({ length: count }, (_, i) => ({
      id: `node-${i}`,
      kind: 'person',
      label: `成员 ${i}`,
      avatarUrl: null,
      community: Math.floor(i / 25),
      weight: 1,
      radius: 14,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      fx: null,
      fy: null,
    }));
    const graph: BuiltGraph = {
      nodes,
      edges: nodes.slice(1).map((node, i) => ({
        source: nodes[i].id,
        target: node.id,
        weight: 1,
        dist: 100,
      })),
      communityCount: Math.ceil(count / 25),
    };
    const sim = createGraphSimulation(graph).stop();
    sim.tick(130);
    expect(sim.alpha()).toBeLessThan(sim.alphaMin());
    expect(sim.alphaTarget()).toBe(0);
    expect(nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true);
    sim.alpha(0.3).tick(130);
    expect(sim.alpha()).toBeLessThan(sim.alphaMin());
  });
});
