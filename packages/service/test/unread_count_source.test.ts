import type { AccountSession } from '@weq/account';
import type { QqUnreadSnapshot } from '@weq/native';
import { expect, it, vi, describe } from 'vitest';
import { UnreadInfoService } from '../src/account/unread_info';
import {
  createQqUnreadCountSource,
  VERIFIED_QQ_UNREAD_LAYOUT,
  QQ_UNREAD_COVERAGE,
} from '../src/account/unread_count_source';
function memory(unreadCount = 10): QqUnreadSnapshot {
  return {
    success: true,
    code: 'ok',
    message: '',
    rows: [{ chatType: 2, uid: '70001', unreadCount }],
    missingTargets: [],
    generation: 'source',
    coverage: QQ_UNREAD_COVERAGE,
    layout: VERIFIED_QQ_UNREAD_LAYOUT,
    fromCache: true,
    locateMs: 0,
    elapsedMs: 1,
  };
}
it('内存定位、计数差异或失效均不阻塞或替换数据库角标，只供显式对照', async () => {
  const row = { chatType: 2, uid: '70001', peer: '2_70001', msgSeq: 90, latestSeq: '100' };
  const read = vi.fn(async () => memory(7));
  const clear = vi.fn();
  const service = new UnreadInfoService(
    { unreadInfo: { getAllUnreadInfos: async () => [row] } } as unknown as AccountSession,
    undefined,
    undefined,
    { identity: () => 'source', read, clear },
  );
  expect((await service.getUnreadInfos([row]))[0]?.unreadCount).toBe(10);
  expect(read).not.toHaveBeenCalled();
  expect(await service.compareQqCounts()).toMatchObject([{ unreadCount: 7, databaseCount: 10 }]);
  expect((await service.getUnreadInfos([row], true))[0]?.unreadCount).toBe(10);
  read.mockRejectedValue(new Error('offline'));
  await expect(service.compareQqCounts()).rejects.toThrow('offline');
  expect((await service.getUnreadInfos([row]))[0]?.unreadCount).toBe(10);
  await service.dispose();
  expect(clear).toHaveBeenCalledOnce();
});
describe('原生诊断适配器', () => {
  it('旧原生产物不启用读取链路', () => {
    expect(createQqUnreadCountSource({}, '/synthetic/unread.db', () => 1)).toBeUndefined();
  });

  it('正式适配器检查已验证能力，按固定账号路径读取并只清理自己用过的 PID', async () => {
    let pid: number | null = 123;
    const nt = {
      getQqUnreadCapability: () => ({
        supported: true,
        readOnly: true,
        layouts: [VERIFIED_QQ_UNREAD_LAYOUT],
        coverage: QQ_UNREAD_COVERAGE,
      }),
      readQqUnreadCounts: vi.fn(async () => memory()),
      clearQqUnreadCache: vi.fn(() => 1),
    };
    const source = createQqUnreadCountSource(nt, '/synthetic/account-a.db', () => pid);
    if (process.platform !== 'darwin' || process.arch !== 'arm64') {
      expect(source).toBeUndefined();
      expect(nt.readQqUnreadCounts).not.toHaveBeenCalled();
      return;
    }
    expect(source).toBeDefined();
    expect(source!.identity()).toBe('123:/synthetic/account-a.db');
    await source!.read();
    expect(nt.readQqUnreadCounts).toHaveBeenLastCalledWith({
      pid: 123,
      databasePath: '/synthetic/account-a.db',
      timeoutMs: 60000,
    });
    pid = 124;
    await source!.read();
    expect(nt.clearQqUnreadCache).toHaveBeenCalledWith(123);
    source!.clear();
    expect(nt.clearQqUnreadCache).toHaveBeenLastCalledWith(124);
    pid = null;
    expect(source!.identity()).toBeNull();
    await expect(source!.read()).rejects.toThrow('不可用');
  });
});
