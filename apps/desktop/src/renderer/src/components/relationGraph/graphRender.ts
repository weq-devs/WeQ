import { quadtree } from 'd3';
import type { BuiltGraph, GNode } from './types';

export const GRAPH_LABEL_MIN_SCREEN_RADIUS = 14;
export function graphLabelVisible(
  node: Pick<GNode, 'kind' | 'radius'>,
  scale: number,
  focused: boolean,
  neighbour: boolean,
) {
  return (
    node.kind === 'self' ||
    focused ||
    (node.radius * scale >= GRAPH_LABEL_MIN_SCREEN_RADIUS &&
      (neighbour || node.radius >= 22 || scale >= 1.1))
  );
}

export interface RenderEdge {
  source: GNode;
  target: GNode;
  weight: number;
}

export interface EdgeBatch {
  self: boolean;
  width: number;
  edges: RenderEdge[];
}

/** 拓扑随图构建一次，坐标直接引用模拟节点，不在每帧重建。 */
export function indexGraphRender(graph: BuiltGraph) {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const adjacent = new Map(graph.nodes.map((node) => [node.id, new Set<string>()]));
  const incident = new Map(graph.nodes.map((node) => [node.id, [] as RenderEdge[]]));
  const batches = new Map<string, EdgeBatch>();
  // d3-force 会原地将端点 ID 替换为节点。
  const endpoint = (value: string | GNode) =>
    typeof value === 'string' ? nodes.get(value) : value;
  for (const edge of graph.edges) {
    const source = endpoint(edge.source);
    const target = endpoint(edge.target);
    if (!source || !target) continue;
    const resolved = { source, target, weight: edge.weight };
    adjacent.get(source.id)!.add(target.id);
    adjacent.get(target.id)!.add(source.id);
    incident.get(source.id)!.push(resolved);
    incident.get(target.id)!.push(resolved);
    const self = source.kind === 'self' || target.kind === 'self';
    const width = self ? 0.5 : Math.min(0.6 + edge.weight * 0.25, 2.4);
    const key = `${self}:${width}`;
    let batch = batches.get(key);
    if (!batch) {
      batch = { self, width, edges: [] };
      batches.set(key, batch);
    }
    batch.edges.push(resolved);
  }
  return { adjacent, incident, batches: [...batches.values()] };
}

/** 惰性重建；可固定在已绘制位置，保留画布后画节点优先的命中语义。 */
export function indexGraphHit(nodes: GNode[], positions?: Float64Array) {
  const order = new Map(nodes.map((node, i) => [node, i]));
  const x = (node: GNode) => (positions ? positions[order.get(node)! * 2]! : node.x);
  const y = (node: GNode) => (positions ? positions[order.get(node)! * 2 + 1]! : node.y);
  const tree = quadtree<GNode>().x(x).y(y).addAll(nodes);
  let radius = 0;
  for (const node of nodes) radius = Math.max(radius, node.radius + 2);
  return (px: number, py: number): GNode | null => {
    let hit: GNode | null = null;
    let top = -1;
    tree.visit((quad, x0, y0, x1, y1) => {
      if (x0 > px + radius || x1 < px - radius || y0 > py + radius || y1 < py - radius) return true;
      if (!quad.length) {
        let leaf: typeof quad | undefined = quad;
        do {
          const node = leaf.data;
          const index = order.get(node)!;
          if (index > top && (x(node) - px) ** 2 + (y(node) - py) ** 2 <= (node.radius + 2) ** 2) {
            hit = node;
            top = index;
          }
          leaf = leaf.next;
        } while (leaf);
      }
      return false;
    });
    return hit;
  };
}
