import { join } from 'node:path';
import { ClientStateStore } from '@weq/service/client-state';

const stores = new Map<string, ClientStateStore>();

export function clientStateStore(root: string, scope: string): ClientStateStore {
  const path =
    scope === 'global'
      ? join(root, 'client-state', 'global.json')
      : join(root, 'config', 'accounts', scope, 'client-state.json');
  let state = stores.get(path);
  if (!state) {
    state = new ClientStateStore(path);
    stores.set(path, state);
  }
  return state;
}
