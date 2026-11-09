// @vitest-environment node
import * as d3 from 'd3';
import { describe, expect, it } from 'vitest';
import { createGraphSimulation } from '../src/renderer/src/components/relationGraph/graphLayout';
import type { BuiltGraph, GEdge, GNode } from '../src/renderer/src/components/relationGraph/types';

function fixture(): BuiltGraph {
  const nodes: GNode[] = Array.from({ length: 20 }, (_, i) => ({
    id: `node-${i}`,
    kind: 'person',
    label: `成员 ${i}`,
    avatarUrl: null,
    community: Math.floor(i / 10),
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
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      edges.push({
        source: nodes[i].id,
        target: nodes[j].id,
        weight: j - i,
        dist: 80 + j,
        ...(i === 0 ? { strength: 0.18 } : {}),
      });
    }
  }
  return { nodes, edges, communityCount: 2 };
}

describe('群交集恢复 2026-11-09 拉力核心', () => {
  it('轨迹与昨晚 769fead6 的 D3 受力配置一致，保留独立的初始占位和镜头', () => {
    const graph = fixture();
    const edges = graph.edges.map((edge) => ({ ...edge }));
    const actual = createGraphSimulation(graph).stop();
    const nodes = graph.nodes.map((node) => ({ ...node }));
    const id = (endpoint: string | GNode) =>
      typeof endpoint === 'string' ? endpoint : endpoint.id;
    const degree = new Map<string, number>();
    for (const edge of edges)
      for (const endpoint of [edge.source, edge.target]) {
        const key = id(endpoint);
        degree.set(key, (degree.get(key) ?? 0) + 1);
      }
    // 快照仅还原当时的物理核心；旧像素中心平移为当前镜头使用的世界原点。
    const reference = d3
      .forceSimulation(nodes)
      .force(
        'link',
        d3
          .forceLink<GNode, GEdge>(edges)
          .id((node) => node.id)
          .distance((edge) => edge.dist)
          .strength(
            (edge) =>
              edge.strength ??
              1 / Math.min(degree.get(id(edge.source)) ?? 1, degree.get(id(edge.target)) ?? 1),
          ),
      )
      .force('charge', d3.forceManyBody<GNode>().strength(-300))
      .force(
        'collide',
        d3
          .forceCollide<GNode>()
          .radius((node) => node.radius + 3)
          .iterations(2),
      )
      .force('center', d3.forceCenter<GNode>(0, 0))
      .stop();
    expect(actual.alphaDecay()).toBe(reference.alphaDecay());
    expect(actual.velocityDecay()).toBe(reference.velocityDecay());
    expect(actual.force('x')).toBeUndefined();
    expect(actual.force('y')).toBeUndefined();
    actual.tick(80);
    reference.tick(80);
    expect(graph.nodes.map((node) => [node.x, node.y, node.vx, node.vy])).toEqual(
      nodes.map((node) => [node.x, node.y, node.vx, node.vy]),
    );
  });

  it('恢复默认冷却时长以及拖动持续加热、松手后自然冷却', () => {
    const sim = createGraphSimulation(fixture()).stop();
    sim.tick(130);
    expect(sim.alpha()).toBeGreaterThan(sim.alphaMin());
    sim.alphaTarget(0.3).tick(100);
    expect(sim.alpha()).toBeGreaterThan(0.2);
    sim.alphaTarget(0).tick(301);
    expect(sim.alpha()).toBeLessThan(sim.alphaMin());
  });
});
