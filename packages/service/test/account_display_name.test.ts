import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { AccountSession } from '@weq/account';
import { AccountConfigService } from '../src/account/user_config';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'weq-display-name-'));
  roots.push(root);
  const read = vi.fn<AccountSession['profileInfo']['getProfileByUin']>();
  const create = (uin: string, dataDir: string) => {
    const service = new AccountConfigService(
      {
        context: { uin, dbKey: 'fixture', algos: {} },
        profileInfo: { getProfileByUin: read },
      } as unknown as AccountSession,
      root,
    );
    service.save({ dataDir, displayName: '旧昵称' });
    return service;
  };
  const profile = (uin: bigint, nick: string) =>
    ({ uin, nick }) as NonNullable<Awaited<ReturnType<typeof read>>>;
  return { read, create, profile };
}

it('重新打开账号后用当前资料刷新保存的旧昵称', async () => {
  const { read, create, profile } = fixture();
  const service = create('10001', '/fixture/live');
  read.mockResolvedValue(profile(10001n, '新昵称'));
  await service.refreshDisplayName();
  expect(read).toHaveBeenCalledWith(10001n);
  expect(service.getRecord()?.displayName).toBe('新昵称');
  expect(service.getRecord()?.dbKey).toBe('fixture');
});

it('只更新当前数据源，不修改其它账号或同号备份', async () => {
  const { read, create, profile } = fixture();
  const live = create('10001', '/fixture/live');
  const backup = create('10001', '/fixture/backup');
  const other = create('20002', '/fixture/other');
  read.mockResolvedValue(profile(10001n, '备份昵称'));
  await backup.refreshDisplayName();
  expect(backup.getRecord()?.displayName).toBe('备份昵称');
  expect(live.getRecord()?.displayName).toBe('旧昵称');
  expect(other.getRecord()?.displayName).toBe('旧昵称');
});

it('资料缺失、昵称为空、身份不符或读取失败时保留旧昵称', async () => {
  const { read, create, profile } = fixture();
  const service = create('10001', '/fixture/live');
  for (const value of [null, profile(10001n, ''), profile(20002n, '其它账号')]) {
    read.mockResolvedValue(value);
    await service.refreshDisplayName();
    expect(service.getRecord()?.displayName).toBe('旧昵称');
  }
  read.mockRejectedValue(new Error('fixture read failure'));
  await expect(service.refreshDisplayName()).resolves.toBeUndefined();
  expect(service.getRecord()?.displayName).toBe('旧昵称');
});

it('刷新期间更换配置落点时丢弃旧来源的昵称', async () => {
  const { read, create, profile } = fixture();
  const service = create('10001', '/fixture/live');
  let finish!: (value: ReturnType<typeof profile>) => void;
  read.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
  const refresh = service.refreshDisplayName();
  service.save({ dataDir: '/fixture/backup', displayName: '备份昵称' });
  finish(profile(10001n, '在线昵称'));
  await refresh;
  expect(service.getRecord()?.displayName).toBe('备份昵称');
});
