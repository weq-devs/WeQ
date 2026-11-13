import type { Simulation } from 'd3';
import { createGraphSimulation } from '../../src/renderer/src/components/relationGraph/graphLayout';
import type { BuiltGraph, GNode } from '../../src/renderer/src/components/relationGraph/types';

export const PHYSICS_FORCES = ['link', 'charge', 'collide', 'center'] as const;
export type PhysicsForce = (typeof PHYSICS_FORCES)[number];
export type PhysicsShape = 'star' | 'clusters' | 'complete';
export interface PhysicsSample extends Record<PhysicsForce, number> {
  tick: number;
  remainder: number;
}

/** 原力已完成初始化；包装器不重新初始化，避免改变随机源和轨迹。 */
export function instrumentPhysics(
  simulation: Simulation<GNode, undefined>,
  now = () => performance.now(),
) {
  let current: PhysicsSample | undefined;
  for (const name of PHYSICS_FORCES) {
    const force = simulation.force(name);
    if (!force) throw new Error(`缺少物理力：${name}`);
    simulation.force(name, (alpha) => {
      const start = now();
      force(alpha);
      if (current) current[name] += now() - start;
    });
  }
  return () => {
    current = { link: 0, charge: 0, collide: 0, center: 0, tick: 0, remainder: 0 };
    const start = now();
    simulation.tick();
    current.tick = now() - start;
    current.remainder =
      current.tick - PHYSICS_FORCES.reduce((sum, name) => sum + current![name], 0);
    const sample = current;
    current = undefined;
    return sample;
  };
}

export function distribution(values: number[]) {
  if (!values.length) throw new Error('没有耗时样本');
  const sorted = values.toSorted((a, b) => a - b);
  const sum = values.reduce((total, value) => total + value, 0);
  return {
    count: values.length,
    totalMs: sum,
    meanMs: sum / values.length,
    medianMs: sorted[Math.floor(sorted.length / 2)]!,
    p95Ms: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!,
    maxMs: sorted.at(-1)!,
  };
}

export function summarizePhysics(samples: PhysicsSample[]) {
  return Object.fromEntries(
    [...PHYSICS_FORCES, 'tick', 'remainder'].map((name) => [
      name,
      distribution(samples.map((sample) => sample[name as keyof PhysicsSample])),
    ]),
  );
}

/** 同步 tick 测求解调用；不包含计时器等待、绘制、消息或夹具构图。 */
export function profilePhysics(graph: BuiltGraph) {
  const start = performance.now();
  const sim = createGraphSimulation(graph).stop();
  const initializationMs = performance.now() - start;
  const tick = instrumentPhysics(sim);
  const phases: Record<string, PhysicsSample[]> = {
    initial: [],
    settle: [],
    drag: [],
    release: [],
  };
  let ticks = 0;
  while (sim.alpha() >= sim.alphaMin() && ticks < 1000) {
    phases[ticks < 30 ? 'initial' : 'settle']!.push(tick());
    ticks++;
  }
  if (sim.alpha() >= sim.alphaMin()) throw new Error('初始布局未正常冷却');
  const cooledAlpha = sim.alpha();
  const node = graph.nodes.find((item) => item.kind !== 'self')!;
  const origin = { x: node.x, y: node.y };
  sim.alphaTarget(0.3);
  for (let i = 0; i < 60; i++) {
    node.fx = origin.x + Math.sin(i / 10) * 80;
    node.fy = origin.y + Math.cos(i / 10) * 60;
    phases.drag!.push(tick());
  }
  node.x = node.fx!;
  node.y = node.fy!;
  node.vx = 0;
  node.vy = 0;
  node.fx = null;
  node.fy = null;
  sim.alphaTarget(0);
  ticks = 0;
  while (sim.alpha() >= sim.alphaMin() && ticks++ < 1000) phases.release!.push(tick());
  if (sim.alpha() >= sim.alphaMin()) throw new Error('拖动释放后未正常冷却');
  sim.stop();
  return {
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    initializationMs,
    cooledAlpha,
    finalAlpha: sim.alpha(),
    finite: graph.nodes.every((item) => [item.x, item.y, item.vx, item.vy].every(Number.isFinite)),
    phases: Object.fromEntries(
      Object.entries(phases).map(([name, samples]) => [name, summarizePhysics(samples)]),
    ),
  };
}
