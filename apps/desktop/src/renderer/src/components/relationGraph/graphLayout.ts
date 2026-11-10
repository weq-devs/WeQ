import * as d3 from 'd3';
import type { BuiltGraph, GEdge, GNode } from './types';
import { packedLinkForce } from './graphLinkForce';

export interface GraphView {
  scale: number;
  x: number;
  y: number;
}

export type GraphPosition = Pick<GNode, 'id' | 'x' | 'y' | 'vx' | 'vy'>;
export const PACKED_LINK_EDGE_THRESHOLD = 10000;

/** 保留紧凑的初始占位；连续受力沿用原版 D3 图谱参数。 */
export function createGraphSimulation(graph: BuiltGraph, previous: GraphPosition[] = []) {
  const clusters = new Map<string, GNode[]>();
  for (const node of graph.nodes) {
    const key = node.kind === 'self' ? 'self' : `community-${node.community}`;
    const members = clusters.get(key) ?? [];
    members.push(node);
    clusters.set(key, members);
  }
  const circles = [...clusters.values()].map((members) => ({
    members,
    r: Math.sqrt(members.reduce((sum, node) => sum + (node.radius + 12) ** 2, 0)) * 1.35 + 20,
    x: 0,
    y: 0,
  }));
  d3.packSiblings(circles);
  const positions = new Map(previous.map((node) => [node.id, node]));
  for (const circle of circles) {
    circle.members.forEach((node, i) => {
      const old = positions.get(node.id);
      if (old && Number.isFinite(old.x) && Number.isFinite(old.y)) {
        Object.assign(node, { x: old.x, y: old.y, vx: old.vx, vy: old.vy });
      } else {
        const angle = i * Math.PI * (3 - Math.sqrt(5));
        const radius = Math.sqrt(i + 0.5) * (node.radius * 2 + 12);
        Object.assign(node, {
          x: circle.x + Math.cos(angle) * radius,
          y: circle.y + Math.sin(angle) * radius,
          vx: 0,
          vy: 0,
        });
      }
    });
  }

  const id = (endpoint: string | GNode) => (typeof endpoint === 'string' ? endpoint : endpoint.id);
  const packed = graph.edges.length >= PACKED_LINK_EDGE_THRESHOLD;
  const degree = new Map<string, number>();
  for (const edge of packed ? [] : graph.edges) {
    for (const endpoint of [edge.source, edge.target]) {
      const key = id(endpoint);
      degree.set(key, (degree.get(key) ?? 0) + 1);
    }
  }
  return d3
    .forceSimulation(graph.nodes)
    .force(
      'link',
      packed
        ? packedLinkForce(graph.edges)
        : d3
            .forceLink<GNode, GEdge>(graph.edges)
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
    .force('center', d3.forceCenter<GNode>(0, 0));
}

/** 预留顶部工具栏、底部操作钮及头像下方的标签，不依赖图形恰好在画布中心。 */
export function fitGraphView(nodes: GNode[], width: number, height: number, top = 96): GraphView {
  let left = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  let upper = Infinity;
  for (const node of nodes) {
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) continue;
    left = Math.min(left, node.x - node.radius - 24);
    right = Math.max(right, node.x + node.radius + 24);
    bottom = Math.max(bottom, node.y + node.radius + 24);
    upper = Math.min(upper, node.y - node.radius);
  }
  if (!Number.isFinite(left) || width <= 0 || height <= 0) return { scale: 1, x: 0, y: 0 };
  const availableWidth = Math.max(1, width - 32);
  const availableHeight = Math.max(1, height - top - 40);
  const scale = Math.min(
    1.4,
    availableWidth / Math.max(1, right - left),
    availableHeight / Math.max(1, bottom - upper),
  );
  return {
    scale,
    x: width / 2 - ((left + right) / 2) * scale,
    y: top + availableHeight / 2 - ((upper + bottom) / 2) * scale,
  };
}
