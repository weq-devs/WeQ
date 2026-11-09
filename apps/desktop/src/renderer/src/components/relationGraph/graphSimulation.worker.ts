import type { GraphSimulationCommand, GraphSimulationEvent } from './graphSimulationProtocol';
import { createGraphSimulationRuntime } from './graphSimulationRuntime';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<GraphSimulationCommand>) => void) | null;
  postMessage: (event: GraphSimulationEvent, transfer: ArrayBuffer[]) => void;
};
const runtime = createGraphSimulationRuntime((event, transfer) =>
  scope.postMessage(event, transfer),
);
scope.onmessage = ({ data }) => {
  try {
    runtime.receive(data);
  } catch (error) {
    runtime.stop();
    scope.postMessage(
      { type: 'error', message: error instanceof Error ? error.message : String(error) },
      [],
    );
  }
};
