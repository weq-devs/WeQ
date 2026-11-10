// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createGraphSimulation } from '../src/renderer/src/components/relationGraph/graphLayout';
import {
  distribution,
  instrumentPhysics,
  PHYSICS_FORCES,
  profilePhysics,
} from './support/relation-physics';
import { physicsFixture } from './support/relation-physics-fixtures';

describe('物理分项计时夹具', () => {
  it.each(['star', 'clusters', 'complete'] as const)('%s 精确边数和包装前后轨迹相同', (shape) => {
    const graph = physicsFixture(40, shape);
    const expected =
      shape === 'star' ? 40 : shape === 'clusters' ? 4 * ((10 * 9) / 2) + 40 : (40 * 39) / 2 + 40;
    expect(graph.edges).toHaveLength(expected);
    const other = structuredClone(graph);
    const actual = createGraphSimulation(graph).stop();
    const reference = createGraphSimulation(other).stop();
    const tick = instrumentPhysics(actual);
    for (let i = 0; i < 301; i++) {
      const sample = tick();
      expect(sample.tick).toBeGreaterThanOrEqual(0);
      for (const force of PHYSICS_FORCES) expect(sample[force]).toBeGreaterThanOrEqual(0);
    }
    reference.tick(301);
    const positions = (input: typeof graph) =>
      input.nodes.map(({ x, y, vx, vy }) => [x, y, vx, vy]);
    expect(positions(graph)).toEqual(positions(other));
  });

  it('初始、稳定、拖动、释放各阶段采样，积分余量不冒称独立积分计时', () => {
    const result = profilePhysics(physicsFixture(20, 'clusters'));
    expect(result.finite).toBe(true);
    expect(result.phases.initial!.tick!.count).toBe(30);
    expect(result.phases.settle!.tick!.count).toBeGreaterThan(200);
    expect(result.phases.drag!.tick!.count).toBe(60);
    expect(result.phases.release!.tick!.count).toBeGreaterThan(200);
    for (const phase of Object.values(result.phases)) {
      const sum = PHYSICS_FORCES.reduce((total, name) => total + phase[name]!.totalMs, 0);
      expect(sum + phase.remainder!.totalMs).toBeCloseTo(phase.tick!.totalMs, 8);
    }
  });

  it('统计保留均值、中位数、P95 和总量，空样本不输出伪零', () => {
    expect(distribution([4, 1, 3, 2])).toEqual({
      count: 4,
      totalMs: 10,
      meanMs: 2.5,
      medianMs: 3,
      p95Ms: 4,
      maxMs: 4,
    });
    expect(() => distribution([])).toThrow('没有耗时样本');
  });
});
