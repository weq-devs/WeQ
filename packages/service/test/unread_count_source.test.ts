import type { AccountSession } from '@weq/account';
import type { QqUnreadSnapshot } from '@weq/native';
import { afterEach, expect, it, vi, describe } from 'vitest';
import { UnreadInfoService } from '../src/account/unread_info';
import { createQqUnreadCountSource, QQ_UNREAD_COVERAGE } from '../src/account/unread_count_source';

const MAC_ARM_LAYOUT = 'qqnt-macos-arm64-7.0.3-54395';
const WINDOWS_LAYOUT = 'qqnt-windows-x64-9.9.37-54395';

function memory(unreadCount = 10): QqUnreadSnapshot {
  return {
    success: true,
    code: 'ok',
    message: '',
    rows: [{ chatType: 2, uid: '70001', unreadCount }],
    missingTargets: [],
    generation: 'source',
    coverage: QQ_UNREAD_COVERAGE,
    layout: MAC_ARM_LAYOUT,
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
it('已删除目录复用现有最新水位计算未读，不改写共享快照或扫描消息历史', async () => {
  const row = { chatType: 2, uid: '70001', peer: '2_70001', msgSeq: 90, latestSeq: null };
  const read = vi.fn(async () => [row]);
  const service = new UnreadInfoService({
    unreadInfo: { getAllUnreadInfos: read },
  } as unknown as AccountSession);
  expect(await service.directoryUnreadCount(2, row.uid, '100')).toBe(10);
  expect((await service.getUnreadInfos([row]))[0]?.unreadCount).toBe(0);
  expect(read).toHaveBeenCalledOnce();
  await service.dispose();
});
describe('原生诊断适配器', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('旧原生产物不启用读取链路', () => {
    expect(createQqUnreadCountSource({}, '/synthetic/unread.db', () => 1)).toBeUndefined();
  });

  it.each([
    ['darwin', 'arm64', MAC_ARM_LAYOUT],
    ['win32', 'x64', WINDOWS_LAYOUT],
    ['darwin', 'x64', 'qqnt-macos-x64-7.0.1-52892'],
    ['linux', 'x64', 'qqnt-linux-x64-3.2.35-54395'],
    ['linux', 'arm64', 'qqnt-linux-arm64-3.2.35-54395'],
  ])('%s/%s 按固定账号路径读取并只清理自己用过的 PID', async (platform, arch, layout) => {
    vi.stubGlobal('process', { ...process, platform, arch });
    let pid: number | null = 123;
    const nt = {
      getQqUnreadCapability: () => ({
        supported: true,
        readOnly: true,
        layouts: [layout],
        coverage: QQ_UNREAD_COVERAGE,
      }),
      readQqUnreadCounts: vi.fn(async () => memory()),
      clearQqUnreadCache: vi.fn(() => 1),
    };
    const source = createQqUnreadCountSource(nt, '/synthetic/account-a.db', () => pid);
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

  it('Windows 旧产物、非只读或覆盖声明不匹配时不启用，能力查询本身不读取内存', () => {
    vi.stubGlobal('process', { ...process, platform: 'win32', arch: 'x64' });
    for (const change of [
      { supported: false },
      { readOnly: false },
      { coverage: 'all' },
      { layouts: [] },
    ]) {
      const readQqUnreadCounts = vi.fn(async () => memory());
      expect(
        createQqUnreadCountSource(
          {
            getQqUnreadCapability: () => ({
              supported: true,
              readOnly: true,
              layouts: [WINDOWS_LAYOUT],
              coverage: QQ_UNREAD_COVERAGE,
              ...change,
            }),
            readQqUnreadCounts,
            clearQqUnreadCache: () => 0,
          },
          '/synthetic/account.db',
          () => 1,
        ),
      ).toBeUndefined();
      expect(readQqUnreadCounts).not.toHaveBeenCalled();
    }
  });
});
