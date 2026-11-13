import type { GraphPosition } from './graphLayout';
import {
  GRAPH_POSITION_STRIDE,
  type GraphSimulationCommand,
  type GraphSimulationEvent,
} from './graphSimulationProtocol';
import type { BuiltGraph } from './types';

export interface GraphSimulationWorker {
  onmessage: ((event: MessageEvent<GraphSimulationEvent>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
  postMessage: (command: GraphSimulationCommand, transfer: ArrayBuffer[]) => void;
  terminate: () => void;
}

export function createGraphSimulationClient(
  graph: BuiltGraph,
  previous: GraphPosition[],
  onFrame: (ended: boolean) => void,
  onError: (message: string) => void,
  factory: () => GraphSimulationWorker = () =>
    new Worker(new URL('./graphSimulation.worker.ts', import.meta.url), { type: 'module' }),
) {
  let worker: GraphSimulationWorker | undefined;
  let stopped = false;
  let ready = false;
  let revision = 0;
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const releasedAt = new Map<string, number>();

  function stop() {
    if (stopped) return;
    stopped = true;
    for (const node of graph.nodes) {
      node.fx = null;
      node.fy = null;
    }
    if (!worker) return;
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    worker.terminate();
  }
  function fail(message: string) {
    if (stopped) return;
    stop();
    onError(message);
  }
  function send(command: GraphSimulationCommand, transfer?: ArrayBuffer[]) {
    if (stopped) return;
    try {
      worker?.postMessage(command, transfer ?? []);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  try {
    worker = factory();
    worker.onmessage = ({ data }) => {
      if (stopped) return;
      if (data.type === 'error') {
        fail(data.message);
        return;
      }
      if (data.buffer.byteLength !== graph.nodes.length * GRAPH_POSITION_STRIDE * 8) {
        fail('布局坐标数量不匹配');
        return;
      }
      const positions = new Float64Array(data.buffer);
      graph.nodes.forEach((node, i) => {
        // 释放前的拖动帧不回写该节点；其他节点继续运动，不因输入较快而整图停帧。
        const release = releasedAt.get(node.id);
        if (release !== undefined && data.revision < release) return;
        releasedAt.delete(node.id);
        const offset = i * GRAPH_POSITION_STRIDE;
        node.x = node.fx ?? positions[offset]!;
        node.y = node.fy ?? positions[offset + 1]!;
        node.vx = positions[offset + 2]!;
        node.vy = positions[offset + 3]!;
      });
      ready = true;
      onFrame(data.ended && data.revision === revision);
      send({ type: 'recycle', buffer: data.buffer }, [data.buffer]);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      fail(event.message || '布局线程启动失败');
    };
    worker.onmessageerror = () => fail('布局线程消息读取失败');
    send({ type: 'init', graph, previous });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  return {
    nodes: () => (ready ? graph.nodes : []),
    pin(id: string, x: number, y: number) {
      const node = nodes.get(id);
      if (!node || stopped) return;
      node.fx = x;
      node.fy = y;
      node.x = x;
      node.y = y;
      send({ type: 'pin', id, x, y, revision: ++revision });
    },
    release(id: string) {
      const node = nodes.get(id);
      if (!node || stopped) return;
      node.fx = null;
      node.fy = null;
      releasedAt.set(id, ++revision);
      send({ type: 'release', id, revision });
    },
    stop,
  };
}
