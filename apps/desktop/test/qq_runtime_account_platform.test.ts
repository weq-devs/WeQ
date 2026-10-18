// @vitest-environment node
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDarwinPlatform, type Platform } from '@weq/platform';
import {
  managedAccountPlatform,
  type ManagedQQAccountSource,
} from '../src/main/qq_runtime/managed_account';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'weq-owned-platform-')));
  dirs.push(root);
  const dbPath = join(root, 'nt_db', 'nt_msg.db');
  await mkdir(join(root, 'nt_db'));
  await writeFile(dbPath, 'fixture');
  const controller = new AbortController();
  const source: ManagedQQAccountSource = {
    instanceId: 'instance-a',
    pid: 123,
    uin: '10001',
    uid: 'u_self',
    guid: 'ab'.repeat(16),
    dataRoot: root,
    dbPath,
    dbKey: 'FixtureKey123456',
    algo: { pageHmacAlgorithm: 'fixture', kdfHmacAlgorithm: 'fixture' },
    wrapperPath: '/fixture/wrapper.node',
    majorPath: '/fixture/major.node',
    version: 'fixture',
    signal: controller.signal,
    isSsoReady: () => true,
  };
  const base: Platform = {
    ...createDarwinPlatform({ ntHelper: {} } as Platform['native']),
    resolveQqPid: () => 900,
    resolveQqPidAsync: async () => 900,
    isQqLoggedIn: () => true,
    ntMsgDbPath: () => '/external/nt_msg.db',
    picDir: () => '/external/Pic',
  };
  let current: ManagedQQAccountSource | null = source;
  const platform = managedAccountPlatform(base, source, () => current);
  return {
    root,
    source,
    controller,
    platform,
    set: (value: ManagedQQAccountSource | null) => {
      current = value;
    },
  };
}
describe('托管账号平台绑定', () => {
  it('本账号使用明确的托管数据与 PID，其他账号保持外部 QQ 检测', async () => {
    const f = await fixture();
    expect(f.platform.ntMsgDbPath('10001')).toBe(f.source.dbPath);
    expect(f.platform.resolveQqPid('10001')).toBe(f.source.pid);
    expect(await f.platform.resolveQqPidAsync?.('10001')).toBe(f.source.pid);
    expect(f.platform.ntMsgDbPath('10002')).toBe('/external/nt_msg.db');
    expect(f.platform.resolveQqPid('10002')).toBe(900);
    expect(f.platform.picDir('10001')).toBeNull();
  });
  it('停止后仍可读历史，但不把外部同号进程当作本数据源在线', async () => {
    const f = await fixture();
    f.controller.abort();
    expect(f.platform.ntMsgDbPath('10001')).toBe(f.source.dbPath);
    expect(f.platform.resolveQqPid('10001')).toBeNull();
    expect(f.platform.isQqLoggedIn('10001')).toBe(false);
    expect(f.platform.qqWrapperNodePath(f.source.pid)).toBe(f.source.wrapperPath);
  });
  it('同数据源恢复后更新真实 PID，切到其他数据源不会串用', async () => {
    const f = await fixture();
    f.set({ ...f.source, pid: 124 });
    expect(f.platform.resolveQqPid('10001')).toBe(124);
    f.set({ ...f.source, dbPath: '/other/nt_msg.db' });
    expect(f.platform.resolveQqPid('10001')).toBeNull();
    expect(f.platform.ntMsgDbPath('10001')).toBe(f.source.dbPath);
  });
});
