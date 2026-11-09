import type { GraphPosition } from './graphLayout';
import type { BuiltGraph } from './types';

export type GraphSimulationCommand =
  | { type: 'init'; graph: BuiltGraph; previous: GraphPosition[] }
  | { type: 'pin'; id: string; x: number; y: number; revision: number }
  | { type: 'release'; id: string; revision: number }
  | { type: 'recycle'; buffer: ArrayBuffer };

export type GraphSimulationEvent =
  | { type: 'frame'; buffer: ArrayBuffer; revision: number; ended: boolean; stepMs?: number }
  | { type: 'error'; message: string };

/** 每个节点依次保存 x、y、vx、vy，保持原模拟的双精度坐标。 */
export const GRAPH_POSITION_STRIDE = 4;
