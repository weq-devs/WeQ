import type { Force } from 'd3';
import type { GEdge, GNode } from './types';

/** 密集图按原 D3 连线顺序求解，以连续双精度状态减少逐边对象访问。 */
export function packedLinkForce(edges: readonly GEdge[]): Force<GNode, undefined> {
  let nodes: GNode[] = [];
  let random = Math.random;
  let state = new Float64Array(0);
  const source = new Uint32Array(edges.length);
  const target = new Uint32Array(edges.length);
  const distances = new Float64Array(edges.length);
  const strengths = new Float64Array(edges.length);
  const biases = new Float64Array(edges.length);

  function force(alpha: number) {
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!;
      const offset = i * 4;
      state[offset] = node.x;
      state[offset + 1] = node.y;
      state[offset + 2] = node.vx;
      state[offset + 3] = node.vy;
    }
    for (let i = 0; i < edges.length; i++) {
      const s = source[i]!;
      const t = target[i]!;
      let x = state[t]! + state[t + 2]! - state[s]! - state[s + 2]! || (random() - 0.5) * 1e-6;
      let y =
        state[t + 1]! + state[t + 3]! - state[s + 1]! - state[s + 3]! || (random() - 0.5) * 1e-6;
      const length = Math.sqrt(x * x + y * y);
      const pull = ((length - distances[i]!) / length) * alpha * strengths[i]!;
      x *= pull;
      y *= pull;
      const bias = biases[i]!;
      state[t + 2] = state[t + 2]! - x * bias;
      state[t + 3] = state[t + 3]! - y * bias;
      const opposite = 1 - bias;
      state[s + 2] = state[s + 2]! + x * opposite;
      state[s + 3] = state[s + 3]! + y * opposite;
    }
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!;
      node.vx = state[i * 4 + 2]!;
      node.vy = state[i * 4 + 3]!;
    }
  }
  force.initialize = (next: GNode[], randomSource: () => number) => {
    nodes = next;
    random = randomSource;
    state = new Float64Array(nodes.length * 4);
    const indices = new Map(nodes.map((node, i) => [node.id, i]));
    const degree = new Uint32Array(nodes.length);
    const endpoint = (value: string | GNode) => {
      const id = typeof value === 'string' ? value : value.id;
      const index = indices.get(id);
      if (index === undefined) throw new Error(`node not found: ${id}`);
      return index;
    };
    for (let i = 0; i < edges.length; i++) {
      const edge = edges[i]!;
      const s = endpoint(edge.source);
      const t = endpoint(edge.target);
      source[i] = s * 4;
      target[i] = t * 4;
      degree[s] = degree[s]! + 1;
      degree[t] = degree[t]! + 1;
      distances[i] = edge.dist;
    }
    for (let i = 0; i < edges.length; i++) {
      const s = degree[source[i]! / 4]!;
      const t = degree[target[i]! / 4]!;
      biases[i] = s / (s + t);
      strengths[i] = edges[i]!.strength ?? 1 / Math.min(s, t);
    }
  };
  return force;
}
