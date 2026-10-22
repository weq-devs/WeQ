import { beforeEach, expect, it, vi } from 'vitest';
import { Storage } from 'happy-dom';
import { WEQ_CLIENT_RESTORE_RECEIPT } from '@weq/service/backup-client';
import {
  backupClientId,
  BACKUP_CLIENT_ID_KEY,
  restoreBackupClient,
  type BackupStartupState,
} from '../src/renderer/src/lib/backupClientRestore';

const localStorage = new Storage();
beforeEach(() => localStorage.clear());
it('损坏的设备标识重新分配，不将仅长度相同的内容送入 UUID 路由', () => {
  localStorage.setItem(BACKUP_CLIENT_ID_KEY, '-'.repeat(36));
  const id = backupClientId(localStorage);
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  expect(backupClientId(localStorage)).toBe(id);
});
function fixture() {
  const clientId = backupClientId(localStorage);
  const state: BackupStartupState = {
    ok: true,
    error: null,
    appliedThisStartup: true,
    canReveal: false,
    canRestart: false,
    result: {
      id: '11111111-1111-4111-8111-111111111111',
      status: 'applied',
      completedAt: new Date(0).toISOString(),
      applied: [],
      skipped: [],
      warnings: [],
      clientPending: true,
    },
    client: {
      id: '11111111-1111-4111-8111-111111111111',
      values: { 'weq.theme-preference': 'dark' },
      clientId,
    },
  };
  return {
    state,
    api: {
      read: vi.fn(async (id?: string) => ({
        ...state,
        client: id === clientId ? state.client : null,
      })),
      acknowledge: vi.fn(async () => true),
    },
  };
}
it('无待恢复界面数据时不读取被浏览器禁用的 localStorage', async () => {
  const f = fixture();
  f.state.result = null;
  f.state.client = null;
  const storage = vi.fn((): Storage => {
    throw Error('blocked');
  });
  await expect(restoreBackupClient(f.api, storage)).resolves.toMatchObject({ ok: true });
  expect(storage).not.toHaveBeenCalled();
});
it('确认失败可重试，已提交的界面偏好不覆盖用户后来的修改', async () => {
  const f = fixture();
  f.api.acknowledge.mockResolvedValueOnce(false);
  await expect(restoreBackupClient(f.api, localStorage)).rejects.toThrow('回执未确认');
  expect(localStorage.getItem(WEQ_CLIENT_RESTORE_RECEIPT)).toBe(f.state.client?.id);
  expect(localStorage.getItem('weq.theme-preference')).toBe('dark');
  localStorage.setItem('weq.theme-preference', 'light');
  await expect(restoreBackupClient(f.api, localStorage)).resolves.toMatchObject({
    result: { clientPending: false },
  });
  expect(localStorage.getItem('weq.theme-preference')).toBe('light');
});
it('另一设备的恢复不会写入当前界面，也不确认别人的回执', async () => {
  const f = fixture();
  f.api.read.mockImplementation(async () => ({ ...f.state, client: null }));
  await restoreBackupClient(f.api, localStorage);
  expect(f.api.acknowledge).not.toHaveBeenCalled();
  expect(localStorage.getItem('weq.theme-preference')).toBeNull();
});
