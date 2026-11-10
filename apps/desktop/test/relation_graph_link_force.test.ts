// @vitest-environment node
import { forceLink, forceSimulation } from 'd3';
import { describe, expect, it } from 'vitest';
import { packedLinkForce } from '../src/renderer/src/components/relationGraph/graphLinkForce';
import {
  createGraphSimulation,
  PACKED_LINK_EDGE_THRESHOLD,
} from '../src/renderer/src/components/relationGraph/graphLayout';
import type { GEdge, GNode } from '../src/renderer/src/components/relationGraph/types';
import { physicsFixture } from './support/relation-physics-fixtures';

function referenceLink(edges: GEdge[]) {
  const id = (value: string | GNode) => (typeof value === 'string' ? value : value.id);
  const degree = new Map<string, number>();
  for (const edge of edges)
    for (const value of [edge.source, edge.target]) {
      const key = id(value);
      degree.set(key, (degree.get(key) ?? 0) + 1);
    }
  return forceLink<GNode, GEdge>(edges)
    .id((node) => node.id)
    .distance((edge) => edge.dist)
    .strength(
      (edge) =>
        edge.strength ?? 1 / Math.min(degree.get(id(edge.source))!, degree.get(id(edge.target))!),
    );
}

function compare(nodes: GNode[], edges: GEdge[], ticks: number) {
  const other = structuredClone(nodes);
  const actual = forceSimulation(nodes).force('link', packedLinkForce(edges)).stop();
  const referenceEdges = structuredClone(edges);
  const reference = forceSimulation(other).force('link', referenceLink(referenceEdges)).stop();
  actual.tick(ticks);
  reference.tick(ticks);
  const positions = (input: GNode[]) => input.map((node) => [node.x, node.y, node.vx, node.vy]);
  expect(positions(nodes)).toEqual(positions(other));
}

describe('密集图双精度连线内核', () => {
  it.each(['star', 'clusters', 'complete'] as const)('%s 与 D3 原公式逐步相同', (shape) => {
    const graph = physicsFixture(40, shape);
    compare(graph.nodes, graph.edges, 301);
  });
  it('重合位置、零轴、自环、重复边、显式零强度和固定节点仍使用相同随机序列', () => {
    const graph = physicsFixture(8, 'star');
    graph.nodes[0]!.fx = 0;
    graph.nodes[0]!.fy = 0;
    const edges: GEdge[] = [
      { source: 'person-0', target: 'person-0', weight: 1, dist: 0 },
      { source: 'person-0', target: 'person-1', weight: 1, dist: 30, strength: 0 },
      { source: 'person-0', target: 'person-1', weight: 1, dist: 20, strength: 0.3 },
      { source: 'person-2', target: 'person-0', weight: 1, dist: 40 },
    ];
    compare(graph.nodes, edges, 120);
  });
  it('打乱节点与边顺序、已有速度和断连节点仍保持轨迹', () => {
    const graph = physicsFixture(40, 'clusters');
    graph.nodes.reverse().forEach((node, i) => {
      node.x = i % 3;
      node.y = i % 5;
      node.vx = i / 7;
      node.vy = -i / 9;
    });
    compare(graph.nodes, graph.edges.toReversed().slice(5), 120);
  });
  it('阈值以上完整布局仍与四种原 D3 力的结果一致', () => {
    const graph = physicsFixture(160, 'complete');
    expect(graph.edges.length).toBeGreaterThan(PACKED_LINK_EDGE_THRESHOLD);
    const other = structuredClone(graph);
    const actual = createGraphSimulation(graph).stop();
    const original = createGraphSimulation(other).stop();
    original.force('link', referenceLink(other.edges));
    actual.tick(120);
    original.tick(120);
    expect(graph.nodes.map(({ x, y, vx, vy }) => [x, y, vx, vy])).toEqual(
      other.nodes.map(({ x, y, vx, vy }) => [x, y, vx, vy]),
    );
  });
});
