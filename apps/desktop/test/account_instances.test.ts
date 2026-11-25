// @vitest-environment node
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  AccountInstances,
  accountIsRunning,
  accountLaunchArgs,
  accountPickerArg,
  accountPickerDirectories,
  accountPickerOwner,
  accountPickerTarget,
  developmentStartupConfigId,
  instanceArg,
  instanceDirectories,
  instanceTarget,
  prepareAccountPicker,
  prepareInstanceAccount,
  savedInstanceAccounts,
} from '../src/main/account_instances';
import {
  accountStorageMigrationPath,
  migrateAccountStorage,
} from '../src/main/account_storage_migration';
import { DesktopStorage } from '../src/main/desktop_storage';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'weq-account-instances-'));
});
afterEach(() => rmSync(root, { force: true, recursive: true }));

it('同一主进程的另一个窗口打开时，备份恢复仍不能独占共享数据', async () => {
  const first = new DesktopStorage(root);
  const second = new DesktopStorage(root);
  try {
    await expect(first.maintain(async () => 'restored')).rejects.toThrow('其他 WeQ 窗口');
  } finally {
    second.close();
  }
  try {
    await expect(first.maintain(async () => 'restored')).resolves.toBe('restored');
  } finally {
    first.close();
  }
});

it('账号窗口开始关闭后，排队中的打开请求不能重新获得账号锁', async () => {
  const instance = new AccountInstances(root);
  try {
    const opening = instance.run(
      '101',
      async () => {},
      () => '101',
    );
    instance.stopOpening();
    await expect(opening).rejects.toThrow('账号窗口正在关闭');
    expect(accountIsRunning(root, '101')).toBe(false);
    await expect(
      instance.run(
        null,
        async () => 'closed',
        () => undefined,
      ),
    ).resolves.toBe('closed');
  } finally {
    instance.dispose();
  }
});

it('不同 Electron 实例从同一份账号配置打开数据源', () => {
  const target = { uin: '101', configId: '101_fixture' };
  const mainAccounts = join(root, 'config', 'accounts');
  const original = join(mainAccounts, '101_fixture.json');
  const algo = { pageHmacAlgorithm: 'fixture-page', kdfHmacAlgorithm: 'fixture-kdf' };
  const source = JSON.stringify({
    uin: target.uin,
    dbKey: 'fixture-key',
    algo,
    dataDir: '/fixture/101',
    session: { pid: 123 },
  });
  mkdirSync(mainAccounts, { recursive: true });
  writeFileSync(original, source);
  expect(instanceTarget(['weq', instanceArg(target)])).toEqual(target);
  expect(() => instanceTarget(['weq', '--weq-account-instance=101:../outside'])).toThrow();
  const account = prepareInstanceAccount(root, target);
  expect(account.algos['nt_msg.db']).toEqual(algo);
  expect(instanceDirectories(root, target.uin)).not.toEqual(instanceDirectories(root, '202'));
  writeFileSync(original, JSON.stringify({ ...account, displayName: '共同配置' }));
  expect(prepareInstanceAccount(root, target).displayName).toBe('共同配置');
  expect(() => prepareInstanceAccount(root, { ...target, uin: '202' })).toThrow('找不到');
});

it('不同账号可并行，关闭和打开失败只释放对应账号的锁', async () => {
  const first = new AccountInstances(root);
  const second = new AccountInstances(root);
  let active: string | undefined;
  const opened = () => active;
  await first.run(
    '101',
    async () => {
      active = '101';
    },
    opened,
  );
  const secondAccount = () => '202';
  await second.run('202', async () => {}, secondAccount);
  await expect(second.run('101', async () => {}, secondAccount)).rejects.toThrow('已在另一个');
  await expect(
    first.run(
      '303',
      async () => {
        throw new Error('打开失败');
      },
      opened,
    ),
  ).rejects.toThrow('打开失败');
  expect(accountIsRunning(root, '303')).toBe(false);
  expect(accountIsRunning(root, '101')).toBe(true);
  await first.run(
    null,
    async () => {
      active = undefined;
    },
    opened,
  );
  expect(accountIsRunning(root, '101')).toBe(false);
  expect(accountIsRunning(root, '202')).toBe(true);
  await second.run(
    null,
    async () => {},
    () => undefined,
  );
});

