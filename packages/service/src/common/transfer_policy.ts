import {
  dataSaverEnabled,
  UNKNOWN_NETWORK,
  type DataSaverMode,
  type NetworkCost,
  type DataSaverBehavior,
} from './data_saver';
import { networkScope, setBackgroundNetworkRestriction } from './network_scope';

let mode: DataSaverMode = 'auto';
let host: NetworkCost = UNKNOWN_NETWORK;
let hostAwaitingClear = false;
const clients = new Map<string, { cost: NetworkCost; at: number }>();
const listeners = new Set<() => void>();
export function updateTransferPolicy(
  nextMode: DataSaverMode,
  nextHost: NetworkCost,
  behavior: Partial<DataSaverBehavior> = {},
) {
  mode = nextMode;
  host = nextHost;
  if (host.state !== 'unknown') hostAwaitingClear = host.state === 'restricted';
  setBackgroundNetworkRestriction(dataSaverEnabled(mode, host), behavior);
  for (const listener of listeners) listener();
}
export function updateClientNetwork(clientId: string, cost: NetworkCost) {
  if (!/^[\w-]{1,80}$/.test(clientId)) return;
  clients.set(clientId, { cost, at: Date.now() });
  // 活跃任务自己持有身份；断开的端不被误报为已恢复。
  if (clients.size > 256) {
    const oldest = [...clients].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) clients.delete(oldest[0]);
  }
  for (const listener of listeners) listener();
}
export function transferRestricted(clientId?: string) {
  return dataSaverEnabled(mode, host, clients.get(clientId ?? '')?.cost ?? UNKNOWN_NETWORK);
}
export function transferOwner() {
  return networkScope.getStore()?.clientId;
}
export function transferCanResume(clientId?: string): boolean {
  if (mode === 'never') return true;
  if (mode === 'always' || hostAwaitingClear) return false;
  return !clientId || clients.get(clientId)?.cost.state === 'unrestricted';
}
export function watchTransferPolicy(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
