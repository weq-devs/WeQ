import { profilePhysics } from '../support/relation-physics';
import type { BuiltGraph } from '../../src/renderer/src/components/relationGraph/types';

self.onmessage = ({ data }: MessageEvent<{ graph: BuiltGraph }>) => {
  try {
    const result = profilePhysics(data.graph);
    self.postMessage({ result });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
