// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AccountConfig, UserConfigService } from '@weq/service';
import { accountConfigId } from '@weq/service';
import type { Platform } from '@weq/platform';

const f = vi.hoisted(() => ({ probe: vi.fn(), loginDbPaths: vi.fn(() => [] as string[]) }));
vi.mock('../src/main/backup_probe', () => ({ runBackupProbe: f.probe }));
vi.mock('@weq/service', async (original) => ({
  ...(await original<typeof import('@weq/service')>()),
  loginDbPaths: f.loginDbPaths,
}));

import { migrateStaticAccountIdentity } from '../src/main/static_account_identity_migration';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
beforeEach(() => {
  vi.clearAllMocks();
  f.loginDbPaths.mockReturnValue([]);
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'weq-identity-migration-'));
  roots.push(root);
  return root;
}

/** 只记录被改写的调用，避免依赖真实的 UserConfigService 文件布局。 */
function fakeConfig(records: AccountConfig[]) {
  const renamed: Array<{ oldId: string; patch: { uin: string; configId: string; uid?: string } }> =
    [];
  const service = {
    listAccountConfigs: () => records,
    renameAccountConfigId: (
      oldId: string,
      patch: { uin: string; configId: string; uid?: string },
    ) => {
      renamed.push({ oldId, patch });
      return patch.configId;
    },
  } as unknown as UserConfigService;
  return { service, renamed };
}

const platform = {} as unknown as Platform;

function record(patch: Partial<AccountConfig> = {}): AccountConfig {
  // 迁移会先查目录是否存在；默认给一个真实存在的路径，避免所有用例都被跳过。
  const dir = (patch.dataDir as string | undefined) ?? join(fixture(), 'backup');
  mkdirSync(dir, { recursive: true });
  return {
    uin: '11111',
    configId: '11111_abc',
    dbKey: 'key',
    algos: {},
    lastLoginAt: 0,
    static: true,
    ...patch,
    dataDir: dir,
  };
}

it('探测出的权威 uin 与记录不一致时改写配置 id 并带上权威 uid', async () => {
  f.probe.mockResolvedValue({ status: 'ready', preview: { uin: '22222', uid: 'u_real' } });
  const rec = record();
  const { service, renamed } = fakeConfig([rec]);
  const result = await migrateStaticAccountIdentity(platform, service);

  expect(result.corrected).toEqual([
    {
      from: '11111_abc',
      to: accountConfigId('22222', rec.dataDir),
      oldUin: '11111',
      newUin: '22222',
    },
  ]);
  expect(renamed[0]?.patch).toMatchObject({ uin: '22222', uid: 'u_real' });
});

it('uin 一致时不做任何改写', async () => {
  f.probe.mockResolvedValue({ status: 'ready', preview: { uin: '11111', uid: 'u_x' } });
  const { service, renamed } = fakeConfig([record()]);
  const result = await migrateStaticAccountIdentity(platform, service);

  expect(result.corrected).toHaveLength(0);
  expect(renamed).toHaveLength(0);
});

it('需要密钥或探测失败时保持记录原样，不在证据不足时改写', async () => {
  const { service, renamed } = fakeConfig([record({ uin: '11111' })]);
  f.probe.mockResolvedValueOnce({ status: 'needKey' });
  await migrateStaticAccountIdentity(platform, service);
  f.probe.mockResolvedValueOnce({ status: 'error', error: '损坏' });
  await migrateStaticAccountIdentity(platform, service);

  expect(renamed).toHaveLength(0);
});

it('在线账号与目录已不存在的记录都跳过', async () => {
  // 目录确实不存在：迁移不该为它去解库。
  const missing = records_withMissingDir();
  const { service, renamed } = fakeConfig(missing);
  const result = await migrateStaticAccountIdentity(platform, service);

  expect(result.checked).toBe(0);
  expect(f.probe).not.toHaveBeenCalled();
  expect(renamed).toHaveLength(0);
});

/** 一条在线账号 + 一条 dataDir 指向不存在目录的静态账号。 */
function records_withMissingDir(): AccountConfig[] {
  return [
    { ...record(), static: false },
    { ...record(), dataDir: join(fixture(), 'nope', 'never-created') },
  ];
}

it('探测抛错只跳过该账号，不影响其它账号', async () => {
  const { service, renamed } = fakeConfig([record()]);
  f.probe.mockRejectedValueOnce(new Error('native 崩溃'));
  await expect(migrateStaticAccountIdentity(platform, service)).resolves.toMatchObject({
    corrected: [],
  });
  expect(renamed).toHaveLength(0);
});

it('真实目录缺失时不会被当成候选去探测', async () => {
  const root = fixture();
  const dir = join(root, 'backup');
  mkdirSync(dir, { recursive: true });
  f.probe.mockResolvedValue({ status: 'ready', preview: { uin: '22222', uid: 'u_real' } });
  const { service } = fakeConfig([record({ dataDir: dir })]);
  const result = await migrateStaticAccountIdentity(platform, service);
  expect(result.checked).toBe(1);
  expect(f.probe).toHaveBeenCalledOnce();
});

it('写入的账号记录能被重新读出（端到端走真实 UserConfigService）', async () => {
  // 这条用真实服务确认 renameAccountConfigId 与迁移意图能对接上。
  const root = fixture();
  const dir = join(root, 'backup');
  mkdirSync(dir, { recursive: true });
  const oldId = accountConfigId('11111', dir);
  mkdirSync(join(root, 'config', 'accounts'), { recursive: true });
  writeFileSync(
    join(root, 'config', 'accounts', `${oldId}.json`),
    JSON.stringify({ ...record({ configId: oldId, dataDir: dir }), uin: '11111' }, null, 2),
  );
  const { UserConfigService } = await import('@weq/service');
  const service = new UserConfigService({ appDataRoot: () => root });
  f.probe.mockResolvedValue({ status: 'ready', preview: { uin: '22222', uid: 'u_real' } });

  const result = await migrateStaticAccountIdentity(platform, service);
  expect(result.corrected).toHaveLength(1);

  const files = readdirSync(join(root, 'config', 'accounts')).filter((n) => n.endsWith('.json'));
  expect(files).toEqual([`${accountConfigId('22222', dir)}.json`]);
  const saved = JSON.parse(readFileSync(join(root, 'config', 'accounts', files[0]!), 'utf-8'));
  expect(saved).toMatchObject({ uin: '22222', uid: 'u_real' });
});
