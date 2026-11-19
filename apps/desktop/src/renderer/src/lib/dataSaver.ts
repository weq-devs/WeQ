import { create } from 'zustand';
import superjson from 'superjson';
import {
  dataSaverEnabled,
  networkCost,
  UNKNOWN_NETWORK,
  type NetworkCost,
  dataSaverBehaviorDefaults,
  type DataSaverBehavior,
  type DataSaverStatus,
  type DataSaverTemporaryRequest,
} from '@weq/service/data-saver';
import { preferenceValue, PREFERENCES_CHANGED, useClientPreferences } from './clientPreferences';
import { IS_WEB } from './target.shared';
import { localBackgroundTasks } from '../state/backgroundTasks';
import { unfinishedDataSaverTasks } from '../../../shared/data_saver_tasks';
import { useToast } from '../components/Toast.shared';
import { requestOpenSettings } from './callSettingsBridge';
import { networkClientId } from './networkClientId';

export const DATA_SAVER_MENU_EVENT = 'weq:open-data-saver';
export const dataSaverModeOptions = [
  { value: 'always', label: '开启' },
  { value: 'never', label: '关闭' },
  { value: 'auto', label: '跟随系统' },
] as const;
export function openDataSaverMenu() {
  if (window.dispatchEvent(new Event(DATA_SAVER_MENU_EVENT, { cancelable: true })))
    requestOpenSettings('dataSaver');
}

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
  status: null as DataSaverStatus | null,
}));
// 同源弹窗会复制 sessionStorage；每份文档必须有独立的任务来源。
const taskWindowId = globalThis.crypto.randomUUID();
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
      : networkCost(false, false, 'browser')
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
    enabled:
      useDataSaver.getState().status?.enabled ??
      dataSaverEnabled(preferenceValue('dataSaverMode'), [host, local], next.dataSaverOnMetered),
    behavior,
  });
  if (IS_WEB && useClientPreferences.getState().ready) {
    const native = window as NetworkWindow;
    try {
      // 传实际生效结果，旧手机壳也能遵循新的计费选项及宿主网络状态。
      const mode = useDataSaver.getState().enabled ? 'always' : 'never';
      native.weqRemoteLinks?.networkPreference?.(mode);
      native.webkit?.messageHandlers?.weqShell?.postMessage({
        dataSaverMode: mode,
      });
    } catch {
      /* 旧壳不接收网络偏好时仍按已有能力运行。 */
    }
  }
}
export function applyDataSaverStatus(status: DataSaverStatus) {
  const previous = useDataSaver.getState().status;
  const sameSession = previous?.sessionId === status.sessionId;
  if (sameSession && previous && status.revision < previous.revision) return;
  useDataSaver.setState({
    status,
    host: status.host,
    local: status.local,
    enabled: status.enabled,
  });
  refresh();
  const automatic = ['initial', 'system', 'expiry', 'tasks'].includes(status.reason);
  const initial = !previous || !sameSession;
  if (
    initial
      ? status.mode === 'auto' && status.enabled && !status.temporary
      : automatic && previous.enabled !== status.enabled
  ) {
    const reason = initial
      ? status.host.constrained || status.local.constrained
        ? '跟随系统省流量设置'
        : '使用流量时自动启用'
      : status.reason === 'expiry'
        ? '临时设置已到期'
        : status.reason === 'tasks'
          ? '全部任务已结束'
          : '系统网络状态变化';
    useToast.getState().push({
      key: 'data-saver-mode',
      event: 'dataSaver',
      tone: 'info',
      title: status.enabled ? '已自动进入省流量模式' : '已自动退出省流量模式',
      detail: reason,
      action: { label: '省流量设置', run: openDataSaverMenu },
    });
  }
}
export async function refreshDataSaverStatus() {
  const { client } = await import('../trpc/client');
  const status = await client.settings.dataSaver.status.query({
    clientId: networkClientId,
    windowId: taskWindowId,
    pendingTasks: unfinishedDataSaverTasks({ background: [...localBackgroundTasks.snapshot()] }),
  });
  applyDataSaverStatus(status);
  return status;
}
export async function temporarilySetDataSaver(value: DataSaverTemporaryRequest) {
  const { client } = await import('../trpc/client');
  applyDataSaverStatus(
    await client.settings.dataSaver.temporary.mutate({ clientId: networkClientId, value }),
  );
}
export async function clearTemporaryDataSaver() {
  const { client } = await import('../trpc/client');
  applyDataSaverStatus(
    await client.settings.dataSaver.clearTemporary.mutate({ clientId: networkClientId }),
  );
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
      await client.settings.networkCost.query(
        IS_WEB ? { clientId: networkClientId, cost: localNetwork() } : undefined,
      );
      if (!closed) {
        await refreshDataSaverStatus();
      }
    } catch {
      if (!closed) {
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
  let subscription: { unsubscribe(): void } | undefined;
  void import('../trpc/client')
    .then(({ client }) => {
      if (!closed)
        subscription = client.settings.dataSaver.changed.subscribe(
          { clientId: networkClientId },
          {
            onData: (status) => {
              if (!closed) applyDataSaverStatus(status);
            },
          },
        );
    })
    .catch(() => undefined);
  let lastTaskCount = unfinishedDataSaverTasks({
    background: [...localBackgroundTasks.snapshot()],
  });
  const stopTasks = localBackgroundTasks.subscribe(() => {
    if (closed) return;
    const count = unfinishedDataSaverTasks({ background: [...localBackgroundTasks.snapshot()] });
    if (count === lastTaskCount) return;
    lastTaskCount = count;
    void refreshDataSaverStatus().catch(() => undefined);
  });
  const timer = setInterval(() => void poll(), 15000);
  const pageClosed = (event: PageTransitionEvent) => {
    if (closed || event.persisted) return;
    closed = true;
    // 明确结束页面生命周期才撤销本地任务来源；网络断开不会发送此回执。
    if (IS_WEB) {
      // 卸载时不能等动态导入或普通 RPC 请求；由浏览器继续发送同一个已认证 RPC。
      void fetch('/trpc/settings.dataSaver.windowClosed', {
        method: 'POST',
        keepalive: true,
        headers: { 'content-type': 'application/json', 'x-weq-client-id': networkClientId },
        body: JSON.stringify(superjson.serialize({ windowId: taskWindowId })),
      }).catch(() => undefined);
      return;
    }
    void import('../trpc/client')
      .then(({ client }) =>
        client.settings.dataSaver.windowClosed.mutate({ windowId: taskWindowId }),
      )
      .catch(() => undefined);
  };
  window.addEventListener('pagehide', pageClosed);
  return () => {
    closed = true;
    clearInterval(timer);
    subscription?.unsubscribe();
    stopTasks();
    window.removeEventListener('pagehide', pageClosed);
    window.removeEventListener(PREFERENCES_CHANGED, refresh);
    window.removeEventListener('weq-remote-network-cost', changed);
    window.removeEventListener('online', changed);
    document.removeEventListener('visibilitychange', changed);
    connection?.removeEventListener('change', changed);
  };
}
