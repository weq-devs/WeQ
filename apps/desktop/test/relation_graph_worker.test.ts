// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGraphSimulation } from '../src/renderer/src/components/relationGraph/graphLayout';
import {
  createGraphSimulationClient,
  type GraphSimulationWorker,
} from '../src/renderer/src/components/relationGraph/graphSimulationClient';
import {
  GRAPH_POSITION_STRIDE,
  type GraphSimulationCommand,
  type GraphSimulationEvent,
} from '../src/renderer/src/components/relationGraph/graphSimulationProtocol';
import { createGraphSimulationRuntime } from '../src/renderer/src/components/relationGraph/graphSimulationRuntime';
import type { BuiltGraph } from '../src/renderer/src/components/relationGraph/types';

vi.mock('../src/renderer/src/components/relationGraph/graphLayout', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../src/renderer/src/components/relationGraph/graphLayout')
    >();
  return {
    ...actual,
    createGraphSimulation: vi.fn((...args: Parameters<typeof actual.createGraphSimulation>) => {
      const sim = actual.createGraphSimulation(...args).stop();
      vi.spyOn(sim, 'restart').mockReturnValue(sim);
      return sim;
    }),
  };
});

function fixture(): BuiltGraph {
  return {
    nodes: Array.from({ length: 5 }, (_, i) => ({
      id: `node-${i}`,
      kind: 'person',
      label: `成员 ${i}`,
      avatarUrl: null,
      community: i % 2,
      weight: 1,
      radius: 14,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      fx: null,
      fy: null,
    })),
    edges: [
      { source: 'node-0', target: 'node-1', weight: 2, dist: 100 },
      { source: 'node-1', target: 'node-2', weight: 3, dist: 80, strength: 0.18 },
    ],
    communityCount: 2,
  };
}
const simulation = () => vi.mocked(createGraphSimulation).mock.results.at(-1)!.value;
function advance(ticks: number) {
  const sim = simulation();
  sim.tick(ticks);
  sim.on('tick')!.call(sim);
}
const coordinates = (graph: BuiltGraph) =>
  graph.nodes.flatMap((node) => [node.x, node.y, node.vx, node.vy]);

