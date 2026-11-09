import { createGraphSimulation } from './graphLayout';
import type { GNode } from './types';
import {
  GRAPH_POSITION_STRIDE,
  type GraphSimulationCommand,
  type GraphSimulationEvent,
} from './graphSimulationProtocol';

/** 仅在 Worker 中运行；回收前不再发送坐标，繁忙时只保留最新状态。 */
export function createGraphSimulationRuntime(
  send: (event: GraphSimulationEvent, transfer: ArrayBuffer[]) => void,
) {
  let simulation: ReturnType<typeof createGraphSimulation> | undefined;
  let nodes = new Map<string, GNode>();
  let buffer: ArrayBuffer | undefined;
  let revision = 0;
  let ended = false;
  let dirty = false;

  function publish() {
    if (!simulation || !buffer || !dirty) return;
    const positions = new Float64Array(buffer);
    simulation.nodes().forEach((node, i) => {
      const offset = i * GRAPH_POSITION_STRIDE;
      positions[offset] = node.x;
      positions[offset + 1] = node.y;
      positions[offset + 2] = node.vx;
      positions[offset + 3] = node.vy;
    });
    const outgoing = buffer;
    buffer = undefined;
    dirty = false;
    send({ type: 'frame', buffer: outgoing, revision, ended }, [outgoing]);
  }

  return {
    receive(command: GraphSimulationCommand) {
      if (command.type === 'init') {
        simulation?.stop();
        simulation = createGraphSimulation(command.graph, command.previous);
        nodes = new Map(simulation.nodes().map((node) => [node.id, node]));
        buffer = new ArrayBuffer(simulation.nodes().length * GRAPH_POSITION_STRIDE * 8);
        simulation.on('tick', () => {
          dirty = true;
          publish();
        });
        simulation.on('end', () => {
          ended = true;
          dirty = true;
          publish();
        });
        dirty = true;
        publish();
      } else if (command.type === 'recycle') {
        buffer = command.buffer;
        publish();
      } else {
        const node = nodes.get(command.id);
        if (!node || !simulation) return;
        revision = command.revision;
        ended = false;
        if (command.type === 'pin') {
          node.fx = command.x;
          node.fy = command.y;
          simulation.alphaTarget(0.3).restart();
        } else {
          // 最后一次指针移动可能尚未经历 tick，释放时保留最终固定位置。
          if (node.fx !== null) {
            node.x = node.fx;
            node.vx = 0;
          }
          if (node.fy !== null) {
            node.y = node.fy;
            node.vy = 0;
          }
          node.fx = null;
          node.fy = null;
          simulation.alphaTarget(0);
        }
        dirty = true;
      }
    },
    stop() {
      simulation?.stop();
      simulation = undefined;
      nodes.clear();
      buffer = undefined;
    },
  };
}
