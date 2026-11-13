import {
  networkCost,
  UNKNOWN_NETWORK,
  dataSaverEnabled,
  type NetworkCost,
} from '@weq/service/data-saver';
import { getAppContext } from './context/app_context';
import { updateTransferPolicy } from '@weq/service/transfer-policy';
import { transferActivity, type TransferActivity } from '@weq/service/managed-download';
import { backgroundTasks } from './background_tasks';
import { onSettingsChanged } from '@weq/service/settings-changes';

let last: NetworkCost = UNKNOWN_NETWORK;
let checked = 0;
let pending: Promise<NetworkCost> | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
export async function refreshTransferPolicy() {
  startTransferPolicy();
  const cost = await hostNetworkCost();
  const preferences = getAppContext().bootstrap?.userConfig.getSharedPreference?.('client') ?? {};
  updateTransferPolicy(preferences.dataSaverMode ?? 'auto', cost, preferences);
  return cost;
}
export function startTransferPolicy() {
  if (!timer) {
    onSettingsChanged(() => {
      void refreshTransferPolicy().catch(() => undefined);
    });
    const ids = new Map<string, string>();
    transferActivity.on('state', (state: TransferActivity) => {
      let id = ids.get(state.id);
      if (!id) {
        id = backgroundTasks.start({ kind: 'resource', name: state.name });
        ids.set(state.id, id);
      }
      if (state.done || state.error) {
        backgroundTasks.resume(id);
        backgroundTasks.finish(id, state.error ? 'failed' : 'completed', { note: state.error });
        backgroundTasks.setActions(id, []);
        ids.delete(state.id);
      } else if (state.paused) {
        backgroundTasks.finish(id, 'paused', {
          statusLabel: state.reasons.includes('user') ? '已暂停' : '省流量模式已暂停',
        });
        backgroundTasks.setActions(id, [
          { id: 'continue', label: '继续下载', run: () => state.transfer.continue() },
        ]);
      } else {
        backgroundTasks.resume(id);
        backgroundTasks.update(id, {
          progress: state.total ? (state.received / state.total) * 100 : undefined,
        });
        backgroundTasks.setActions(id, [
          { id: 'pause', label: '暂停', run: () => state.transfer.pause() },
        ]);
      }
    });
    timer = setInterval(() => void refreshTransferPolicy().catch(() => undefined), 5000);
    timer.unref();
  }
}
export function hostNetworkCost(): Promise<NetworkCost> {
  if (pending) return pending;
  if (Date.now() - checked < 5000) return Promise.resolve(last);
  pending = (async () => {
    try {
      const read = getAppContext().platform?.native.ntHelper.getNetworkCost;
      const value = await read?.();
      last = value?.known
        ? networkCost(value.constrained, value.metered, value.source)
        : UNKNOWN_NETWORK;
    } catch {
      last = UNKNOWN_NETWORK;
    }
    checked = Date.now();
    return last;
  })().finally(() => {
    pending = undefined;
  });
  return pending;
}
export async function hostDataSaver(): Promise<boolean> {
  try {
    const mode =
      getAppContext().bootstrap?.userConfig.getSharedPreference?.('client')?.dataSaverMode ??
      'auto';
    // 媒体命中不能排队等系统探测，实时状态由独立轮询更新。
    void hostNetworkCost();
    return dataSaverEnabled(mode, last);
  } catch {
    return false;
  }
}
