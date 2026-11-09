import { quadtree } from 'd3';
import type { BuiltGraph, GNode } from './types';

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

/** 移动后惰性重建；查询圆形命中并保留画布后画节点优先的语义。 */
export function indexGraphHit(nodes: GNode[]) {
  const tree = quadtree<GNode>()
    .x((node) => node.x)
    .y((node) => node.y)
    .addAll(nodes);
  const order = new Map(nodes.map((node, i) => [node, i]));
  let radius = 0;
  for (const node of nodes) radius = Math.max(radius, node.radius + 2);
  return (x: number, y: number): GNode | null => {
    let hit: GNode | null = null;
    let top = -1;
    tree.visit((quad, x0, y0, x1, y1) => {
      if (x0 > x + radius || x1 < x - radius || y0 > y + radius || y1 < y - radius) return true;
      if (!quad.length) {
        let leaf: typeof quad | undefined = quad;
        do {
          const node = leaf.data;
          const index = order.get(node)!;
          if (index > top && (node.x - x) ** 2 + (node.y - y) ** 2 <= (node.radius + 2) ** 2) {
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
