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
      applyShared: vi.fn(async () => {}),
    },
  };
}
it('恢复默认专用回执经启动交接应用，保留会话整理与草稿且不重复清除后续设置', async () => {
  const f = fixture();
  f.state.client = { ...f.state.client!, defaults: true, values: {} };
  localStorage.setItem('weq.contacts.order.10001.10001.friends', '{}');
  localStorage.setItem('chat-template:conversation-preferences', '合成置顶');
  localStorage.setItem('draft', '合成草稿');
  await restoreBackupClient(f.api, localStorage);
  expect(localStorage.getItem('weq.contacts.order.10001.10001.friends')).toBeNull();
  expect(localStorage.getItem('chat-template:conversation-preferences')).toBe('合成置顶');
  expect(localStorage.getItem('draft')).toBe('合成草稿');
  localStorage.setItem('weq.contacts.order.10001.10001.friends', '{"sort":"qq"}');
  await restoreBackupClient(f.api, localStorage);
  expect(localStorage.getItem('weq.contacts.order.10001.10001.friends')).toBe('{"sort":"qq"}');
});
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
it('旧界面备份必须成功写入共享设置才确认，失败保留恢复意图供显式重试', async () => {
  const f = fixture();
  f.api.applyShared.mockRejectedValueOnce(new Error('offline'));
  await expect(restoreBackupClient(f.api, localStorage)).rejects.toThrow('offline');
  expect(f.api.acknowledge).not.toHaveBeenCalled();
  expect(localStorage.getItem('weq.sync.restored-shared')).not.toBeNull();
  await restoreBackupClient(f.api, localStorage);
  expect(f.api.applyShared).toHaveBeenLastCalledWith(f.state.client!.id, { preference: 'dark' });
  expect(f.api.acknowledge).toHaveBeenCalledTimes(1);
  expect(localStorage.getItem('weq.sync.restored-shared')).toBeNull();
});
it('另一设备的恢复不会写入当前界面，也不确认别人的回执', async () => {
  const f = fixture();
  f.api.read.mockImplementation(async () => ({ ...f.state, client: null }));
  await restoreBackupClient(f.api, localStorage);
  expect(f.api.acknowledge).not.toHaveBeenCalled();
  expect(localStorage.getItem('weq.theme-preference')).toBeNull();
});
