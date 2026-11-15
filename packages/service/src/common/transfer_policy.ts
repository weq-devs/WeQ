import {
  UNKNOWN_NETWORK,
  type DataSaverMode,
  type NetworkCost,
  type DataSaverBehavior,
  DataSaverSession,
} from './data_saver';
import { networkScope, setBackgroundNetworkRestriction } from './network_scope';

let mode: DataSaverMode = 'auto';
let host: NetworkCost = UNKNOWN_NETWORK;
let hostAwaitingClear = false;
let behavior: Partial<DataSaverBehavior> = {};
export const dataSaverSession = new DataSaverSession();
const clients = new Map<string, { cost: NetworkCost; at: number }>();
const listeners = new Set<() => void>();
export function updateTransferPolicy(
  nextMode: DataSaverMode,
  nextHost: NetworkCost,
  nextBehavior: Partial<DataSaverBehavior> = {},
) {
  mode = nextMode;
  if (nextHost.state !== 'unknown' || host.state === 'unknown') host = nextHost;
  behavior = nextBehavior;
  if (host.state !== 'unknown') hostAwaitingClear = host.state === 'restricted';
  dataSaverSession.update(mode, host);
  notifyPolicy();
}
function notifyPolicy() {
  setBackgroundNetworkRestriction(dataSaverSession.status().enabled, behavior);
  for (const listener of listeners) listener();
}
dataSaverSession.subscribe(notifyPolicy);
export function updateClientNetwork(clientId: string, cost: NetworkCost) {
  if (!/^[\w-]{1,80}$/.test(clientId)) return;
  const previous = clients.get(clientId)?.cost;
  if (cost.state === 'unknown' && previous && previous.state !== 'unknown') cost = previous;
  clients.set(clientId, { cost, at: Date.now() });
  dataSaverSession.updateClient(clientId, cost);
  // 活跃任务自己持有身份；断开的端不被误报为已恢复。
  if (clients.size > 256) {
    const oldest = [...clients].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) clients.delete(oldest[0]);
  }
  for (const listener of listeners) listener();
}
export function transferRestricted(clientId?: string) {
  return dataSaverSession.status(clientId).enabled;
}
export function transferOwner() {
  return networkScope.getStore()?.clientId;
}
export function transferCanResume(clientId?: string): boolean {
  const effectiveMode = dataSaverSession.status(clientId).effectiveMode;
  if (effectiveMode === 'never') return true;
  if (effectiveMode === 'always' || hostAwaitingClear) return false;
  return !clientId || clients.get(clientId)?.cost.state === 'unrestricted';
}
export function watchTransferPolicy(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
