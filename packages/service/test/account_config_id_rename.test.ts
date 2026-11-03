import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { UserConfigService, accountConfigId } from '@weq/service';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'weq-rename-config-'));
  roots.push(root);
  const service = new UserConfigService({ appDataRoot: () => root });
  return { root, service };
}

/** 写一条静态账号记录（旧版：uin 是从资料库猜的）。 */
function writeRecord(
  root: string,
  record: { configId: string; uin: string; dataDir: string; dbKey?: string },
) {
  const dir = join(root, 'config', 'accounts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${record.configId}.json`),
    JSON.stringify({ ...record, algos: {}, lastLoginAt: 1, lastLoginAt2: undefined }, null, 2),
  );
  return join(dir, `${record.configId}.json`);
}

it('uin 被纠正时改写账号记录，并把 configId 派生的缓存目录一起搬走', () => {
  const { root, service } = fixture();
  const dataDir = join(root, 'backup');
  const oldId = accountConfigId('11111', dataDir);
  const newId = accountConfigId('22222', dataDir);
  writeRecord(root, { configId: oldId, uin: '11111', dataDir, dbKey: 'key' });

  // 旧 id 下按账号隔离的数据。
  for (const kind of ['deleted', 'anti_recall', 'export']) {
    mkdirSync(join(root, 'cache', kind, oldId), { recursive: true });
    writeFileSync(join(root, 'cache', kind, oldId, 'marker'), kind);
  }
  // 装扮配置与账号记录同级。
  mkdirSync(join(root, 'config', 'accounts', oldId), { recursive: true });
  writeFileSync(join(root, 'config', 'accounts', oldId, 'theme.json'), '{}');

  expect(
    service.renameAccountConfigId(oldId, {
      uin: '22222',
      configId: newId,
      uid: 'u_real',
    }),
  ).toBe(newId);

  // 记录已改名且内容正确。
  const next = JSON.parse(readFileSync(join(root, 'config', 'accounts', `${newId}.json`), 'utf-8'));
  expect(next).toMatchObject({ uin: '22222', configId: newId, uid: 'u_real', dbKey: 'key' });
  expect(existsSync(join(root, 'config', 'accounts', `${oldId}.json`))).toBe(false);

  // 目录已搬迁，旧位置清空。
  for (const kind of ['deleted', 'anti_recall', 'export']) {
    expect(readFileSync(join(root, 'cache', kind, newId, 'marker'), 'utf-8')).toBe(kind);
    expect(existsSync(join(root, 'cache', kind, oldId))).toBe(false);
  }
  expect(existsSync(join(root, 'config', 'accounts', newId, 'theme.json'))).toBe(true);
});

it('目标 configId 已存在时不覆盖，避免冲掉用户重新扫描出来的那份', () => {
  const { root, service } = fixture();
  const dataDir = join(root, 'backup');
  const oldId = accountConfigId('11111', dataDir);
  const newId = accountConfigId('22222', dataDir);
  writeRecord(root, { configId: oldId, uin: '11111', dataDir });
  writeRecord(root, { configId: newId, uin: '22222', dataDir });

  expect(service.renameAccountConfigId(oldId, { uin: '22222', configId: newId })).toBeNull();
  expect(existsSync(join(root, 'config', 'accounts', `${oldId}.json`))).toBe(true);
});

it('自动进入目标还指着旧 id 时一并改写', () => {
  const { root, service } = fixture();
  const dataDir = join(root, 'backup');
  const oldId = accountConfigId('11111', dataDir);
  const newId = accountConfigId('22222', dataDir);
  writeRecord(root, { configId: oldId, uin: '11111', dataDir });
  service.setAutoEnter({ configId: oldId, uin: '11111', dataDir });

  service.renameAccountConfigId(oldId, { uin: '22222', configId: newId });

  expect(service.getAutoEnter()).toMatchObject({ configId: newId, uin: '22222' });
});

it('新旧 id 相同时什么也不做', () => {
  const { root, service } = fixture();
  const dataDir = join(root, 'backup');
  const id = accountConfigId('11111', dataDir);
  writeRecord(root, { configId: id, uin: '11111', dataDir });

  expect(service.renameAccountConfigId(id, { uin: '11111', configId: id })).toBeNull();
});
