import { applyWeqClientSettings, WEQ_CLIENT_RESTORE_RECEIPT } from '@weq/service/backup-client';
import type { WeqRestoreResult } from '@weq/service';
import type { ToastDurations } from '@weq/service/toast-settings';

export const BACKUP_CLIENT_ID_KEY = 'weq.backup-client-id';
export interface BackupStartupState {
  ok: boolean;
  error: string | null;
  result: WeqRestoreResult | null;
  appliedThisStartup: boolean;
  client: { id: string; values: Record<string, string>; clientId?: string } | null;
  canReveal: boolean;
  canRestart: boolean;
  toastDurations?: ToastDurations;
}
export function backupClientId(storage: Storage): string {
  const previous = storage.getItem(BACKUP_CLIENT_ID_KEY);
  if (previous && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(previous))
    return previous;
  const id = crypto.randomUUID();
  storage.setItem(BACKUP_CLIENT_ID_KEY, id);
  return id;
}

/** 先持久化偏好与本机回执，再确认服务端；确认重试不覆盖后续新修改。 */
export async function restoreBackupClient(
  api: {
    read: (clientId?: string) => Promise<BackupStartupState>;
    acknowledge: (id: string, clientId: string) => Promise<boolean>;
  },
  source: Storage | (() => Storage),
): Promise<BackupStartupState> {
  let state = await api.read();
  if (!state.ok || !state.result?.clientPending) return state;
  const storage = typeof source === 'function' ? source() : source;
  const clientId = backupClientId(storage);
  state = await api.read(clientId);
  const pending = state.client;
  if (!state.ok || !pending) return state;
  if (storage.getItem(WEQ_CLIENT_RESTORE_RECEIPT) !== pending.id)
    applyWeqClientSettings(storage, pending.values, true, pending.id);
  if (!(await api.acknowledge(pending.id, clientId)))
    throw new Error('界面偏好已应用，但恢复回执未确认，请重试读取。');
  return {
    ...state,
    client: null,
    result: state.result ? { ...state.result, clientPending: false } : null,
  };
}

let serial: Promise<unknown> = Promise.resolve();
export async function serializeBackupClient<T>(run: () => Promise<T>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.locks)
    return await navigator.locks.request('weq-client-backup-restore', run);
  const next = serial.catch(() => {}).then(run);
  serial = next;
  return next;
}