it('固定开发窗口自动打开空闲的默认账号，普通新窗口或账号已打开时手动选择', () => {
  const developmentPickerId = '00000000-0000-0000-0000-000000000000';
  const target = { uin: '101', configId: 'default-source' };
  expect(developmentStartupConfigId(root, prepareAccountPicker(), target)).toBeUndefined();
  expect(developmentStartupConfigId(root, developmentPickerId, null)).toBeUndefined();
  expect(developmentStartupConfigId(root, developmentPickerId, target)).toBe(target.configId);
  const existing = new AccountInstances(root);
  try {
    existing.claim(target.uin);
    expect(developmentStartupConfigId(root, developmentPickerId, target)).toBeUndefined();
  } finally {
    existing.dispose();
  }
  expect(developmentStartupConfigId(root, developmentPickerId, target)).toBe(target.configId);
});

it('迁入选择窗口独有的账号与草稿，主窗口冲突原件保留', () => {
  const first = prepareAccountPicker();
  const second = prepareAccountPicker();
  expect(first).not.toBe(second);
  const args = ['electron', 'app', accountPickerArg(first)];
  expect(accountPickerTarget(args)).toBe(first);
  expect(accountLaunchArgs(args)).toEqual(['app']);
  const { data } = accountPickerDirectories(root, first);
  const put = (base: string, name: string, payload: unknown) => {
    const path = join(base, 'config', 'accounts', name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(payload));
    return path;
  };
  put(root, '101.json', { uin: '101', dbKey: 'fixture-key', displayName: '主窗口' });
  const retained = put(data, '101.json', {
    uin: '101',
    dbKey: 'fixture-key',
    displayName: '旧窗口',
    uid: 'fixture',
    lastLoginAt: 1,
  });
  put(data, '202.json', {
    uin: '202',
    dbKey: 'fixture-key',
    session: { pid: 123 },
    lastLoginAt: 1,
  });
  put(data, '202/client-state.json', { revision: 1, values: {}, records: {}, drafts: {} });

  migrateAccountStorage(root);
  expect(savedInstanceAccounts(root)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ uin: '101', displayName: '主窗口', uid: 'fixture' }),
      expect.objectContaining({ uin: '202' }),
    ]),
  );
  expect(prepareInstanceAccount(root, { uin: '202', configId: '202' }).session).toBeUndefined();
  expect(readFileSync(join(root, 'config', 'accounts', '202/client-state.json'), 'utf8')).toContain(
    'drafts',
  );
  const receipt = readFileSync(accountStorageMigrationPath(root), 'utf8');
  expect(JSON.parse(receipt).differences).toEqual([
    expect.objectContaining({ configId: '101', source: retained }),
  ]);
  migrateAccountStorage(root);
  expect(readFileSync(accountStorageMigrationPath(root), 'utf8')).toBe(receipt);
  expect(readFileSync(retained, 'utf8')).toContain('旧窗口');
});

it('另一个实例读取同一存储时拒绝恢复，关闭后可以恢复', async () => {
  const first = new DesktopStorage(root);
  const second = new DesktopStorage(root);
  try {
    await expect(first.maintain(async () => true)).rejects.toThrow('其他 WeQ 窗口');
  } finally {
    second.close();
  }
  try {
    await expect(first.maintain(async () => true)).resolves.toBe(true);
  } finally {
    first.close();
  }
});

it('切换到在账号选择窗口中打开的账号时可找到实际持有窗口', async () => {
  const id = prepareAccountPicker();
  const picker = new AccountInstances(root, undefined, id);
  await picker.run(
    '101',
    async () => {},
    () => '101',
  );
  expect(accountPickerOwner(root, '101')).toBe(id);
  await picker.run(
    null,
    async () => {},
    () => undefined,
  );
  expect(accountPickerOwner(root, '101')).toBeUndefined();
  await new AccountInstances(root).run(
    '101',
    async () => expect(accountPickerOwner(root, '101')).toBeUndefined(),
    () => undefined,
  );
});

it('账号锁跨进程生效，持锁进程异常退出后可重新打开', async () => {
  const { data } = instanceDirectories(root, '101');
  const directory = dirname(data);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'owner.sqlite');
  const run = `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1]);
    db.exec('BEGIN IMMEDIATE');
  `;
  const child = spawn(
    process.execPath,
    [
      '-e',
      `${run}
    process.stdout.write('ready');
    setInterval(() => {}, 1000);
  `,
      path,
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const closed = once(child, 'close');
  try {
    await Promise.race([
      once(child.stdout, 'data'),
      closed.then(() => {
        throw new Error('持锁进程提前退出');
      }),
    ]);
    expect(accountIsRunning(root, '101')).toBe(true);
    expect(() => new AccountInstances(root).claim('101')).toThrow('已在另一个');
  } finally {
    child.kill('SIGKILL');
    await closed;
  }
  expect(accountIsRunning(root, '101')).toBe(false);
  expect(spawnSync(process.execPath, ['-e', run, path]).status).toBe(0);
});
