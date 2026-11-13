import { create } from 'zustand';
import {
  dataSaverEnabled,
  networkCost,
  UNKNOWN_NETWORK,
  type NetworkCost,
  dataSaverBehaviorDefaults,
  type DataSaverBehavior,
} from '@weq/service/data-saver';
import { preferenceValue, PREFERENCES_CHANGED, useClientPreferences } from './clientPreferences';
import { IS_WEB } from './target';

type Connection = EventTarget & { saveData?: boolean };
type NetworkWindow = Window & {
  weqRemoteNetworkCost?: NetworkCost;
  weqRemoteLinks?: { networkCost?: () => string; networkPreference?: (mode: string) => void };
  webkit?: { messageHandlers?: { weqShell?: { postMessage: (value: unknown) => void } } };
};
export const useDataSaver = create(() => ({
  enabled: preferenceValue('dataSaverMode') === 'always',
  host: UNKNOWN_NETWORK,
  local: UNKNOWN_NETWORK,
  behavior: { ...dataSaverBehaviorDefaults },
}));
export const networkClientId = (() => {
  try {
    const saved = localStorage.getItem('weq.network-client-id');
    if (saved && /^[\w-]{1,80}$/.test(saved)) return saved;
    const id = globalThis.crypto.randomUUID();
    localStorage.setItem('weq.network-client-id', id);
    return id;
  } catch {
    return globalThis.crypto.randomUUID();
  }
})();
function localNetwork(): NetworkCost {
  let native = (window as NetworkWindow).weqRemoteNetworkCost;
  try {
    const read = (window as NetworkWindow).weqRemoteLinks?.networkCost;
    if (read) native = JSON.parse(read());
  } catch {
    /* 旧壳或不可用桥继续使用浏览器信号。 */
  }
  if (
    native &&
    ['restricted', 'unrestricted', 'unknown'].includes(native.state) &&
    typeof native.constrained === 'boolean' &&
    typeof native.metered === 'boolean'
  )
    return native;
  const connection = (navigator as Navigator & { connection?: Connection }).connection;
  return typeof connection?.saveData === 'boolean'
    ? connection.saveData
      ? networkCost(true, false, 'browser')
      : { ...UNKNOWN_NETWORK, source: 'browser' }
    : UNKNOWN_NETWORK;
}
function refresh() {
  const host = useDataSaver.getState().host;
  const local = IS_WEB ? localNetwork() : host;
  const previous = useDataSaver.getState().behavior;
  const next = Object.fromEntries(
    Object.keys(dataSaverBehaviorDefaults).map((key) => [
      key,
      preferenceValue(key as keyof DataSaverBehavior),
    ]),
  ) as DataSaverBehavior;
  const behavior = (Object.keys(next) as Array<keyof DataSaverBehavior>).every(
    (key) => next[key] === previous[key],
  )
    ? previous
    : next;
  useDataSaver.setState({
    host,
    local,
    enabled: dataSaverEnabled(preferenceValue('dataSaverMode'), host, local),
    behavior,
  });
  if (IS_WEB && useClientPreferences.getState().ready) {
    const native = window as NetworkWindow;
    try {
      native.weqRemoteLinks?.networkPreference?.(preferenceValue('dataSaverMode'));
      native.webkit?.messageHandlers?.weqShell?.postMessage({
        dataSaverMode: preferenceValue('dataSaverMode'),
      });
    } catch {
      /* 旧壳不接收网络偏好时仍按已有能力运行。 */
    }
  }
}
export function dataSaverActive() {
  return useDataSaver.getState().enabled;
}
export function installDataSaver() {
  let closed = false;
  let busy = false;
  async function poll() {
    if (busy || closed || document.visibilityState === 'hidden') return;
    busy = true;
    try {
      const { client } = await import('../trpc/client');
      const host = await client.settings.networkCost.query(
        IS_WEB ? { clientId: networkClientId, cost: localNetwork() } : undefined,
      );
      if (!closed) {
        useDataSaver.setState({ host });
        refresh();
      }
    } catch {
      if (!closed) {
        useDataSaver.setState({ host: UNKNOWN_NETWORK });
        refresh();
      }
    } finally {
      busy = false;
    }
  }
  const connection = (navigator as Navigator & { connection?: Connection }).connection;
  const changed = () => {
    refresh();
    void poll();
  };
  window.addEventListener(PREFERENCES_CHANGED, refresh);
  window.addEventListener('weq-remote-network-cost', changed);
  window.addEventListener('online', changed);
  document.addEventListener('visibilitychange', changed);
  connection?.addEventListener('change', changed);
  refresh();
  void poll();
  const timer = setInterval(() => void poll(), 15000);
  return () => {
    closed = true;
    clearInterval(timer);
    window.removeEventListener(PREFERENCES_CHANGED, refresh);
    window.removeEventListener('weq-remote-network-cost', changed);
    window.removeEventListener('online', changed);
    document.removeEventListener('visibilitychange', changed);
    connection?.removeEventListener('change', changed);
  };
}