class WorkerStub implements GraphSimulationWorker {
  onmessage: GraphSimulationWorker['onmessage'] = null;
  onerror: GraphSimulationWorker['onerror'] = null;
  onmessageerror: GraphSimulationWorker['onmessageerror'] = null;
  commands: GraphSimulationCommand[] = [];
  terminate = vi.fn();
  postMessage(command: GraphSimulationCommand, transfer: ArrayBuffer[] = []) {
    this.commands.push(structuredClone(command, { transfer }));
  }
  emit(event: GraphSimulationEvent) {
    this.onmessage?.({ data: event } as MessageEvent<GraphSimulationEvent>);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('群交集 Worker 物理核心', () => {
  it('初始占位、位置继承及完整边集的轨迹与原模拟一致', () => {
    const graph = fixture();
    const previous = [{ id: 'node-0', x: 350, y: -120, vx: 2, vy: -1 }];
    const events: GraphSimulationEvent[] = [];
    const runtime = createGraphSimulationRuntime((event, transfer) => {
      events.push(structuredClone(event, { transfer }));
    });
    runtime.receive({ type: 'init', graph, previous });
    const workerSim = simulation();
    const initial = events.shift()!;
    expect(initial.type).toBe('frame');
    if (initial.type !== 'frame') throw new Error('缺少初始帧');
    expect([...new Float64Array(initial.buffer)]).toEqual(coordinates(graph));
    expect(graph.nodes[0]).toMatchObject(previous[0]);
    workerSim.tick(80);
    workerSim.on('tick')!.call(workerSim);
    expect(events).toHaveLength(0);
    runtime.receive({ type: 'recycle', buffer: initial.buffer });
    const frame = events.shift()!;
    if (frame.type !== 'frame') throw new Error('缺少坐标帧');
    const reference = fixture();
    createGraphSimulation(reference, previous).tick(80);
    expect([...new Float64Array(frame.buffer)]).toEqual(coordinates(reference));
    expect(graph.edges).toHaveLength(reference.edges.length);
    runtime.stop();
  });

  it('慢消费不堆帧，回收后补最新坐标及最终结束状态', () => {
    const frames: GraphSimulationEvent[] = [];
    const runtime = createGraphSimulationRuntime((event) => frames.push(event));
    const graph = fixture();
    runtime.receive({ type: 'init', graph, previous: [] });
    for (let i = 0; i < 10; i++) advance(1);
    const sim = simulation();
    sim.on('end')!.call(sim);
    expect(frames).toHaveLength(1);
    const initial = frames[0];
    if (initial.type !== 'frame') throw new Error('缺少初始帧');
    runtime.receive({ type: 'recycle', buffer: initial.buffer });
    expect(frames).toHaveLength(2);
    const final = frames[1];
    expect(final).toMatchObject({ type: 'frame', ended: true });
    if (final.type !== 'frame') throw new Error('缺少结束帧');
    expect([...new Float64Array(final.buffer)]).toEqual(coordinates(graph));
    runtime.receive({ type: 'recycle', buffer: final.buffer });
    expect(frames).toHaveLength(2);
    runtime.stop();
  });

  it('按原参数加热拖动与释放，并把命令版本带回坐标帧', () => {
    const frames: GraphSimulationEvent[] = [];
    const runtime = createGraphSimulationRuntime((event) => frames.push(event));
    const graph = fixture();
    runtime.receive({ type: 'init', graph, previous: [] });
    const initial = frames[0];
    if (initial.type !== 'frame') throw new Error('缺少初始帧');
    runtime.receive({ type: 'pin', id: 'node-0', x: 120, y: 80, revision: 1 });
    expect(simulation().alphaTarget()).toBe(0.3);
    expect(simulation().restart).toHaveBeenCalledOnce();
    advance(1);
    runtime.receive({ type: 'recycle', buffer: initial.buffer });
    expect(frames[1]).toMatchObject({ type: 'frame', revision: 1, ended: false });
    expect(graph.nodes[0]).toMatchObject({ x: 120, y: 80, fx: 120, fy: 80 });
    runtime.receive({ type: 'release', id: 'node-0', revision: 2 });
    expect(simulation().alphaTarget()).toBe(0);
    expect(graph.nodes[0]).toMatchObject({ fx: null, fy: null });
    const stop = vi.spyOn(simulation(), 'stop');
    runtime.stop();
    expect(stop).toHaveBeenCalledOnce();
  });

  it('指针移动后未发生 tick 就释放，最终位置也不回跳', () => {
    const graph = fixture();
    const runtime = createGraphSimulationRuntime(() => {});
    runtime.receive({ type: 'init', graph, previous: [] });
    runtime.receive({ type: 'pin', id: 'node-0', x: 120, y: 80, revision: 1 });
    runtime.receive({ type: 'release', id: 'node-0', revision: 2 });
    expect(graph.nodes[0]).toMatchObject({ x: 120, y: 80, vx: 0, vy: 0, fx: null, fy: null });
    runtime.stop();
  });
});

describe('群交集 Worker 渲染桥接', () => {
  it('主线程不创建模拟，仅接收坐标；缓冲真正转移回 Worker', () => {
    const worker = new WorkerStub();
    const graph = fixture();
    const onFrame = vi.fn();
    const client = createGraphSimulationClient(graph, [], onFrame, vi.fn(), () => worker);
    expect(createGraphSimulation).not.toHaveBeenCalled();
    expect(worker.commands[0]).toMatchObject({ type: 'init', graph });
    expect(client.nodes()).toEqual([]);
    const positions = Float64Array.from(
      { length: graph.nodes.length * GRAPH_POSITION_STRIDE },
      (_, i) => i,
    );
    worker.emit({ type: 'frame', buffer: positions.buffer, revision: 0, ended: false });
    expect(positions.byteLength).toBe(0);
    expect(onFrame).toHaveBeenCalledWith(false);
    expect(client.nodes()[1]).toMatchObject({ x: 4, y: 5, vx: 6, vy: 7 });
    expect(worker.commands.at(-1)?.type).toBe('recycle');
    client.stop();
  });

  it('旧帧不覆盖当前指针和释放位置，其他节点仍持续运动', () => {
    const worker = new WorkerStub();
    const graph = fixture();
    const onFrame = vi.fn();
    const client = createGraphSimulationClient(graph, [], onFrame, vi.fn(), () => worker);
    const emit = (revision: number, value = 0) =>
      worker.emit({
        type: 'frame',
        revision,
        ended: false,
        buffer: new Float64Array(graph.nodes.length * GRAPH_POSITION_STRIDE).fill(value).buffer,
      });
    emit(0);
    client.pin('node-0', 120, 80);
    expect(graph.nodes[0]).toMatchObject({ x: 120, y: 80, fx: 120, fy: 80 });
    emit(0, 7);
    expect(graph.nodes[0].x).toBe(120);
    expect(graph.nodes[1].x).toBe(7);
    expect(onFrame).toHaveBeenCalledTimes(2);
    emit(1);
    expect(graph.nodes[0].x).toBe(120);
    client.release('node-0');
    emit(1, 9);
    expect(graph.nodes[0].x).toBe(120);
    expect(graph.nodes[1].x).toBe(9);
    expect(onFrame).toHaveBeenCalledTimes(4);
    emit(2);
    expect(graph.nodes[0]).toMatchObject({ x: 0, y: 0, fx: null, fy: null });
    expect(onFrame).toHaveBeenCalledTimes(5);
    client.stop();
  });

  it('切图或卸载终止旧线程，已排队的回调也不能写回', () => {
    const worker = new WorkerStub();
    const graph = fixture();
    const onFrame = vi.fn();
    const client = createGraphSimulationClient(graph, [], onFrame, vi.fn(), () => worker);
    const callback = worker.onmessage!;
    client.pin('node-0', 9, 8);
    client.stop();
    client.stop();
    callback({
      data: {
        type: 'frame',
        revision: 1,
        ended: true,
        buffer: new ArrayBuffer(graph.nodes.length * GRAPH_POSITION_STRIDE * 8),
      },
    } as MessageEvent<GraphSimulationEvent>);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(worker.onmessage).toBeNull();
    expect(graph.nodes[0]).toMatchObject({ x: 9, y: 8, fx: null, fy: null });
    expect(onFrame).not.toHaveBeenCalled();
  });

  it.each(['startup', 'runtime', 'decode', 'post', 'length'])(
    '%s 失败可报告并终止，不回退主线程物理计算',
    (failure) => {
      const worker = new WorkerStub();
      const onError = vi.fn();
      if (failure === 'post')
        vi.spyOn(worker, 'postMessage').mockImplementation(() => {
          throw new Error('post');
        });
      createGraphSimulationClient(fixture(), [], vi.fn(), onError, () => {
        if (failure === 'startup') throw new Error('startup');
        return worker;
      });
      if (failure === 'runtime') worker.emit({ type: 'error', message: 'runtime' });
      if (failure === 'decode') worker.onmessageerror?.(new MessageEvent('messageerror'));
      if (failure === 'length')
        worker.emit({ type: 'frame', buffer: new ArrayBuffer(0), revision: 0, ended: false });
      expect(onError).toHaveBeenCalledOnce();
      expect(createGraphSimulation).not.toHaveBeenCalled();
      if (failure !== 'startup') expect(worker.terminate).toHaveBeenCalledOnce();
    },
  );
});
