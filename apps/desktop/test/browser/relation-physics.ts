import type { PhysicsShape } from '../support/relation-physics';
import { physicsFixture } from '../support/relation-physics-fixtures';

const worker = new Worker(new URL('./relation-physics.worker.ts', import.meta.url), {
  type: 'module',
});
let failure: string | undefined;
let pendingReject: ((reason: Error) => void) | undefined;
worker.onerror = (event) => {
  failure = event.message;
  pendingReject?.(new Error(failure));
};
Object.assign(window, {
  runPhysicsProfile(count: number, shape: PhysicsShape, hot = false) {
    const graph = physicsFixture(count, shape, hot);
    return new Promise((resolve, reject) => {
      if (failure) {
        reject(new Error(failure));
        return;
      }
      pendingReject = reject;
      const timeout = setTimeout(() => reject(new Error('物理计时超过 60 秒')), 60000);
      worker.onmessage = ({ data }) => {
        clearTimeout(timeout);
        pendingReject = undefined;
        data.error ? reject(new Error(data.error)) : resolve(data.result);
      };
      worker.postMessage({ graph });
    });
  },
});
window.addEventListener('pagehide', () => worker.terminate(), { once: true });
