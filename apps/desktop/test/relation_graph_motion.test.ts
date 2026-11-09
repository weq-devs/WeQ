// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createGraphSimulation } from '../src/renderer/src/components/relationGraph/graphLayout';
import type { BuiltGraph, GNode } from '../src/renderer/src/components/relationGraph/types';

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
